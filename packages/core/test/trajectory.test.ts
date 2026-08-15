/**
 * The trajectory: one stream, read four ways.
 *
 * These tests hold the properties that make it worth having — that a reply's reasoning and its
 * words are separate things, that a voided tail stays gone, that forking does not disturb what it
 * forked from, and that all of it comes from the same file the model's turn was written to.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
import {
	countBySource,
	filterTrajectory,
	forkSession,
	matchRanges,
	messagesUpTo,
	readTrajectory,
} from "../src/trajectory/index.ts";
import type { AssistantMessage, Message } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

async function seeded() {
	const root = await mkdtemp(join(tmpdir(), "dw-traj-"));
	const store = new SessionStore(join(root, "sessions"));
	let meta = await store.create(root, "fake/model");

	const user: Message = { role: "user", content: [{ type: "text", text: "查一下构建为什么慢" }], timestamp: 1 };
	meta = await store.append(meta, { type: "message", message: user });
	meta = await store.append(meta, {
		type: "event",
		event: { type: "context", systemPrompt: "You are DeepWise.", tools: ["bash", "read"], skills: [] },
	});
	meta = await store.append(meta, {
		type: "message",
		message: assistant([
			{ type: "thinking", thinking: "缓存大概是冷的" },
			{ type: "text", text: "先看构建日志" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run build" } },
		]),
	});
	meta = await store.append(meta, {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			content: [{ type: "text", text: "cache miss on every module" }],
			timestamp: 2,
		} as Message,
	});

	return { store, meta, root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 8 }) };
}

test("a reply's reasoning, its words and its tool call are three separate entries", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const sources = entries.map((entry) => entry.source);

		assert.deepEqual(sources, ["user", "system", "context", "thinking", "assistant", "tool-call", "tool-result"]);
		// The three that came from one record share its sequence, which is how they are known to
		// have arrived together.
		const fromReply = entries.filter((entry) => ["thinking", "assistant", "tool-call"].includes(entry.source));
		assert.equal(new Set(fromReply.map((entry) => entry.seq)).size, 1);
	} finally {
		await h.cleanup();
	}
});

test("a tool result can be traced back to the call it answers", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const call = entries.find((entry) => entry.source === "tool-call");
		const result = entries.find((entry) => entry.source === "tool-result");
		assert.equal(call?.correlationId, "c1");
		assert.equal(result?.correlationId, "c1");
	} finally {
		await h.cleanup();
	}
});

test("filtering by source and by words compose", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);

		assert.equal(filterTrajectory(entries, { sources: ["thinking"] }).length, 1);
		assert.equal(filterTrajectory(entries, { query: "cache miss" }).length, 1);
		assert.equal(filterTrajectory(entries, { sources: ["user"], query: "cache miss" }).length, 0);

		const counts = countBySource(entries);
		assert.equal(counts["tool-call"], 1);
		assert.equal(counts.system, 1);
	} finally {
		await h.cleanup();
	}
});

test("the system prompt is kept whole, so it can be read back", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const system = entries.find((entry) => entry.source === "system");
		assert.equal(system?.detail, "You are DeepWise.");
	} finally {
		await h.cleanup();
	}
});

test("a voided tail does not appear in the trajectory", async () => {
	const h = await seeded();
	try {
		const before = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const cutoff = before[0].seq;

		await h.store.append(h.meta, { type: "truncate", afterSeq: cutoff });
		const after = await readTrajectory(h.store, h.meta.projectId, h.meta.id);

		assert.equal(after.length, 1, "only the first message survives");
		assert.equal(after[0].source, "user");
	} finally {
		await h.cleanup();
	}
});

test("forking copies the history up to a point and leaves the original alone", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const atReply = entries.find((entry) => entry.source === "assistant");
		assert.ok(atReply);

		const fork = await forkSession(h.store, h.meta.projectId, h.meta.id, atReply.seq);
		assert.ok(fork);
		assert.equal(fork.messages, 2, "the question and the reply, not the tool result after them");

		const forked = await messagesUpTo(h.store, fork.meta.projectId, fork.meta.id, Number.POSITIVE_INFINITY);
		assert.deepEqual(
			forked.map((message) => message.role),
			["user", "assistant"],
		);

		// The original still has everything.
		const original = await messagesUpTo(h.store, h.meta.projectId, h.meta.id, Number.POSITIVE_INFINITY);
		assert.equal(original.length, 3);
	} finally {
		await h.cleanup();
	}
});

test("match ranges point at every occurrence, for highlighting", () => {
	const ranges = matchRanges("cache miss, then another cache miss", "cache");
	assert.deepEqual(ranges, [
		{ start: 0, end: 5 },
		{ start: 25, end: 30 },
	]);
	assert.deepEqual(matchRanges("anything", "  "), [], "an empty query matches nothing, not everything");
});
