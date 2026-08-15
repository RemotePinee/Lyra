/**
 * A question nobody is there to answer.
 *
 * The gate exists so that a person decides the things a rule should not. When there is no person,
 * waiting forever is not deference — it is a run that never finishes. Refusing is the only safe
 * direction: it grants nothing, and the agent generally finds another way.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalGate } from "../src/runtime/approvals.ts";
import type { ApprovalRequest } from "../src/types.ts";

const request: ApprovalRequest = {
	kind: "bash",
	title: "Remove a directory outside the project",
	detail: "rm -rf /Users/me/elsewhere",
	subject: "rm -rf /Users/me/elsewhere",
};

function gate(options: Partial<Parameters<typeof ApprovalGate.prototype.request>> = {}, timeoutMs = 40) {
	const asked: string[] = [];
	const instance = new ApprovalGate({
		mode: () => "auto",
		cwd: () => "/Users/me/project",
		ask: async (pending) => {
			asked.push(pending.id);
		},
		remember: () => {},
		unattendedTimeoutMs: timeoutMs,
	});
	return { instance, asked };
}

test("an unanswered question becomes a refusal rather than a wait", async () => {
	const { instance, asked } = gate();
	const decision = await instance.request({ ...request });
	assert.equal(decision, "reject");
	assert.equal(asked.length, 1, "it did ask first");
	assert.deepEqual(instance.list(), [], "and stopped waiting for an answer");
});

test("an answer given in time still wins", async () => {
	const { instance } = gate(undefined, 5_000);
	const pending = instance.request({ ...request });
	// The person is there.
	await new Promise((r) => setTimeout(r, 10));
	const [entry] = instance.list();
	assert.ok(entry, "the question is waiting");
	instance.resolve(entry.id, "once");
	assert.equal(await pending, "once");
});
