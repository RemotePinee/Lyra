import test from "node:test";
import assert from "node:assert/strict";
import { groupMessages, groupByProject } from "../src/grouping.ts";
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
test("places leading thinking above tool run without duplicating calls", () => {
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: "check files" }],
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should inspect the directory" },
				{ type: "toolCall", id: "call_ls", name: "ls", arguments: {} },
			],
			stopReason: "toolUse",
			usage: { input: 10, output: 10, total: 20, cost: { total: 0 } },
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_ls",
			toolName: "ls",
			content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Wrap up results" },
				{ type: "text", text: "Found two files." },
			],
			stopReason: "endTurn",
			usage: { input: 10, output: 10, total: 20, cost: { total: 0 } },
			timestamp: 4,
		},
	];

	const runs = groupMessages(messages);
	// 0: user message
	// 1: thinking message (upTo: 1)
	// 2: tools (call_ls)
	// 3: assistant final response (from: 1, upTo: 2)
	assert.equal(runs.length, 4);
	assert.equal(runs[0].kind, "message");
	assert.equal(runs[1].kind, "message");
	if (runs[1].kind === "message") {
		assert.equal(runs[1].upTo, 1);
		assert.equal(runs[1].message.content[0].type, "thinking");
	}
	assert.equal(runs[2].kind, "tools");
	if (runs[2].kind === "tools") {
		assert.equal(runs[2].calls.length, 1);
		assert.equal(runs[2].calls[0].block.name, "ls");
	}
	assert.equal(runs[3].kind, "message");
	if (runs[3].kind === "message") {
		assert.equal(runs[3].from, 1);
		assert.equal(runs[3].upTo, 2);
		const own = runs[3].message.content.slice(runs[3].from, runs[3].upTo);
		assert.equal(own[0].type, "text");
	}
});


test("groupByProject prioritizes latest project name from settings and preserves historical ones", () => {
	const sessions: SessionMeta[] = [
		{
			id: "s1",
			title: "Session 1",
			cwd: "E:\\CPA",
			projectId: "49de9a5fd17065d6",
			projectName: "CPA",
			createdAt: 100,
			updatedAt: 100,
			modelId: "test",
			messageCount: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { total: 0 } },
			seq: 1,
		},
		{
			id: "s2",
			title: "Session 2",
			cwd: "E:\\Mixstart",
			projectId: "76a0fc8418004973",
			projectName: "Mixstart",
			createdAt: 200,
			updatedAt: 200,
			modelId: "test",
			messageCount: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { total: 0 } },
			seq: 2,
		},
	];

	const projects = [
		{ id: "E:\\CPA", name: "CliRelay", path: "E:\\CPA" },
	];

	const groups = groupByProject(sessions, projects);
	assert.equal(groups.length, 2);
	const cpaGroup = groups.find((g: any) => g.sessions.some((s: any) => s.id === "s1"));
	const mixGroup = groups.find((g: any) => g.sessions.some((s: any) => s.id === "s2"));

	assert.equal(cpaGroup?.projectName, "CliRelay");
	assert.equal(mixGroup?.projectName, "Mixstart");
});
