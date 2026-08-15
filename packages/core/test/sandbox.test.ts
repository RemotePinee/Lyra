/**
 * The sandbox seam.
 *
 * The claim being tested is the one that makes it a seam at all: swapping the implementation
 * changes where commands run, without the tool that runs them being touched.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, SANDBOX, type Sandbox, type SandboxProcess } from "../src/kernel/index.ts";
import { getSandbox, useSandbox } from "../src/sandbox/index.ts";
import { bashTool } from "../src/tools/bash.ts";
import type { ToolContext } from "../src/types.ts";

function context(cwd: string): ToolContext {
	return { cwd, state: new Map() } as unknown as ToolContext;
}

/** Answers every command the same way, without starting anything. */
class StubSandbox implements Sandbox {
	readonly seen: string[] = [];

	run(command: string): SandboxProcess {
		this.seen.push(command);
		const exits: ((code: number | null) => void)[] = [];
		const outputs: ((chunk: string) => void)[] = [];
		// Deferred a tick so the caller has finished subscribing, as a real process would be.
		setTimeout(() => {
			for (const listener of outputs) listener("from the stub\n");
			for (const listener of exits) listener(0);
		}, 0);
		return {
			onOutput: (listener) => outputs.push(listener),
			onExit: (listener) => exits.push(listener),
			onError: () => {},
			kill: () => {},
		};
	}
}

test("a replaced sandbox is where commands go", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-sandbox-"));
	const stub = new StubSandbox();
	useSandbox(stub);

	try {
		const result = await bashTool.execute({ command: "echo hello" }, context(root));
		assert.deepEqual(stub.seen, ["echo hello"]);
		assert.equal(result.content[0]?.type === "text" && result.content[0].text, "from the stub");
		assert.notEqual(result.isError, true);
	} finally {
		useSandbox(null);
		await rm(root, { recursive: true, force: true });
	}
});

test("with nothing bound, commands still run locally", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-sandbox-"));
	try {
		const result = await bashTool.execute({ command: "echo hello" }, context(root));
		assert.equal(result.content[0]?.type === "text" && result.content[0].text, "hello");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the default context provides a sandbox", async () => {
	const ctx = await createContext();
	try {
		assert.ok(ctx.require<Sandbox>(SANDBOX), "loaded by default");
		assert.ok(getSandbox(), "and asking without binding one still answers");
	} finally {
		await ctx.dispose();
	}
});
