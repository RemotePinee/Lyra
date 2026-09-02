import test from "node:test";
import assert from "node:assert/strict";
import { groupMessages } from "../src/grouping.ts";
import type { Message } from "../src/protocol.ts";

test("groups consecutive tool calls across multi-turn assistant messages", () => {
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					arguments: { path: "a.ts" },
				},
			],
			stopReason: "toolUse",
			usage: { input: 10, output: 10, total: 20, cost: { total: 0 } },
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "file content" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_2",
					name: "edit",
					arguments: { path: "a.ts" },
				},
			],
			stopReason: "toolUse",
			usage: { input: 10, output: 10, total: 20, cost: { total: 0 } },
			timestamp: 4,
		},
		{
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "edit",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 5,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "All done!" }],
			stopReason: "endTurn",
			usage: { input: 10, output: 10, total: 20, cost: { total: 0 } },
			timestamp: 6,
		},
	];

	const runs = groupMessages(messages);

	assert.equal(runs.length, 3);
	assert.equal(runs[0].kind, "message");
	assert.equal(runs[1].kind, "tools");
	if (runs[1].kind === "tools") {
		assert.equal(runs[1].id, "call_1");
		assert.equal(runs[1].calls.length, 2);
		assert.equal(runs[1].calls[0].block.name, "read");
		assert.equal(runs[1].calls[1].block.name, "edit");
	}
	assert.equal(runs[2].kind, "message");
});
