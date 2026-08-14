import assert from "node:assert/strict";
import { test } from "node:test";
import { nextActivity, visibleActivity, type SessionActivity } from "../src/activity.ts";

/** Replays a sequence of event types onto the state, the way the window does. */
function replay(events: ({ type: string; reason?: string; level?: string } | string)[]): SessionActivity | null {
	let state: SessionActivity | null = null;
	for (const event of events) state = nextActivity(typeof event === "string" ? { type: event } : event, state);
	return state;
}

test("a conversation nobody has touched has nothing to say", () => {
	assert.equal(replay([]), null);
	assert.equal(replay(["message_end", "tasks", "title"]), null);
});

test("a turn in progress reads as running", () => {
	assert.equal(replay(["agent_start"]), "running");
	assert.equal(replay(["agent_start", "turn_start", "tool_start"]), "running");
});

test("an unanswered approval reads as waiting, and outlives everything until answered", () => {
	assert.equal(replay(["agent_start", "approval_request"]), "waiting");
	// No event says "granted"; the tool running again is what says it.
	assert.equal(replay(["agent_start", "approval_request", "tool_start"]), "running");
	assert.equal(replay(["agent_start", "approval_request", "message_start"]), "running");
});

test("how a turn ended is what it reads as", () => {
	assert.equal(replay(["agent_start", { type: "agent_end", reason: "done" }]), "done");
	assert.equal(replay(["agent_start", { type: "agent_end", reason: "error" }]), "failed");
	assert.equal(replay(["agent_start", { type: "agent_end", reason: "max_turns" }]), "failed");
});

test("a turn the user stopped themselves ends in silence", () => {
	assert.equal(replay(["agent_start", { type: "agent_end", reason: "aborted" }]), null);
});

test("an error notice mid-turn is not an outcome", () => {
	// The turn carries on — a retry, or a tool failure the model will be told about.
	assert.equal(replay(["agent_start", { type: "notice", level: "error", message: "x" }]), "running");
	// `agent_end` still has the final word.
	assert.equal(
		replay(["agent_start", { type: "notice", level: "error" }, { type: "agent_end", reason: "done" }]),
		"done",
	);
	// Outside a turn there is nothing else coming to describe it.
	assert.equal(replay([{ type: "notice", level: "error" }]), "failed");
	assert.equal(replay([{ type: "notice", level: "info" }]), null);
});

test("a second turn replaces the result of the first", () => {
	assert.equal(replay(["agent_start", { type: "agent_end", reason: "error" }, "agent_start"]), "running");
	assert.equal(
		replay([
			"agent_start",
			{ type: "agent_end", reason: "done" },
			"agent_start",
			{ type: "agent_end", reason: "error" },
		]),
		"failed",
	);
});

test("the conversation on screen shows no unread outcome, because it has been read", () => {
	assert.equal(visibleActivity("done", true), null);
	assert.equal(visibleActivity("failed", true), null);
	assert.equal(visibleActivity("done", false), "done");
	assert.equal(visibleActivity("failed", false), "failed");
});

test("what is still happening shows whether you are looking at it or not", () => {
	for (const state of ["running", "waiting"] as const) {
		assert.equal(visibleActivity(state, true), state);
		assert.equal(visibleActivity(state, false), state);
	}
	assert.equal(visibleActivity(null, true), null);
	assert.equal(visibleActivity(null, false), null);
});
