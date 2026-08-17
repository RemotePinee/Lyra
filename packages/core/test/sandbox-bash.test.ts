/**
 * The sandbox, through the tool the model actually calls.
 *
 * Everything else about confinement is unit-testable and is tested that way. This file is the one
 * that answers the only question that matters at the end: when the agent runs a command, is the
 * write really refused? A profile that is generated correctly and never applied looks identical
 * from every other angle.
 *
 * Skipped where there is no backend, rather than failing: on a host without confinement these
 * assertions would be testing that an unconfined command can write, which is not a property worth
 * pinning down.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bashTool } from "../src/tools/bash.ts";
import { selectRunner } from "../src/sandbox/backend.ts";
import type { SandboxMode } from "../src/sandbox/policy.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

const confined = selectRunner() !== "none";
const skip = confined ? false : "this host has no sandbox backend";

function context(cwd: string, mode: SandboxMode | undefined): ToolContext {
	return { cwd, sessionId: "test", state: new Map(), sandboxMode: mode };
}

const textOf = (result: ToolResult) => result.content.map((b) => (b.type === "text" ? b.text : "")).join("");

async function run(cwd: string, mode: SandboxMode | undefined, command: string): Promise<ToolResult> {
	return (await bashTool.execute({ command }, context(cwd, mode))) as ToolResult;
}

test("workspace-write lets a command write inside the project", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-ws-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const result = await run(ws, "workspace-write", `echo hi > ${ws}/inside.txt && echo DONE`);
	assert.match(textOf(result), /DONE/);
	assert.ok(existsSync(join(ws, "inside.txt")));
});

test("workspace-write refuses a write outside the project, and nothing is created", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-ws-"));
	// Under the home directory: outside the workspace and outside the temp areas the mode grants.
	const outside = join(homedir(), ".lyra-sandbox-e2e-probe");
	t.after(async () => {
		await rm(ws, { recursive: true, force: true });
		await rm(outside, { force: true });
	});

	const result = await run(ws, "workspace-write", `echo hi > ${outside}`);
	assert.equal(existsSync(outside), false, "the file must not exist — this is the whole point");
	// And the model is told it was a policy decision rather than a broken command.
	assert.match(textOf(result), /sandbox: 文件写入被拒/);
	assert.match(textOf(result), /可以申请/);
	assert.equal((result.details as { denied?: boolean }).denied, true);
});

test("read-only refuses even inside the project", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-ro-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	await run(ws, "read-only", `echo hi > ${ws}/nope.txt`);
	assert.equal(existsSync(join(ws, "nope.txt")), false);
});

test("read-only still allows the sink a shell cannot run without", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-ro-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	// A read-only sandbox that cannot run `... 2>/dev/null` is not read-only, it is broken.
	const result = await run(ws, "read-only", "echo hi > /dev/null && echo DONE");
	assert.match(textOf(result), /DONE/);
});

test("read-only can still read", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-ro-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const result = await run(ws, "read-only", "head -c 4 /etc/passwd > /dev/null && echo DONE");
	assert.match(textOf(result), /DONE/);
});

test("danger-full-access is unconfined, and says nothing about denials", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-full-"));
	const outside = join(ws, "..", `lyra-full-${process.pid}.txt`);
	t.after(async () => {
		await rm(ws, { recursive: true, force: true });
		await rm(outside, { force: true });
	});

	const result = await run(ws, "danger-full-access", `echo hi > ${outside} && echo DONE`);
	assert.match(textOf(result), /DONE/);
	assert.ok(!textOf(result).includes("sandbox:"));
});

test("no mode means no confinement, which is how the CLI and the tests run", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-none-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const result = await run(ws, undefined, "echo DONE");
	assert.match(textOf(result), /DONE/);
});

test("a path with a quote in it does not break out of the profile", { skip }, async (t) => {
	// The escaping is unit-tested; this proves the escaped profile is one the kernel accepts.
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-q-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const weird = join(ws, 'we"ird dir');
	const result = await run(ws, "workspace-write", `mkdir -p '${weird}' && echo hi > '${weird}/f.txt' && echo DONE`);
	assert.match(textOf(result), /DONE/, textOf(result));
});

test("an ordinary failure is not dressed up as a denial", { skip }, async (t) => {
	const ws = await mkdtemp(join(tmpdir(), "lyra-sb-fail-"));
	t.after(() => rm(ws, { recursive: true, force: true }));

	const result = await run(ws, "workspace-write", "definitely-not-a-command-here");
	assert.ok(!textOf(result).includes("sandbox:"), textOf(result));
	assert.equal((result.details as { denied?: boolean }).denied, undefined);
});
