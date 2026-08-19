/**
 * When the running indicator stops being informative.
 *
 * It stays put for the whole of a turn on purpose: it used to appear only between tool calls, so
 * its 46px came and went and the transcript shifted up and down all through a turn.
 *
 * But once the answer itself is streaming in above it, "Nearly there…" is describing something the
 * reader can already see. Sitting under a finished-looking answer saying almost-done reads as the
 * app having lost track of what it is doing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

type Block = { type: string; text?: string };
type Message = { role: string; stopReason?: string; content: Block[] };

/** The condition from `Conversation`: the final answer has begun arriving. */
function answering(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	return last.content.some((block) => block.type === "text" && (block.text ?? "").trim().length > 0);
}

const user: Message = { role: "user", content: [{ type: "text", text: "介绍下这个项目" }] };

test("before anything comes back, the indicator stays", () => {
	assert.equal(answering([user]), false);
});

test("through tool calls, the indicator stays — that is what it is for", () => {
	const withCalls: Message = { role: "assistant", stopReason: "pending", content: [{ type: "toolCall" }] };
	assert.equal(answering([user, withCalls]), false);
});

test("reasoning alone is not the answer, so the indicator stays", () => {
	// 思考过程 is not what anyone is waiting to read.
	const thinking: Message = { role: "assistant", stopReason: "pending", content: [{ type: "reasoning", text: "先看看…" }] };
	assert.equal(answering([user, thinking]), false);
});

test("the first words of prose fold it away", () => {
	const prose: Message = { role: "assistant", stopReason: "pending", content: [{ type: "text", text: "这是 Ink 博客" }] };
	assert.equal(answering([user, prose]), true);
});

test("empty or whitespace text is not the answer starting", () => {
	/*
	 * A text block often arrives empty and fills in. Treating its arrival as the answer would fold
	 * the indicator away a beat early and — since the turn is still going — flap it back.
	 */
	for (const text of ["", "   ", "\n"]) {
		const blank: Message = { role: "assistant", stopReason: "pending", content: [{ type: "text", text }] };
		assert.equal(answering([user, blank]), false, `for ${JSON.stringify(text)}`);
	}
});

test("a settled message is not answering — the turn is over and the indicator is gone anyway", () => {
	const done: Message = { role: "assistant", stopReason: "end", content: [{ type: "text", text: "这是 Ink 博客" }] };
	assert.equal(answering([user, done]), false);
});

test("prose, then another tool call: the indicator comes back", () => {
	/*
	 * The model answers a little, then goes off to check something. The indicator is once again the
	 * only thing saying work is happening, so it should return — and because it folds rather than
	 * unmounts, coming back is a height animating rather than a row appearing.
	 */
	const prose: Message = { role: "assistant", stopReason: "pending", content: [{ type: "text", text: "先说结论" }] };
	const thenCalls: Message = { role: "assistant", stopReason: "pending", content: [{ type: "toolCall" }] };
	assert.equal(answering([user, prose]), true);
	assert.equal(answering([user, prose, thenCalls]), false);
});
