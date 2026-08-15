import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
import type { Message } from "../src/types.ts";

function toolResult(id: string): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: id }],
		isError: false,
		timestamp: Date.now(),
	};
}

test("concurrent appends get distinct, gapless sequence numbers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);

	const meta = await store.create("/tmp/project", "model");

	// Parallel tool calls all persist from the same stale snapshot. Every record must still
	// land on its own sequence number, or a client syncing with ?since=N silently loses one.
	await Promise.all([
		store.append(meta, { type: "message", message: toolResult("a") }),
		store.append(meta, { type: "message", message: toolResult("b") }),
		store.append(meta, { type: "message", message: toolResult("c") }),
	]);

	const seqs: number[] = [];
	for await (const record of store.read(meta.projectId, meta.id)) seqs.push(record.seq);

	assert.deepEqual(seqs, [1, 2, 3, 4], "sequence numbers must be unique and contiguous");

	const loaded = await store.load(meta.projectId, meta.id);
	assert.equal(loaded?.messages.length, 3);
	assert.equal(loaded?.meta.messageCount, 3);
});

test("incremental read returns every record after the given sequence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);

	const meta = await store.create("/tmp/project", "model");
	await Promise.all([
		store.append(meta, { type: "message", message: toolResult("a") }),
		store.append(meta, { type: "message", message: toolResult("b") }),
		store.append(meta, { type: "message", message: toolResult("c") }),
	]);

	const after: number[] = [];
	for await (const record of store.read(meta.projectId, meta.id, 1)) after.push(record.seq);
	assert.deepEqual(after, [2, 3, 4], "a client that has seen seq 1 must receive all three results");
});

test("reopening a session continues numbering instead of restarting", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const first = new SessionStore(root);
	const meta = await first.create("/tmp/project", "model");
	await first.append(meta, { type: "message", message: toolResult("a") });

	// A fresh process (app restart) must not reuse sequence numbers already on disk.
	const second = new SessionStore(root);
	const loaded = await second.load(meta.projectId, meta.id);
	assert.ok(loaded);
	const next = await second.append(loaded.meta, { type: "message", message: toolResult("b") });
	assert.equal(next.seq, 3);
});
