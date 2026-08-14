import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { TODOS_KEY, type TodoItem } from "../src/tools/todo.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
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

function base(): Omit<AssistantMessage, "content"> {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** The shape of the failure: a sentence about what comes next, and no tool call. */
const narrates = (text: string): AssistantMessage => ({ ...base(), content: [{ type: "text", text }] });

const callsTool = (): AssistantMessage => ({
	...base(),
	stopReason: "toolUse",
	content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {}, argumentsText: "{}" }],
});

const noop: Tool = {
	name: "noop",
	snippet: "does nothing",
	description: "does nothing",
	parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

function todos(...statuses: TodoItem["status"][]): TodoItem[] {
	return statuses.map((status, i) => ({ content: `step ${i}`, status }));
}

async function run(
	replies: AssistantMessage[],
	plan: TodoItem[],
	/** Lets a turn update the plan, the way `todo_write` would. */
	mutate?: (turn: number, state: Map<string, unknown>) => void,
) {
	const prompts: Message[][] = [];
	const state = new Map<string, unknown>([[TODOS_KEY, plan]]);
	let turn = 0;
	const result = await runAgent(
		{
			sessionId: "test",
			cwd: "/tmp",
			provider: PROVIDER,
			model: MODEL,
			systemPrompt: "",
			tools: [noop],
			messages: [{ role: "user", content: [{ type: "text", text: "do the work" }], timestamp: 1 }],
			maxTurns: 12,
			// The list the agent would have written with `todo_write`.
			state,
			streamFn: async (context) => {
				prompts.push([...context.messages]);
				mutate?.(turn, state);
				return replies[Math.min(turn++, replies.length - 1)];
			},
		},
		() => {},
	);
	return { result, prompts, turns: turn };
}

/** Mirrors `MAX_NUDGES` in the loop; the give-up point is part of the contract being tested. */
const MAX_NUDGES = 3;

const nudgeCount = (messages: Message[]) =>
	messages.filter((m) => m.role === "user" && m.content.some((c) => c.type === "text" && c.text.includes("自动继续")))
		.length;

test("narrating the next step with work outstanding does not end the run", async () => {
	// Talks once, is pushed, then finishes the plan properly and stops for real.
	const { result, turns } = await run(
		[narrates("后端完成，现在做前台页面"), narrates("全部做完了")],
		todos("completed", "pending"),
		(turn, state) => {
			if (turn === 1) state.set(TODOS_KEY, todos("completed", "completed"));
		},
	);

	assert.equal(turns, 2, "one extra turn, not more");
	assert.equal(nudgeCount(result.messages), 1, "exactly one nudge for one pause");
	assert.equal(result.reason, "done");
});

test("the nudge says what is left and asks for action, not a plan", async () => {
	const { result } = await run([narrates("接下来我会写测试"), narrates("done")], todos("completed", "pending", "pending"));
	const nudge = result.messages.find(
		(m) => m.role === "user" && m.content.some((c) => c.type === "text" && c.text.includes("自动继续")),
	);
	const text = nudge?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
	assert.match(text, /还有 2 项/, "it counts what actually remains");
	assert.match(text, /不要只描述计划/);
});

test("a finished plan is left alone", async () => {
	const { result, turns } = await run([narrates("all done")], todos("completed", "completed"));
	assert.equal(turns, 1);
	assert.equal(nudgeCount(result.messages), 0);
	assert.equal(result.reason, "done");
});

test("a conversation with no plan at all is never nudged", async () => {
	const { result, turns } = await run([narrates("hello")], []);
	assert.equal(turns, 1);
	assert.equal(nudgeCount(result.messages), 0);
});

test("a model that will not act is nudged a few times and then left", async () => {
	const { result } = await run([narrates("I will do it next")], todos("pending", "pending"));
	assert.equal(nudgeCount(result.messages), 3, "bounded rather than endless");
	assert.equal(result.reason, "done");
});

test("using a tool resets the allowance, so a later pause is still recovered", async () => {
	const script = [
		narrates("pausing once"),
		callsTool(),
		narrates("pausing again"),
		callsTool(),
		narrates("pausing a third time"),
		narrates("finished"),
	];
	const { result } = await run(script, todos("pending", "pending"));
	/*
	 * More than one allowance was spent, which is only possible if the tool calls reset it.
	 * The exact number is the script's business: once the replies run out the last one repeats,
	 * and with a plan that never completes it burns the final allowance down — which is the
	 * give-up path, tested above.
	 */
	assert.ok(nudgeCount(result.messages) > MAX_NUDGES, "a tool call must restore the allowance");
	assert.equal(result.reason, "done");
});
