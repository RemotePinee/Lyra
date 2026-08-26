/**
 * Reading back what compaction removed from the window.
 *
 * The central test here is the one that runs a session past its context window and then asks for
 * something that was in its very first message. That is the claim the whole compaction design rests
 * on: history leaves the window, it does not leave the session. Without it, summarising aggressively
 * would be a bet that the summary happened to keep whatever turns out to matter — and the safe
 * response to that bet is to summarise as little as possible, which is how a long session becomes
 * unaffordable.
 *
 * Real logs on disk throughout. The thing being tested is whether what was written can be found
 * again, and a fake store answers that question by assuming it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { recallTool } from "../src/tools/recall.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig, ToolContext } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 2_000,
	maxOutputTokens: 512,
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

const SETTINGS: Settings = {
	...DEFAULT_SETTINGS,
	providers: [PROVIDER],
	defaultModelId: MODEL.id,
	mcpServers: [],
	permissionMode: "full",
};

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

let home: string;
let previousHome: string | undefined;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-recall-"));
	// `recall` finds the log the way the app does: under LYRA_HOME, keyed by cwd and session id.
	previousHome = process.env.LYRA_HOME;
	process.env.LYRA_HOME = home;
});

after(async () => {
	if (previousHome === undefined) delete process.env.LYRA_HOME;
	else process.env.LYRA_HOME = previousHome;
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

function context(cwd: string, sessionId: string): ToolContext {
	return { cwd, sessionId, state: new Map() };
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

test("something compacted out of the window is still findable in the session", async () => {
	const cwd = await mkdtemp(join(home, "project-"));
	const seen: Message[][] = [];
	const events: AgentEvent[] = [];

	const session = new AgentSession({
		cwd,
		settings: SETTINGS,
		store: new SessionStore(),
		emit: (event) => {
			events.push(event);
		},
		streamFn: async (context) => {
			seen.push([...context.messages]);
			return reply("回复".repeat(400));
		},
	});
	await session.initialize();

	/*
	 * A word that appears exactly once, in the first thing said, and never again. Anything the
	 * summary happens to paraphrase would not prove the point — this has to be a detail the summary
	 * had no reason to keep.
	 */
	await session.prompt([{ type: "text", text: `记住这个口令：蜂鸟七号。${"，说详细些".repeat(60)}` }]);
	for (let i = 0; i < 6; i++) {
		await session.prompt([{ type: "text", text: `第 ${i} 个问题${"，说详细些".repeat(60)}` }]);
	}

	assert.ok(
		events.some((e) => e.type === "compacted"),
		"precondition: the window filled and compaction ran",
	);

	// It is genuinely out of the model's view — otherwise this test proves nothing.
	const last = seen[seen.length - 1];
	const visible = last
		.flatMap((m) => m.content)
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("\n");
	assert.ok(!visible.includes("蜂鸟七号"), "the pass phrase is no longer in the history being sent");

	// And it comes straight back.
	const result = await recallTool.execute({ query: "蜂鸟七号" }, context(cwd, session.meta.id));
	const text = textOf(result);
	assert.ok(text.includes("蜂鸟七号"), `recall finds it in the log:\n${text.slice(0, 400)}`);
	assert.match(text, /message \d+ · user/, "and says which message it was");
});

test("every term has to appear, so a second word narrows rather than widens", async () => {
	const cwd = await mkdtemp(join(home, "project-"));
	const store = new SessionStore();
	const session = new AgentSession({
		cwd,
		settings: SETTINGS,
		store,
		emit: () => {},
		streamFn: async () => reply("好"),
	});
	await session.initialize();

	await session.prompt([{ type: "text", text: "先看 alpha 的实现" }]);
	await session.prompt([{ type: "text", text: "再看 alpha 和 beta 一起用的地方" }]);

	const ctx = context(cwd, session.meta.id);
	const broad = textOf(await recallTool.execute({ query: "alpha" }, ctx));
	const narrow = textOf(await recallTool.execute({ query: "alpha beta" }, ctx));

	assert.match(broad, /^2 matches/, `both messages mention alpha:\n${broad.slice(0, 200)}`);
	assert.match(narrow, /^1 match /, `only one mentions both:\n${narrow.slice(0, 200)}`);
	assert.ok(narrow.includes("一起用的地方"), "and it is the right one");
});

test("a query that matches nothing says so, without pretending it failed", async () => {
	const cwd = await mkdtemp(join(home, "project-"));
	const session = new AgentSession({
		cwd,
		settings: SETTINGS,
		store: new SessionStore(),
		emit: () => {},
		streamFn: async () => reply("好"),
	});
	await session.initialize();
	await session.prompt([{ type: "text", text: "随便说点什么" }]);

	const result = await recallTool.execute({ query: "根本没提过的东西" }, context(cwd, session.meta.id));
	assert.ok(!result.isError, "an empty result is an answer, not an error");
	assert.match(textOf(result), /No message in this session contains/);
});

test("a long message is quoted head and tail, not in full", async () => {
	const cwd = await mkdtemp(join(home, "project-"));
	const session = new AgentSession({
		cwd,
		settings: SETTINGS,
		store: new SessionStore(),
		emit: () => {},
		streamFn: async () => reply("好"),
	});
	await session.initialize();

	/*
	 * The point of the cap: recalling must not cost more window than the summary saved, or the
	 * agent learns to be careful with the one tool that makes compaction safe.
	 */
	const long = `开头标记 ${"填充".repeat(3000)} 结尾标记`;
	await session.prompt([{ type: "text", text: long }]);

	const text = textOf(await recallTool.execute({ query: "开头标记" }, context(cwd, session.meta.id)));
	assert.ok(text.includes("开头标记"), "the head is there");
	assert.ok(text.includes("结尾标记"), "and so is the tail");
	assert.match(text, /characters omitted/, "with the middle accounted for");
	assert.ok([...text].length < [...long].length / 2, `and it is much shorter than the message (${[...text].length})`);
});

test("a session with nothing written down yet answers instead of throwing", async () => {
	const cwd = await mkdtemp(join(home, "project-"));
	const result = await recallTool.execute({ query: "任何东西" }, context(cwd, "no-such-session"));
	assert.equal(result.isError, true);
	assert.match(textOf(result), /no transcript on disk/);
});
