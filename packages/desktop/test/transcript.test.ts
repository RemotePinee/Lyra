import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage, Message } from "@deepwise/core";

import { settleTail } from "../src/transcript.ts";

function reply(stopReason: AssistantMessage["stopReason"], text = "你好！"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, total: 0 } },
	};
}

const asked: Message = { role: "user", content: [{ type: "text", text: "你好呀" }], timestamp: 0 };

test("a reply cut off by a dropped connection is marked as failed, not left pending", () => {
	const settled = settleTail([asked, reply("pending")], {
		type: "agent_end",
		reason: "error",
		error: "terminated (UND_ERR_SOCKET)",
	});

	const tail = settled[1] as AssistantMessage;
	assert.equal(tail.stopReason, "error");
	assert.equal(tail.errorMessage, "terminated (UND_ERR_SOCKET)");
	// The text that did arrive before the socket died is still worth showing.
	assert.deepEqual(tail.content, [{ type: "text", text: "你好！" }]);
});

test("stopping a turn marks the tail as aborted rather than as a failure", () => {
	const settled = settleTail([asked, reply("pending")], { type: "agent_end", reason: "aborted" });
	assert.equal((settled[1] as AssistantMessage).stopReason, "aborted");
	assert.equal((settled[1] as AssistantMessage).errorMessage, undefined);
});

test("a turn that ended normally is left exactly as the stream settled it", () => {
	const messages = [asked, reply("stop")];
	const settled = settleTail(messages, { type: "agent_end", reason: "done" });
	assert.equal(settled, messages, "no pending tail means no new array");
});

test("only the tail is touched, not an earlier turn that failed the same way", () => {
	const earlier = { ...reply("pending", "上一轮"), timestamp: 0 };
	const settled = settleTail([asked, earlier, asked, reply("pending")], { type: "agent_end", reason: "done" });

	assert.equal((settled[1] as AssistantMessage).stopReason, "pending", "an older turn is not this run's to settle");
	assert.equal((settled[3] as AssistantMessage).stopReason, "stop");
});
