/**
 * A hook that does not read its stdin.
 *
 * Which is most of them: a hook is usually a line of shell that looks at the environment or just
 * exits, and the JSON offered on stdin goes unread. That is allowed, and it used to take the app
 * down — not the hook, the whole main process.
 *
 * The mechanism is worth stating because nothing in the stack trace pointed here. `runHook` writes
 * the payload with `child.stdin.end(...)`. If the child never reads and the payload is larger than
 * the pipe buffer, the write cannot complete; when the child exits, the write fails with `EPIPE`.
 * A stream's `error` event with no listener is rethrown, asynchronously, from inside
 * `WriteWrap.onWriteComplete` — so what the user saw was Electron's modal
 * "A JavaScript error occurred in the main process", with a stack ending in `node:internal`.
 *
 * The size matters: a small payload fits in the buffer and is written before anyone notices, which
 * is why this only ever happened on some tool calls and not others. It has to clear the 64KB pipe
 * buffer, but it also cannot go past 128KB — the same arguments are written to the `DW_ARGS`
 * environment variable, and Linux refuses an exec whose single argument exceeds `MAX_ARG_STRLEN`
 * (128KB) with `E2BIG` before the child even starts, which would test the wrong thing.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "../src/runtime/hooks.ts";

/** Comfortably past the 64KB pipe buffer, inside Linux's 128KB per-argument exec limit. */
const BIG = "x".repeat(80_000);

test("a hook that ignores stdin does not take the process down with it", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ly-hook-"));

	/*
	 * Caught here rather than trusted to the assertion below.
	 *
	 * The failure is an unhandled `error` on a stream, which arrives as an uncaught exception on a
	 * later tick — `runHook` has already resolved by then, so without this the test would pass and
	 * the runner would die immediately afterwards.
	 */
	const escaped: Error[] = [];
	const onUncaught = (error: Error) => escaped.push(error);
	process.on("uncaughtException", onUncaught);

	try {
		// Exits at once and never reads stdin. `true` is the smallest honest version of that.
		const result = await runHook({ event: "before-tool", command: "true", blocking: false }, cwd, {
			event: "before-tool",
			toolName: "write",
			args: { content: BIG },
		});

		assert.equal(result.exitCode, 0, "the hook ran and its exit code was collected");
		assert.equal(result.spawnError, undefined, "and it was not reported as a broken hook");

		// Let anything thrown from the write's completion callback land before checking.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.deepEqual(
			escaped.map((error) => (error as NodeJS.ErrnoException).code ?? error.message),
			[],
			"nothing reached the top of the process",
		);
	} finally {
		process.off("uncaughtException", onUncaught);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a hook that does read stdin still gets the payload", async () => {
	/*
	 * The guard must not turn into "stop sending the payload". A hook that reads it is the reason
	 * it is written at all, and that path has to keep working.
	 */
	const cwd = await mkdtemp(join(tmpdir(), "ly-hook-"));
	try {
		const result = await runHook(
			// Reads stdin and fails if the tool name is not in it, so the assertion is the exit code.
			{ event: "before-tool", command: "grep -q needle-tool", blocking: false },
			cwd,
			{ event: "before-tool", toolName: "needle-tool", args: {} },
		);
		assert.equal(result.exitCode, 0, "the hook found what it was sent on stdin");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
