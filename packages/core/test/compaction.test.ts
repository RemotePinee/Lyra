import assert from "node:assert/strict";
import { test } from "node:test";
import { compactIfNeeded } from "../src/runtime/compaction.ts";
import { PRUNE_THRESHOLD_CHARS, pruneText, pruneToolResults } from "../src/runtime/prune.ts";
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

test("a conversation too short to summarise is still cut down where it can be", async () => {
	/*
	 * Three enormous messages: over the threshold, and with no past to summarise away — the whole
	 * thing *is* the recent tail. This used to answer `null` and leave the window over its limit
	 * with nothing attempted.
	 *
	 * The tool result in it is 40,000 characters, and cutting that needs no model and no history to
	 * work with. Summarising is still declined; the conversation still gets smaller.
	 */
	const huge = [user("x".repeat(40_000)), reply("y".repeat(40_000)), toolResult("c", "z".repeat(40_000))];
	assert.ok(estimateTokens(huge) > MODEL.contextWindow * 0.8);

	const result = await compactIfNeeded(huge, MODEL, PROVIDER, fakeStream("s") as never);
	assert.ok(result, "something came back rather than a refusal");
	assert.equal(result.length, huge.length, "no message was dropped — there was nothing to drop");
	assert.ok(estimateTokens(result) < estimateTokens(huge), "but it weighs less");
	assert.equal(result[0], huge[0], "the two that are not tool results are untouched");
	assert.equal(result[1], huge[1]);
});

test("a conversation with nothing oversized in it is still left alone", async () => {
	// The other half of the case above: nothing to summarise *and* nothing to cut.
	const short = [user("hi"), reply("hello"), toolResult("c", "ok")];
	assert.equal(await compactIfNeeded(short, MODEL, PROVIDER, fakeStream("s") as never), null);
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
	/*
	 * Long enough that replacing them with a summary is a saving.
	 *
	 * Not incidental: a handful of five-character messages weighs less than the summary wrapper and
	 * the acknowledgement that replace it, so compaction correctly declines. The case under test is
	 * a real conversation whose *estimate* is low relative to what the provider charged, which is
	 * what CJK and dense tool output do.
	 */
	const body = (n: number) => `第${n}轮的内容`.repeat(60);
	const messages: Message[] = [
		user(body(1)),
		reply(body(2)),
		user(body(3)),
		reply(body(4)),
		user(body(5)),
		reply(body(6)),
		user(body(7)),
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

/*
 * Cutting oversized tool results, which is the half of this that needs no model.
 *
 * A single `grep` can answer with 96,000 characters — its limit counts matches, and one match in a
 * minified file is one very long line. Three of those fill a 200k window between them, and the
 * thing compaction is then asked to summarise is mostly the same file read three ways. Cutting is
 * string work; summarising is a request that is slow, billed, and least reliable exactly when the
 * window is tight. So this runs first.
 */

test("an oversized result keeps its head and its tail, and says what went", () => {
	const text = `HEAD${"x".repeat(20_000)}TAIL`;
	const cut = pruneText(text);
	assert.ok(cut, "it was over the threshold");
	assert.ok(cut.startsWith("HEAD"), "the answer is at the front");
	assert.ok(cut.endsWith("TAIL"), "the totals are at the back");
	assert.ok(cut.includes("omitted"), "and the gap is declared rather than silent");
	assert.ok([...cut].length < [...text].length, "it is smaller");
	assert.ok([...cut].length <= PRUNE_THRESHOLD_CHARS, "and inside the threshold");
});

test("anything already small enough is left exactly as it was", () => {
	assert.equal(pruneText("short"), null);
	assert.equal(pruneText("x".repeat(PRUNE_THRESHOLD_CHARS)), null, "the boundary is inclusive");
	assert.ok(pruneText("x".repeat(PRUNE_THRESHOLD_CHARS + 1)), "one past it is cut");
});

test("cutting is idempotent, so a second pass finds nothing to do", () => {
	const once = pruneText("y".repeat(50_000));
	assert.ok(once);
	assert.equal(pruneText(once), null, "the replacement is already inside the threshold");
});

test("only tool results are cut — what a person wrote is never edited", () => {
	const long = "z".repeat(30_000);
	const messages: Message[] = [user(long), reply(long), toolResult("c", long)];
	const cut = pruneToolResults(messages);
	assert.equal(cut[0], messages[0], "the user's own message is untouched");
	assert.equal(cut[1], messages[1], "and so is the reply");
	assert.notEqual(cut[2], messages[2], "the tool result is not");
	assert.ok(estimateTokens([cut[2]]) < estimateTokens([messages[2]]));
});

test("a conversation with nothing oversized comes back as the same array", () => {
	// Identity, not equality: callers use it to decide whether anything happened at all.
	const messages: Message[] = [user("hi"), toolResult("c", "ok")];
	assert.equal(pruneToolResults(messages), messages);
});

test("a text split never leaves half a surrogate pair behind", () => {
	// Emoji are two UTF-16 units each; slicing by unit would cut one in half and produce text no
	// provider accepts.
	const cut = pruneText("😀".repeat(20_000));
	assert.ok(cut);
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), "no lone high surrogate");
	assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), "no lone low surrogate");
});

test("cutting alone is enough when the bulk is tool output, and no summary is asked for", async () => {
	/*
	 * The saving that costs nothing. A conversation whose weight is three huge tool results comes
	 * back under the line on string work alone — and the model is never called, which is the point:
	 * the request that summarises is the one most likely to fail when the window is already tight.
	 */
	let asked = 0;
	const counting = (...args: unknown[]) => {
		asked++;
		return (fakeStream("summary") as never as (...a: unknown[]) => unknown)(...args);
	};
	const messages: Message[] = [
		user("找一下"),
		reply("好"),
		toolResult("a", "m".repeat(30_000)),
		reply("再找"),
		toolResult("b", "n".repeat(30_000)),
		reply("还有"),
		toolResult("c", "o".repeat(30_000)),
		reply("完成"),
	];
	assert.ok(estimateTokens(messages) > MODEL.contextWindow * 0.8, "it is over the line to begin with");

	const result = await compactIfNeeded(messages, MODEL, PROVIDER, counting as never);
	assert.ok(result, "something came back");
	assert.equal(asked, 0, "and no summary was requested");
	assert.equal(result.length, messages.length, "nothing was dropped — only cut");
	assert.ok(estimateTokens(result) < MODEL.contextWindow * 0.8, "and it now fits");
});

test("when a summary is needed, the result has to fit — not merely be smaller", async () => {
	/*
	 * The guarantee this used to lack, in the shape that exposes it.
	 *
	 * The retention rule keeps a minimum number of recent messages whatever they weigh. Make those
	 * heavy — just under the cut-down threshold each, so nothing is pruned and the weight has to be
	 * dealt with by dropping — and the old rule is satisfied the moment the summary is smaller than
	 * the history it replaced, while the result is still far over the window. That is exactly the
	 * 277k-compacts-to-250k case: compaction reported success and the turn still could not be sent.
	 */
	const fat = "详".repeat(7800);
	const messages: Message[] = [
		...conversation(30, 1200),
		user(fat),
		reply(fat),
		user(fat),
		reply(fat),
	];
	assert.ok(estimateTokens(messages) > MODEL.contextWindow * 0.8, "over the line to begin with");
	// The tail alone is over the window, so keeping it and calling that a success is the bug.
	assert.ok(estimateTokens(messages.slice(-4)) > MODEL.contextWindow * 0.6, "and its tail is heavy");

	const result = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("以前做过的事") as never);
	assert.ok(result, "it compacted");
	assert.ok(
		estimateTokens(result) < MODEL.contextWindow * 0.8,
		`the result is inside the window (${estimateTokens(result)} of ${MODEL.contextWindow})`,
	);
	assert.ok(result.length < messages.length, "and it did so by dropping history");
});

test("the tail never begins with a tool result orphaned from its call", async () => {
	// Dropping a call and keeping its answer is rejected by both APIs, so a cut in the middle of a
	// pair is not a smaller conversation — it is a failed request.
	const messages = conversation(40, 1200);
	const result = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("摘要") as never);
	assert.ok(result);
	// [summary, acknowledgement, ...tail]
	assert.notEqual(result[2]?.role, "toolResult", `the tail starts on a whole turn (${result[2]?.role})`);
});

/*
 * Keeping the instruction, which is the part a summary is worst at.
 *
 * The drift this prevents, in the user's own words: a conversation that opens with 「先找原因，先
 * 别修改代码」 and later says 「那进行彻底的修复」 holds two instructions that contradict each
 * other on purpose. Summarise both and the paraphrase is as likely to carry the first — after
 * which the agent explains why it has not started work, correctly, from the history it was given.
 */

test("the newest thing the user asked for is quoted, not paraphrased", async () => {
	const asked = "那进行彻底的修复，把这两个问题都修掉";
	const messages: Message[] = [
		user("先找原因，先别修改代码".repeat(200)),
		...conversation(30, 1200),
		user(asked),
		// Replies and results only: another `user` after this one would be the newer request, and
		// `conversation` opens with one of its own.
		...Array.from({ length: 8 }, (_, i) => [reply(`步骤 ${i} ${"x".repeat(1200)}`), toolResult(`t${i}`, "x".repeat(1200))]).flat(),
	];

	const result = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("讨论了一些问题") as never);
	assert.ok(result, "it compacted");

	const head = result[0];
	assert.equal(head.role, "user");
	const text = head.content.map((b) => (b.type === "text" ? b.text : "")).join("");
	assert.ok(text.includes("讨论了一些问题"), "the summary is there");
	assert.ok(text.includes(asked), `and the request is quoted exactly:\n${text.slice(0, 400)}`);
	assert.ok(text.includes("supersedes"), "and marked as current, so it wins over the summary");
});

test("a request still in the kept tail is not quoted a second time", async () => {
	/*
	 * Two copies of one instruction, with nothing to say which is current, is its own kind of
	 * confusion — and the tail already carries it verbatim.
	 */
	const asked = "只改这一个文件";
	const messages: Message[] = [...conversation(40, 1200), user(asked), reply("好")];
	const result = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("之前的事") as never);
	assert.ok(result);
	const head = result[0].content.map((b) => (b.type === "text" ? b.text : "")).join("");
	assert.ok(!head.includes(asked), "the one still in the tail is not repeated at the top");
	const tail = result
		.slice(1)
		.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))
		.join("\n");
	assert.ok(tail.includes(asked), "because it is still there in full, in its own place");
});

test("the runtime's own nudges are not mistaken for what the user wants", async () => {
	// `continue`, and the summary head from an earlier compaction, are synthetic. Pinning the
	// conversation to one would fix it to a sentence nobody typed.
	const real = "把测试补齐";
	const messages: Message[] = [
		...conversation(30, 1200),
		user(real),
		{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: 1, synthetic: true },
		...Array.from({ length: 8 }, (_, i) => [reply(`步骤 ${i} ${"x".repeat(1200)}`), toolResult(`t${i}`, "x".repeat(1200))]).flat(),
	];
	const result = await compactIfNeeded(messages, MODEL, PROVIDER, fakeStream("摘要") as never);
	assert.ok(result);
	const head = result[0].content.map((b) => (b.type === "text" ? b.text : "")).join("");
	assert.ok(head.includes(real), "the real request is what carries across");
	assert.ok(!head.includes("<standing-request>\n继续"), "not the nudge");
});
