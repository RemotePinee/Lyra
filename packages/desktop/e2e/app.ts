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
import { createServer } from "node:net";
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
	/**
	 * One DevTools protocol call, for the things the page cannot do to itself.
	 *
	 * Resizing is the case this exists for. `window.resizeTo` is ignored for an ordinary Electron
	 * window, and the layout's breakpoints are driven by `window.innerWidth` — so without
	 * `Emulation.setDeviceMetricsOverride` the narrow layout is simply not reachable from a test,
	 * which would leave the half of the dock that only exists below 760px unverified.
	 */
	send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
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
	/*
	 * Refuse to start while something is already on this port.
	 *
	 * This is not tidiness, it is the difference between a test and a lie. The debugger port is how
	 * everything here reaches the app; a leftover instance from an earlier run holds it, the new
	 * Electron fails to bind — it says so on stderr and carries on running — and every probe then
	 * drives *the old process*, with the old code and the old profile directory. Green results,
	 * about a build that no longer exists. That happened, and it is why a set of fixes that passed
	 * here was broken the moment it was installed.
	 */
	await new Promise<void>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", (error: NodeJS.ErrnoException) => {
			reject(
				new Error(
					error.code === "EADDRINUSE"
						? `调试端口 ${port} 已被占用——多半是上一次没退干净的实例。跑之前先清掉：\n` +
							`  pkill -f "node_modules/.pnpm/electron@.*--remote-debugging-port"\n` +
							`  pkill -f "electron-vite.js preview"`
						: `无法确认调试端口 ${port} 是否空闲：${error.message}`,
				),
			);
		});
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
	});

	// A profile of its own: this must not read, or write to, whatever is on the machine already.
	const home = await mkdtemp(join(tmpdir(), "lyra-e2e-"));
	await seed?.(home);

	/** Kept so a failure to start can show what the app said on its way down. */
	const output: string[] = [];

	/*
	 * The built bundle when `LYRA_E2E_APP` names one, and the dev preview otherwise.
	 *
	 * They are not the same program in the ways that have bitten hardest. A packaged build runs out
	 * of an asar, resolves `app.getAppPath()` somewhere else entirely, and has whatever
	 * `electron-builder.yml` decided to include rather than the whole source tree — which is how a
	 * dock icon can be found in development and missing in the app people install. Testing the
	 * thing that ships is the only way to see that class of fault.
	 */
	const bundle = process.env.LYRA_E2E_APP;
	const packageManagerScript = process.env.npm_execpath;
	const executable = bundle
		? join(bundle, "Contents", "MacOS", "Lyra")
		: packageManagerScript
			? process.execPath
			: "pnpm";
	const argv = bundle
		? [`--remote-debugging-port=${port}`]
		: [
			...(packageManagerScript ? [packageManagerScript] : []),
			"exec",
			"electron-vite",
			"preview",
			"--",
			`--remote-debugging-port=${port}`,
		];

	/*
	 * Its own process group.
	 *
	 * `electron-vite preview` spawns Electron as a child, so killing the one we started leaves the
	 * window running and the test runner waiting on a handle that never closes — which shows up as
	 * a suite that passes and then hangs for ten minutes.
	 */
	const app: ChildProcess = spawn(executable, argv, {
		cwd: ROOT,
		env: { ...process.env, LYRA_HOME: home, ELECTRON_ENABLE_LOGGING: "1" },
		stdio: "pipe",
		detached: true,
	});
	const record = (chunk: Buffer) => {
		output.push(chunk.toString());
		if (process.env.DEBUG_E2E) process.stdout.write(chunk);
	};
	app.stdout?.on("data", record);
	app.stderr?.on("data", record);
	app.on("error", (error) => output.push(`spawn failed: ${error.message}`));

	const target = await waitForWindow(port, output);
	const evaluate = <T>(expression: string) =>
		call<T>(target, "Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		}).then((result) => {
			const answer = result as { exceptionDetails?: { text: string }; result?: { value: T } };
			if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text);
			return answer.result?.value as T;
		});
	await waitForShell(evaluate);

	return {
		home,
		evaluate,
		send: <T>(method: string, params?: Record<string, unknown>) => call<T>(target, method, params ?? {}),
		stop: async () => {
			if (app.pid) {
				if (process.platform === "win32") {
					await new Promise<void>((resolve) => {
						const killer = spawn("taskkill.exe", ["/pid", String(app.pid), "/t", "/f"], {
							windowsHide: true,
						});
						killer.once("error", () => resolve());
						killer.once("close", () => resolve());
					});
				} else {
					try {
						process.kill(-app.pid, "SIGTERM");
					} catch {
						app.kill("SIGKILL");
					}
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
			.then((r) => r.json() as Promise<{ title: string; type: string; url: string; webSocketDebuggerUrl?: string }[]>)
			.catch(() => null);
		const page = targets?.find(
			(t) => t.type === "page" && !t.url.includes("screenshot-overlay") && t.webSocketDebuggerUrl,
		);
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
			`({ shell: Boolean(document.querySelector("textarea")) && !document.querySelector("[aria-busy]"), body: document.body.innerText.slice(0, 120) })`,
		).catch(() => null);
		if (state?.shell) return;
		last = state?.body ?? "(no answer from the renderer)";
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`the shell never rendered. What was on screen:\n${last}`);
}

/** One call, one socket. Slower than keeping it open, and far easier to reason about. */
async function call<T>(target: string, method: string, params: Record<string, unknown>): Promise<T> {
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
				if (message.error) reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result as T);
			});
			// Generous, because a test that waits out a toast's lifetime is one expression that
			// deliberately takes ten seconds — and a timeout shorter than that would call it a
			// failure rather than a wait.
			setTimeout(() => reject(new Error(`${method} timed out`)), 40_000);
		});
		socket.send(JSON.stringify({ id: 1, method, params }));
		return await answer;
	} finally {
		socket.close();
	}
}
