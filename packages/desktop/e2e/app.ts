/**
 * Starting the real app, and talking to the window it opens.
 *
 * Driven over the DevTools protocol rather than through a test framework: Electron already speaks
 * it, so this needs no driver, no browser download and no second way of describing a click.
 *
 * Shared by every end-to-end test, because "boot it and wait for the shell" has three failure
 * modes that each took a while to work out — a preview server that outlives the process you
 * killed, a window that exists before React has mounted into it, and a start that fails with no
 * explanation unless you kept what the app printed. Solving those once is the point of this file.
 *
 * One app at a time: `test:e2e` passes `--test-concurrency=1`. Each file here starts a real
 * Electron process, and three of them competing for a laptop produced timing failures in tests
 * that measure layout — which is the worst kind of red, since the code under test was fine.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const BOOT_TIMEOUT_MS = 90_000;

export interface RunningApp {
	/** The profile directory the app was given, so a test can seed or inspect it. */
	home: string;
	/** One expression in the renderer. Promises are awaited; the value comes back by value. */
	evaluate<T>(expression: string): Promise<T>;
	stop(): Promise<void>;
}

/**
 * Boot the app on a profile of its own and wait until its shell has painted.
 *
 * `seed` runs after the profile directory is made and before the app starts, which is the only
 * window in which settings can be written for it to read at launch.
 */
export async function startApp({
	port,
	seed,
}: {
	/** A port per test file: two suites running at once must not share a debugger. */
	port: number;
	seed?: (home: string) => Promise<void>;
}): Promise<RunningApp> {
	// A profile of its own: this must not read, or write to, whatever is on the machine already.
	const home = await mkdtemp(join(tmpdir(), "lyra-e2e-"));
	await seed?.(home);

	/** Kept so a failure to start can show what the app said on its way down. */
	const output: string[] = [];

	/*
	 * Its own process group.
	 *
	 * `electron-vite preview` spawns Electron as a child, so killing the one we started leaves the
	 * window running and the test runner waiting on a handle that never closes — which shows up as
	 * a suite that passes and then hangs for ten minutes.
	 */
	const app: ChildProcess = spawn(
		"pnpm",
		["exec", "electron-vite", "preview", "--", `--remote-debugging-port=${port}`],
		{
			cwd: ROOT,
			env: { ...process.env, LYRA_HOME: home, ELECTRON_ENABLE_LOGGING: "1" },
			stdio: "pipe",
			detached: true,
		},
	);
	const record = (chunk: Buffer) => {
		output.push(chunk.toString());
		if (process.env.DEBUG_E2E) process.stdout.write(chunk);
	};
	app.stdout?.on("data", record);
	app.stderr?.on("data", record);
	app.on("error", (error) => output.push(`spawn failed: ${error.message}`));

	const target = await waitForWindow(port, output);
	const evaluate = <T>(expression: string) => evaluateOn<T>(target, expression);
	await waitForShell(evaluate);

	return {
		home,
		evaluate,
		stop: async () => {
			if (app.pid) {
				try {
					process.kill(-app.pid, "SIGTERM");
				} catch {
					app.kill("SIGKILL");
				}
			}
			await rm(home, { recursive: true, force: true }).catch(() => {});
		},
	};
}

async function waitForWindow(port: number, output: string[]): Promise<string> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
			.then((r) => r.json() as Promise<{ title: string; type: string; webSocketDebuggerUrl?: string }[]>)
			.catch(() => null);
		const page = targets?.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		await new Promise((r) => setTimeout(r, 500));
	}
	/*
	 * What it printed, not just that it never appeared.
	 *
	 * The first CI run of this failed with "no window after 90s" and nothing else, which says
	 * only that something went wrong somewhere — the app's own output is the whole diagnosis.
	 */
	throw new Error(
		`no window after ${BOOT_TIMEOUT_MS / 1000}s. What the app printed:\n${output.join("").slice(-4000) || "(nothing)"}`,
	);
}

/**
 * The window exists well before React has mounted into it.
 *
 * Asserting straight after the target appears tests how fast the machine is, not whether the app
 * works — so this waits for the shell to be there, and says what it did see if it never arrives.
 */
async function waitForShell(evaluate: <T>(expression: string) => Promise<T>): Promise<void> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let last = "";
	while (Date.now() < deadline) {
		const state = await evaluate<{ shell: boolean; body: string }>(
			`({ shell: Boolean(document.querySelector(".ly-shell")), body: document.body.innerText.slice(0, 120) })`,
		).catch(() => null);
		if (state?.shell) return;
		last = state?.body ?? "(no answer from the renderer)";
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`the shell never rendered. What was on screen:\n${last}`);
}

/** One expression, one socket. Slower than keeping it open, and far easier to reason about. */
async function evaluateOn<T>(target: string, expression: string): Promise<T> {
	const socket = new WebSocket(target);
	try {
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const answer = new Promise<T>((resolve, reject) => {
			socket.addEventListener("message", (event) => {
				const message = JSON.parse(String(event.data));
				if (message.id !== 1) return;
				if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
				else resolve(message.result?.result?.value as T);
			});
			// Generous, because a test that waits out a toast's lifetime is one expression that
			// deliberately takes ten seconds — and a timeout shorter than that would call it a
			// failure rather than a wait.
			setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 60)}`)), 40_000);
		});
		socket.send(
			JSON.stringify({
				id: 1,
				method: "Runtime.evaluate",
				params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
			}),
		);
		return await answer;
	} finally {
		socket.close();
	}
}
