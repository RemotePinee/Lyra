/**
 * A turn that asked for two tools at once, on its way back to the provider.
 *
 * The shape this checks is not cosmetic. Relays that translate Responses into Chat Completions
 * make one assistant message per `function_call` item, and Chat Completions requires the message
 * after one carrying `tool_calls` to be the tool message answering it — so two calls in a row are
 * rejected outright:
 *
 *     an assistant message with 'tool_calls' must be followed by tool messages responding to
 *     each 'tool_call_id'. The following tool_call_ids did not have response messages: bash:0
 *
 * Verified against the relay this was reported on: calls and results interleaved are accepted,
 * the same conversation with both calls first is a 400 every time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { toAnthropicMessages } from "../src/ai/anthropic-messages-request.ts";
import { toResponsesInput } from "../src/ai/openai-responses-request.ts";
import type { AssistantMessage, Message, ToolResultMessage } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "relay",
		model: "kimi-k3",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function call(id: string, name: string): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
	return { type: "toolCall", id, name, arguments: {}, argumentsText: "{}" };
}

function answer(id: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

const user: Message = { role: "user", content: [{ type: "text", text: "看看项目" }], timestamp: 0 };

/** Just the parts that decide whether the request is well formed. */
const shape = (input: unknown[]) =>
	input.map((item) => {
		const it = item as { type: string; call_id?: string };
		return it.call_id ? `${it.type}:${it.call_id}` : it.type;
	});

test("each call is followed by its own result", () => {
	const input = toResponsesInput([
		user,
		assistant([call("a", "bash"), call("b", "glob")]),
		answer("a", "listing"),
		answer("b", "no match"),
	]);

	assert.deepEqual(shape(input), [
		"message",
		"function_call:a",
		"function_call_output:a",
		"function_call:b",
		"function_call_output:b",
	]);
});

test("results recorded in completion order are paired back to their calls", () => {
	// What the log holds after the quicker tool finished first.
	const input = toResponsesInput([
		user,
		assistant([call("a", "bash"), call("b", "glob")]),
		answer("b", "no match"),
		answer("a", "listing"),
	]);

	assert.deepEqual(shape(input), [
		"message",
		"function_call:a",
		"function_call_output:a",
		"function_call:b",
		"function_call_output:b",
	]);
	// And the outputs still carry their own text rather than each other's.
	assert.equal((input[2] as { output: string }).output, "listing");
	assert.equal((input[4] as { output: string }).output, "no match");
});

test("a call with no result is left unanswered rather than given someone else's", () => {
	const input = toResponsesInput([user, assistant([call("a", "bash"), call("b", "glob")]), answer("b", "no match")]);

	assert.deepEqual(shape(input), ["message", "function_call:a", "function_call:b", "function_call_output:b"]);
});

test("a result whose call is not in the history keeps its place", () => {
	const input = toResponsesInput([user, assistant([call("a", "bash")]), answer("a", "listing"), answer("z", "orphan")]);

	assert.deepEqual(shape(input), [
		"message",
		"function_call:a",
		"function_call_output:a",
		"function_call_output:z",
	]);
});

test("a truncated history that starts with a result still sends it", () => {
	const input = toResponsesInput([answer("a", "listing"), user]);

	assert.deepEqual(shape(input), ["function_call_output:a", "message"]);
});

test("ids repeated across turns are answered within their own turn", () => {
	// Relays that name calls after the tool (`bash:0`) reuse the same id every turn.
	const input = toResponsesInput([
		user,
		assistant([call("bash:0", "bash")]),
		answer("bash:0", "first"),
		assistant([call("bash:0", "bash")]),
		answer("bash:0", "second"),
	]);

	assert.deepEqual(
		input.map((item) => (item as { output?: string }).output).filter(Boolean),
		["first", "second"],
	);
});

test("Anthropic gets its results in call order whatever order they finished in", () => {
	const messages: Message[] = [
		user,
		assistant([call("a", "bash"), call("b", "glob")]),
		answer("b", "no match"),
		answer("a", "listing"),
	];

	const out = toAnthropicMessages(messages);
	const results = out[out.length - 1];
	assert.equal(results.role, "user");
	assert.deepEqual(
		results.content.map((block) => (block as { tool_use_id: string }).tool_use_id),
		["a", "b"],
	);
});

test("an Anthropic result with no matching call is kept at the end of its run", () => {
	const out = toAnthropicMessages([
		user,
		assistant([call("a", "bash")]),
		answer("z", "orphan"),
		answer("a", "listing"),
	]);

	const results = out[out.length - 1];
	assert.deepEqual(
		results.content.map((block) => (block as { tool_use_id: string }).tool_use_id),
		["a", "z"],
	);
});
