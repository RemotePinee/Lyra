/**
 * Which row a tool call lands in, and whether it ever moves.
 *
 * The bug these are written against: a call made by a reply that was still streaming got a row of
 * its own — "执行 3 个操作" under a finished run — and jumped into the run above the moment the
 * reply settled. So the tests are mostly about a property rather than a layout: grouping the same
 * transcript before and after a message finishes has to give the same rows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantContent, AssistantMessage, Message, StopReason, ToolCallContent } from "@lyra/core";
import { emptyUsage } from "@lyra/core";

import { computeTurnStats, runs, type Run } from "../src/components/conversation/grouping.ts";

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function nudge(): Message {
	return { role: "user", content: [{ type: "text", text: "（自动继续）继续" }], timestamp: 1 };
}

function assistant(content: AssistantContent[], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: emptyUsage(),
		stopReason,
		timestamp: 1,
	};
}

function call(id: string, name = "read"): ToolCallContent {
	return { type: "toolCall", id, name, arguments: { path: `/tmp/${id}.ts` } };
}

function text(value: string): AssistantContent {
	return { type: "text", text: value };
}

function thinking(value: string): AssistantContent {
	return { type: "thinking", thinking: value };
}

function answered(id: string): Message {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp: 2 };
}

/** Rows reduced to what a reader would see change: the kind, and which calls are in it. */
function shape(rows: Run[]): string[] {
	return rows.map((row) => {
		if (row.kind === "compaction") return "compaction";
		if (row.kind === "message") return `message@${row.index}:${row.upTo}`;
		return `tools:${row.calls.map((c) => c.block.id).join(",")}`;
	});
}

test("a call from a reply that is still streaming joins the run above, not a row of its own", () => {
	const rows = runs([
		user("看看这个项目"),
		assistant([call("a"), call("b")], "toolUse"),
		answered("a"),
		answered("b"),
		// The reply the agent is writing right now, its first calls already through.
		assistant([call("c"), call("d"), call("e")], "pending"),
	]);

	assert.deepEqual(shape(rows), ["message@0:1", "tools:a,b,c,d,e"]);
});

test("finishing a reply does not move its calls into a different row", () => {
	const before: Message[] = [
		user("看看这个项目"),
		assistant([call("a")], "toolUse"),
		answered("a"),
		assistant([thinking("先读一下"), call("b"), call("c")], "pending"),
	];
	// The same transcript one event later: `message_end` settled the tail, nothing else changed.
	const after = [...before.slice(0, 3), assistant([thinking("先读一下"), call("b"), call("c")], "toolUse")];

	assert.deepEqual(shape(runs(before)), shape(runs(after)), "settling a message must not regroup the transcript");
	assert.deepEqual(shape(runs(after)), ["message@0:1", "tools:a,b,c"]);
});

test("a run grows call by call as the reply streams, in the row it started in", () => {
	const opening: Message[] = [user("跑一下"), assistant([call("a")], "toolUse"), answered("a")];
	// Each frame of the stream, as the renderer would see it.
	const frames = [
		[...opening, assistant([thinking("嗯")], "pending")],
		[...opening, assistant([thinking("嗯"), call("b")], "pending")],
		[...opening, assistant([thinking("嗯"), call("b"), call("c")], "pending")],
	];

	assert.deepEqual(shape(runs(frames[0])), ["message@0:1", "tools:a"], "reasoning alone claims no row");
	assert.deepEqual(shape(runs(frames[1])), ["message@0:1", "tools:a,b"]);
	assert.deepEqual(shape(runs(frames[2])), ["message@0:1", "tools:a,b,c"]);
});

test("text ends a run, and the calls after it start the one the next reply joins", () => {
	const rows = runs([
		user("改一下"),
		assistant([thinking("想想"), text("先看看这两个文件："), call("a")], "toolUse"),
		answered("a"),
		assistant([call("b")], "toolUse"),
	]);

	/*
	 * The sentence keeps its row and stops at its own last word; the call it introduced belongs
	 * to the run under it, which is where the next reply's calls go too. Drawing that call inside
	 * the message instead is what used to leave two identical grey lines with nothing between.
	 */
	assert.deepEqual(shape(rows), ["message@0:1", "message@1:2", "tools:a,b"]);
});

test("a reply that only talks keeps all of itself", () => {
	const rows = runs([user("你好"), assistant([thinking("打个招呼"), text("你好！")], "stop")]);
	assert.deepEqual(shape(rows), ["message@0:1", "message@1:2"]);
});

test("the runtime's nudge does not split the work on either side of it", () => {
	const rows = runs([
		user("继续干"),
		assistant([call("a")], "toolUse"),
		answered("a"),
		// Invisible in the transcript, so it must be invisible to the grouping as well.
		nudge(),
		assistant([call("b")], "toolUse"),
	]);

	assert.deepEqual(shape(rows), ["message@0:1", "tools:a,b"]);
});

test("a synthetic user message is passed over the same way", () => {
	const injected: Message = { role: "user", content: [{ type: "text", text: "系统插话" }], timestamp: 1, synthetic: true };
	const rows = runs([user("干活"), assistant([call("a")], "toolUse"), injected, assistant([call("b")], "toolUse")]);
	assert.deepEqual(shape(rows), ["message@0:1", "tools:a,b"]);
});

test("a reply that ended with nothing to show still gets a row", () => {
	// A dropped socket settles the tail as an error; without a row the failure is never drawn.
	const rows = runs([user("跑一下"), assistant([thinking("在想")], "error")]);
	assert.deepEqual(shape(rows), ["message@0:1", "message@1:1"]);
});

test("a real user message ends the run", () => {
	const rows = runs([
		user("先看看"),
		assistant([call("a")], "toolUse"),
		answered("a"),
		user("再看看"),
		assistant([call("b")], "toolUse"),
	]);
	assert.deepEqual(shape(rows), ["message@0:1", "tools:a", "message@3:1", "tools:b"]);
});

test("a compaction marker interrupts the run at the message it was taken from", () => {
	const rows = runs(
		[user("干活"), assistant([call("a")], "toolUse"), answered("a"), assistant([call("b")], "toolUse")],
		[{ at: 3 }],
	);
	assert.deepEqual(shape(rows), ["message@0:1", "tools:a", "compaction", "tools:b"]);
});

test("a compaction recorded past the end still lands at the end", () => {
	const rows = runs([user("干活"), assistant([call("a")], "toolUse")], [{ at: 9 }]);
	assert.deepEqual(shape(rows), ["message@0:1", "tools:a", "compaction"]);
});

test("the reply carries the calls it made, so a live one reads as live", () => {
	const rows = runs([user("跑"), assistant([call("a")], "toolUse"), answered("a"), assistant([call("b")], "pending")]);
	const tools = rows[1];
	assert.equal(tools.kind, "tools");
	if (tools.kind !== "tools") return;
	assert.deepEqual(
		tools.calls.map((c) => c.stopReason),
		["toolUse", "pending"],
	);
});

test("computeTurnStats aggregates duration and output tokens across all assistant requests in a turn", () => {
	const msg1 = assistant([call("a")], "toolUse");
	msg1.durationMs = 1200;
	msg1.usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 };

	const msg2 = assistant([call("b")], "toolUse");
	msg2.durationMs = 800;
	msg2.usage = { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, total: 230 };

	const msg3 = assistant([text("完成了")], "stop");
	msg3.durationMs = 2000;
	msg3.usage = { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, total: 420 };

	const messages: Message[] = [
		user("第一轮问题"),
		assistant([text("第一轮回答")], "stop"),
		user("第二轮问题"),
		msg1,
		answered("a"),
		nudge(),
		msg2,
		answered("b"),
		msg3,
	];

	const stats = computeTurnStats(messages, 8);
	assert.equal(stats.durationMs, 4000);
	assert.equal(stats.outputTokens, 200);
	assert.equal(stats.requestCount, 3);
});

test("computeTurnStats returns zeros if no assistant messages or out of bounds", () => {
	const messages: Message[] = [user("问题")];
	const stats = computeTurnStats(messages, 0);
	assert.equal(stats.durationMs, 0);
	assert.equal(stats.outputTokens, 0);
	assert.equal(stats.requestCount, 0);
});
