/**
 * The app, actually started.
 *
 * Unit tests know whether a function returns the right thing. They cannot tell you that the main
 * process boots, that the preload exposes what the renderer expects, or that the window paints
 * something rather than a white rectangle — and those are the failures that make an app look
 * broken to the person who opened it.
 *
 * Driven over the DevTools protocol rather than through a test framework: Electron already speaks
 * it, so this needs no driver, no browser download and no second way of describing a click.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PORT = 9444;
const BOOT_TIMEOUT_MS = 90_000;

let app: ChildProcess | undefined;
let home: string;
let target: string;
/** Kept so a failure to start can show what the app said on its way down. */
const output: string[] = [];

before(async () => {
	// A profile of its own: this must not read, or write to, whatever is on the machine already.
	home = await mkdtemp(join(tmpdir(), "lyra-e2e-"));

	/*
	 * Its own process group.
	 *
	 * `electron-vite preview` spawns Electron as a child, so killing the one we started leaves the
	 * window running and the test runner waiting on a handle that never closes — which shows up as
	 * a suite that passes and then hangs for ten minutes.
	 */
	app = spawn("pnpm", ["exec", "electron-vite", "preview", "--", `--remote-debugging-port=${PORT}`], {
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

	target = await waitForWindow();
	await waitForShell();
});

after(async () => {
	if (app?.pid) {
		try {
			process.kill(-app.pid, "SIGTERM");
		} catch {
			app.kill("SIGKILL");
		}
	}
	await rm(home, { recursive: true, force: true }).catch(() => {});
});

test("the window opens and paints the shell", async () => {
	const shape = await evaluate<{ shell: boolean; sidebar: boolean; title: string }>(`({
		shell: Boolean(document.querySelector(".ly-shell")),
		sidebar: Boolean(document.querySelector(".ly-sidebar-fill")),
		title: document.title,
	})`);

	assert.equal(shape.shell, true, "the app shell rendered");
	assert.equal(shape.sidebar, true, "so did the navigation pane");
	assert.equal(shape.title, "Lyra");
});

test("the preload exposed the API the renderer is written against", async () => {
	const api = await evaluate<string[]>(`Object.keys(window.lyra ?? {}).sort()`);
	for (const area of ["agent", "files", "sessions", "settings", "workspace"]) {
		assert.ok(api.includes(area), `window.lyra.${area} is missing`);
	}
});

test("a first run lands somewhere you can act from", async () => {
	/*
	 * With a fresh profile there is no project and no conversation, so the composer may not be
	 * mounted yet — what has to be true is that the main column says something. A blank one is
	 * the failure this test exists to catch: it looks identical to a crash.
	 */
	const landing = await evaluate<{ text: number; composer: boolean }>(`(() => {
		const main = document.querySelector("main");
		return {
			text: (main?.textContent ?? "").trim().length,
			composer: Boolean(document.querySelector("main textarea")),
		};
	})()`);

	assert.ok(landing.text > 0 || landing.composer, "the main column is not blank");
});

test("the window is the size someone can use", async () => {
	// A window that opens at 0×0, or off-screen, is running and unusable at the same time.
	const size = await evaluate<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
	assert.ok(size.w >= 600, `window is ${size.w}px wide`);
	assert.ok(size.h >= 400, `window is ${size.h}px tall`);
});

// ---------------------------------------------------------------------------

async function waitForWindow(): Promise<string> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`)
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
async function waitForShell(): Promise<void> {
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
async function evaluate<T>(expression: string): Promise<T> {
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
			setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 60)}`)), 15_000);
		});
		socket.send(
			JSON.stringify({
				id: 1,
				method: "Runtime.evaluate",
				params: { expression, awaitPromise: true, returnByValue: true },
			}),
		);
		return await answer;
	} finally {
		socket.close();
	}
}
