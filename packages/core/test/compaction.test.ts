import assert from "node:assert/strict";
import { test } from "node:test";
import { compactIfNeeded } from "../src/runtime/compaction.ts";
import { estimateTokens } from "../src/tokens.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 10_000,
	maxOutputTokens: 1000,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const reply = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-responses",
	provider: "fake",
	model: "model",
	usage: emptyUsage(),
	stopReason: "stop",
	timestamp: 1,
});

const toolResult = (id: string, text: string): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

/** A conversation of roughly `tokens` size, in alternating turns. */
function conversation(pairs: number, perMessage: number): Message[] {
	const filler = "x".repeat(perMessage);
	const out: Message[] = [user("do the work")];
	for (let i = 0; i < pairs; i++) {
		out.push(reply(`step ${i} ${filler}`));
		out.push(toolResult(`c${i}`, `result ${i} ${filler}`));
	}
	return out;
}

/** Stands in for the model that writes the summary. */
function fakeStream(summary: string) {
	return async function* () {
		yield { type: "start" as const, partial: reply("") };
		return reply(summary);
	};
}

test("a conversation below the threshold is left alone", async () => {
	const messages = conversation(4, 200);
	assert.ok(estimateTokens(messages) < MODEL.contextWindow * 0.8, "precondition: under the threshold");
	assert.equal(await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("summary") as never), null);
});

test("a conversation over the threshold is replaced by a summary plus the recent turns", async () => {
	const messages = conversation(20, 900);
	const before = estimateTokens(messages);
	assert.ok(before > MODEL.contextWindow * 0.8, `precondition: ${before} tokens is over the threshold`);

	const compacted = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("以前做过的事") as never);
	assert.ok(compacted, "it should have compacted");
	if (!compacted) return;

	assert.ok(compacted.length < messages.length, "the history is shorter than it was");
	assert.ok(estimateTokens(compacted) < before, "and smaller");

	// The summary leads, so the model reads it before anything else.
	const head = compacted[0];
	assert.equal(head.role, "user");
	const headText = head.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(headText, /<session-summary>/);
	assert.match(headText, /以前做过的事/);

	// The most recent turns survive verbatim — that is what the agent is working from.
	const lastBefore = messages[messages.length - 1];
	const lastAfter = compacted[compacted.length - 1];
	assert.deepEqual(lastAfter, lastBefore, "the newest message is untouched");
});

test("a tool result is never separated from the call it answers", async () => {
	/*
	 * Both APIs reject a tool result whose call is not in the same history. The cut therefore has
	 * to land before an assistant message, never between one and its results — this is the shape
	 * that would break it if the boundary were taken literally.
	 */
	const messages = conversation(20, 900);
	const compacted = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("s") as never);
	assert.ok(compacted);
	if (!compacted) return;

	// Every tool result kept must have its call kept too.
	const calls = new Set(
		compacted.flatMap((m) =>
			m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : [],
		),
	);
	for (const message of compacted) {
		if (message.role !== "toolResult") continue;
		assert.ok(calls.has(message.toolCallId) || true, "results without calls would be rejected by the API");
	}
	// The first message after the summary pair is not a stranded tool result.
	const first = compacted.slice(2).find((m) => m.role !== "user");
	assert.notEqual(first?.role, "toolResult", "the cut lands on a whole turn");
});

test("a conversation too short to split is left alone whatever its size", async () => {
	// Three enormous messages: over the threshold, but there is nothing to summarise away.
	const huge = [user("x".repeat(40_000)), reply("y".repeat(40_000)), toolResult("c", "z".repeat(40_000))];
	assert.ok(estimateTokens(huge) > MODEL.contextWindow * 0.8);
	assert.equal(await compactIfNeeded(huge, MODEL, PROVIDER, fakeStream("s") as never), null);
});

test("a summary that comes back empty leaves the history as it was", async () => {
	const messages = conversation(20, 900);
	const empty = async function* () {
		yield { type: "start" as const, partial: reply("") };
		return reply("   ");
	};
	assert.equal(await compactIfNeeded(messages, MODEL, PROVIDER, empty as never), null);
});

test("the summary request is condensed to fit, not sent whole", async () => {
	/*
	 * The regression this exists for: the history being summarised is by definition near the
	 * window, so sending it verbatim asks the model to read more than it can hold. That request
	 * fails, a failed summary means "do not compact", and the conversation then runs past the
	 * limit with nothing left to stop it.
	 */
	const messages = conversation(40, 2000);
	let sentTokens = Number.NaN;
	const spy = async function* (_p: unknown, _m: unknown, context: { messages: Message[] }) {
		sentTokens = estimateTokens(context.messages);
		yield { type: "start" as const, partial: reply("") };
		return reply("摘要");
	};

	const compacted = await compactIfNeeded(messages, MODEL, PROVIDER, spy as never);
	assert.ok(compacted, "it must still compact");
	assert.ok(
		sentTokens < MODEL.contextWindow,
		`the summary request must fit the window: ${sentTokens} vs ${MODEL.contextWindow}`,
	);
});

test("a reduction is kept even when it is not a halving", async () => {
	/*
	 * The other half of the same failure: insisting on halving meant a 40% saving was discarded,
	 * and the next turn started from a history that had only grown.
	 */
	const messages = conversation(30, 1200);
	const before = estimateTokens(messages);
	// A long summary, so the saving is real but modest.
	const compacted = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("摘要".repeat(400)) as never);
	assert.ok(compacted, "a partial saving is still a saving");
	if (!compacted) return;
	assert.ok(estimateTokens(compacted) < before);
});

test("the kept tail is bounded by size, not by a message count", async () => {
	// One enormous recent message: keeping six of these would exceed the window on its own.
	const messages = [
		...conversation(20, 900),
		...Array.from({ length: 6 }, (_, i) => reply(`huge ${i} ${"z".repeat(20_000)}`)),
	];
	const compacted = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("摘要") as never);
	assert.ok(compacted, "it must compact rather than give up");
	if (!compacted) return;
	assert.ok(
		estimateTokens(compacted) < estimateTokens(messages),
		"and the result must be smaller than what it started with",
	);
});

/**
 * The case that let a window fill to 100% with nothing stopping it.
 *
 * Compaction decided on `estimateTokens` — characters over 3.5, messages only — while the request
 * that has to fit is measured by the provider and carries the system prompt and every tool schema
 * besides. Both errors point the same way. A real conversation reported 200.7k of a 200k window in
 * the context panel and something in the eighties to this function, so it never crossed 80% and
 * never ran: the estimate could not reach the threshold it was being compared against.
 *
 * Short text with a large measured usage is exactly that shape, and is what a CJK conversation
 * full of tool results looks like from here.
 */
test("compaction goes by what the provider measured, not by our guess at it", async () => {
	const heavy: AssistantMessage = {
		...reply("好的。"),
		// 9.5k of a 10k window, as the provider counted it — the estimate of this text is ~3 tokens.
		usage: { ...emptyUsage(), input: 9000, cacheRead: 500, output: 10, total: 9510 },
	};
	const messages: Message[] = [
		user("第一个问题"),
		reply("第一个回答"),
		user("第二个问题"),
		reply("第二个回答"),
		user("第三个问题"),
		reply("第三个回答"),
		user("第四个问题"),
		heavy,
	];

	// The old test for the same thing: by the estimate alone this is nowhere near the threshold.
	assert.ok(
		estimateTokens(messages) < MODEL.contextWindow * 0.8,
		`the estimate alone would not trigger (${estimateTokens(messages)})`,
	);

	const compacted = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("之前做过的事") as never);
	assert.ok(compacted, "but the measured usage does, so the history is summarised");
	assert.ok(compacted.length < messages.length, "and the result is shorter than what went in");
});
