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
	msg1.sseDurationMs = 900;
	msg1.usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 };

	const msg2 = assistant([call("b")], "toolUse");
	msg2.durationMs = 800;
	msg2.sseDurationMs = 600;
	msg2.usage = { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, total: 230 };

	const msg3 = assistant([text("完成了")], "stop");
	msg3.durationMs = 2000;
	msg3.sseDurationMs = 1500;
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
	assert.equal(stats.sseDurationMs, 3000);
	assert.equal(stats.outputTokens, 200);
	assert.equal(stats.requestCount, 3);
});

/*
 * A turn broken by a failure and picked up again is one turn.
 *
 * The reported figures are what a task cost, and a task that failed halfway and was resumed cost
 * both halves. Counting the 继续 as a new turn reported the second half only — so a job that took
 * twenty minutes over two legs claimed the length of the shorter one, and its tokens-per-second
 * described a stretch of work that was never run on its own.
 */
test("continuing after a failure keeps the turn's totals whole", () => {
	const first = assistant([call("a")], "error");
	first.durationMs = 5000;
	first.sseDurationMs = 4000;
	first.usage = { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, total: 300 };

	const second = assistant([text("做完了")], "stop");
	second.durationMs = 3000;
	second.sseDurationMs = 2500;
	second.usage = { input: 50, output: 80, cacheRead: 0, cacheWrite: 0, total: 130 };

	const messages: Message[] = [
		user("干这件事"),
		first,
		user("继续，从中断的地方接着做。"),
		second,
	];

	const stats = computeTurnStats(messages, 3);
	assert.equal(stats.durationMs, 8000, "两段的耗时要加起来");
	assert.equal(stats.outputTokens, 280, "两段的 token 要加起来");
	assert.equal(stats.requestCount, 2);
});

/*
 * The same sentence after a turn that ended normally is a new instruction.
 *
 * "继续" is a perfectly ordinary thing to say to a conversation that finished — carry on with the
 * next thing — and reading it as a continuation would silently glue two separate pieces of work
 * together in the figures.
 */
test("the same wording after a clean finish starts a new turn", () => {
	const first = assistant([text("做完了")], "stop");
	first.durationMs = 5000;
	first.usage = { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, total: 300 };

	const second = assistant([text("好的")], "stop");
	second.durationMs = 3000;
	second.usage = { input: 50, output: 80, cacheRead: 0, cacheWrite: 0, total: 130 };

	const messages: Message[] = [
		user("干这件事"),
		first,
		user("继续，从中断的地方接着做。"),
		second,
	];

	const stats = computeTurnStats(messages, 3);
	assert.equal(stats.durationMs, 3000, "上一轮正常结束，这是新的一轮");
	assert.equal(stats.outputTokens, 80);
	assert.equal(stats.requestCount, 1);
});

test("computeTurnStats returns zeros if no assistant messages or out of bounds", () => {
	const messages: Message[] = [user("问题")];
	const stats = computeTurnStats(messages, 0);
	assert.equal(stats.durationMs, 0);
	assert.equal(stats.sseDurationMs, 0);
	assert.equal(stats.outputTokens, 0);
	assert.equal(stats.requestCount, 0);
});

/*
 * The totals now ride on the rows, computed in the one pass that builds them.
 *
 * They used to be worked out where the row is drawn, which meant a backward scan per visible reply
 * on every render *and* a fresh object each time — so the row's memo compared unequal and every
 * message on screen was rebuilt whenever anything re-rendered the transcript. Both go away by
 * deriving them here, and this is what says the answer did not change on the way.
 */
test("a row carries the same totals computeTurnStats would give for it", () => {
	const first = assistant([text("第一轮回答")], "stop");
	first.durationMs = 500;
	first.sseDurationMs = 400;
	first.usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 };

	const msg1 = assistant([call("a")], "toolUse");
	msg1.durationMs = 1200;
	msg1.sseDurationMs = 900;
	msg1.usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 };

	const msg2 = assistant([call("b")], "toolUse");
	msg2.durationMs = 800;
	msg2.sseDurationMs = 600;
	msg2.usage = { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, total: 230 };

	const msg3 = assistant([text("完成了")], "stop");
	msg3.durationMs = 2000;
	msg3.sseDurationMs = 1500;
	msg3.usage = { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, total: 420 };

	const messages: Message[] = [
		user("第一轮问题"),
		first,
		user("第二轮问题"),
		msg1,
		answered("a"),
		nudge(),
		msg2,
		answered("b"),
		msg3,
	];

	const rows = runs(messages).filter((run) => run.kind === "message" && run.message.role === "assistant");
	assert.ok(rows.length > 0, "expected assistant rows");
	for (const row of rows) {
		if (row.kind !== "message") continue;
		assert.deepEqual(row.turnStats, computeTurnStats(messages, row.index), `row at ${row.index}`);
	}

	// And specifically: a nudge does not start a new turn, so the last row has all three replies.
	const last = rows[rows.length - 1];
	assert.equal(last.kind === "message" && last.turnStats?.requestCount, 3);
	assert.equal(last.kind === "message" && last.turnStats?.durationMs, 4000);
});

test("a person speaking starts the count over; the first turn's cost stays with the first turn", () => {
	const one = assistant([text("一")], "stop");
	one.durationMs = 500;
	one.usage = { input: 0, output: 20, cacheRead: 0, cacheWrite: 0, total: 20 };
	const two = assistant([text("二")], "stop");
	two.durationMs = 700;
	two.usage = { input: 0, output: 30, cacheRead: 0, cacheWrite: 0, total: 30 };

	const rows = runs([user("甲"), one, user("乙"), two]).filter((run) => run.kind === "message");
	const totals = rows
		.filter((run) => run.kind === "message" && run.message.role === "assistant")
		.map((run) => (run.kind === "message" ? run.turnStats : undefined));

	assert.deepEqual(
		totals.map((t) => t?.durationMs),
		[500, 700],
	);
	assert.deepEqual(
		totals.map((t) => t?.outputTokens),
		[20, 30],
	);
});

/*
 * The reported case: paused by hand, then 继续.
 *
 * A pause is `aborted`, not `error`, and the wording 继续 sends for it is the first of the three.
 * Reported as still restarting the clock, so it is pinned here separately from the failure case
 * rather than assumed to follow from it.
 */
test("continuing after a manual pause keeps the turn's totals whole", () => {
	const first = assistant([call("a")], "aborted");
	first.durationMs = 90_000;
	first.usage = { input: 100, output: 1000, cacheRead: 0, cacheWrite: 0, total: 1100 };

	const second = assistant([text("接着做完了")], "stop");
	second.durationMs = 30_000;
	second.usage = { input: 50, output: 200, cacheRead: 0, cacheWrite: 0, total: 250 };

	const messages: Message[] = [
		user("干这件事"),
		first,
		user("继续，从暂停的地方接着做。"),
		second,
	];

	const stats = computeTurnStats(messages, 3);
	assert.equal(stats.durationMs, 120_000, "暂停前后的耗时要加起来");
	assert.equal(stats.outputTokens, 1200);
});

/*
 * 继续 sent by the button, which is a message the app composed rather than one you typed.
 *
 * `synthetic` is how the transcript says so: those messages are not drawn, and they do not open a
 * turn. `ResumeRow` simply never passed it, so pressing 继续 put the sentence in the conversation
 * and restarted the turn's clock. Both halves are checked here — the row is skipped, and the totals
 * carry across it.
 */
test("继续 sent as a synthetic message neither shows nor restarts the turn", () => {
	const first = assistant([call("a")], "aborted");
	first.durationMs = 90_000;
	first.usage = { input: 100, output: 1000, cacheRead: 0, cacheWrite: 0, total: 1100 };

	const second = assistant([text("接着做完了")], "stop");
	second.durationMs = 30_000;
	second.usage = { input: 50, output: 200, cacheRead: 0, cacheWrite: 0, total: 250 };

	const carryOn = user("继续，从暂停的地方接着做。");
	carryOn.synthetic = true;

	const messages: Message[] = [user("干这件事"), first, carryOn, second];

	const stats = computeTurnStats(messages, 3);
	assert.equal(stats.durationMs, 120_000, "暂停前后的耗时要加起来");
	assert.equal(stats.outputTokens, 1200);

	// And it is not a row: `runs` drops synthetic user messages entirely.
	const rows = runs(messages, []);
	const shown = rows.filter((r) => r.kind === "message" && r.message.role === "user");
	assert.equal(shown.length, 1, "只应该看到你真正写的那一条");
});
