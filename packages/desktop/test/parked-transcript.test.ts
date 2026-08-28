/**
 * What happens to a parked transcript when its conversation moves on without you.
 *
 * The cache exists so that going back to a conversation you have already read does not flash a
 * skeleton at you. That is right, and it was being applied to conversations that had since said
 * something new: a turn finishing in the background put a green dot on the row, and clicking it
 * showed the transcript from *before* that turn — presented as current, with nothing to say so —
 * until the re-read landed.
 *
 * The claim: an event that changes what a background conversation says drops what was parked for
 * it, and an event that does not, does not. The second half is what keeps the cache worth having.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, Message } from "@lyra/core";
import { applyAgentEvent } from "../src/store/apply-event.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const said = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const reply: Message = {
	role: "assistant",
	content: [{ type: "text", text: "好" }],
	api: "anthropic",
	provider: "p",
	model: "m",
	usage,
	stopReason: "stop",
	timestamp: 2,
};

/**
 * Dispatch one event for a conversation that is *not* on screen, and report what survived.
 *
 * "other" is the background conversation; "watching" is the one the window has open. Writes are
 * folded back into the state so a handler that reads what it just wrote sees it.
 */
function afterEvent(event: AgentEvent): { parked: boolean } {
	const state = {
		activity: {},
		turns: {},
		sessions: [],
		activeSessionId: "watching",
		messages: [],
		toolRuns: {},
		sessionCache: {
			other: { meta: { id: "other" }, messages: [said("旧的")], toolRuns: {} },
		},
	} as Record<string, unknown>;

	applyAgentEvent(
		"other",
		event,
		(partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial),
		() => state as never,
	);

	return { parked: "other" in (state.sessionCache as Record<string, unknown>) };
}

for (const [name, event] of [
	["a reply starting", { type: "message_start", message: reply }],
	["a reply finishing", { type: "message_end", message: reply }],
	["a tool starting", { type: "tool_start", toolCallId: "t", toolName: "read", args: {} }],
	["a tool finishing", { type: "tool_end", toolCallId: "t", toolName: "read", result: { content: [] } }],
	["history being rewound", { type: "rewound", messageCount: 1 }],
	["history being summarised", { type: "compacted", before: 10, after: 2 }],
] as [string, AgentEvent][]) {
	test(`${name} elsewhere drops what was parked for it`, () => {
		assert.equal(afterEvent(event).parked, false);
	});
}

for (const [name, event] of [
	["a turn starting", { type: "agent_start" }],
	["a title being derived", { type: "title", title: "新名字" }],
	["a queue update", { type: "tasks", tasks: [] }],
	["a notice", { type: "notice", level: "info", message: "嗯" }],
] as [string, AgentEvent][]) {
	test(`${name} elsewhere leaves it parked`, () => {
		// Nothing about the transcript changed, so re-reading it would be work for the same answer —
		// and a skeleton on the way back in for no reason at all.
		assert.equal(afterEvent(event).parked, true);
	});
}

test("a conversation on screen keeps its cache — it is being kept up to date live", () => {
	const state = {
		activity: {},
		turns: {},
		sessions: [],
		activeSessionId: "watching",
		messages: [],
		toolRuns: {},
		pendingUserMessage: null,
		retrying: null,
		turnStartedAt: null,
		turnTokens: 0,
		sessionCache: {
			watching: { meta: { id: "watching" }, messages: [said("旧的")], toolRuns: {} },
		},
	} as Record<string, unknown>;

	applyAgentEvent(
		"watching",
		{ type: "message_start", message: reply },
		(partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial),
		() => state as never,
	);

	assert.ok("watching" in (state.sessionCache as Record<string, unknown>));
});
