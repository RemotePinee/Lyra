import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SideChat, type SideChatOptions } from "../src/runtime/sidechat.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = { id: "qa/model", modelId: "model", providerId: "qa", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: true, supportsTools: true };
const provider: ProviderConfig = { id: "qa", name: "QA", api: "anthropic-messages", baseUrl: "http://localhost", apiKey: "test", enabled: true, models: [model] };
const settings = { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id };
const question = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
function reply(text = "Answer"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: provider.api, provider: provider.id, model: model.modelId, stopReason: "stop", usage: emptyUsage(), timestamp: Date.now() };
}
async function fixture(t: TestContext, options: Pick<SideChatOptions, "streamFn" | "summaryStream" | "emit">) {
	const root = await mkdtemp(join(tmpdir(), "lyra-side-read-"));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, model.id);
	const main = new AgentSession({ cwd: root, store, meta, settings, emit: () => {} });
	t.after(async () => { await main.dispose(); await rm(root, { recursive: true, force: true }); });
	return { main, chat: new SideChat({ main, settings, ...options }) };
}

test("empty disk restore still supplies main history on the first side question", async (t) => {
	let seen = "";
	const { main, chat } = await fixture(t, { emit: () => {}, streamFn: async (context) => { seen = JSON.stringify(context); return reply(); } });
	await main.log.commit(question("EARLY_MAIN_FACT"));
	chat.restore([]);
	await chat.ask([{ type: "text", text: "What did we discuss?" }]);
	assert.match(seen, /EARLY_MAIN_FACT/);
	assert.equal(chat.messages.length, 2, "only side questions and answers belong to persisted side history");
});

test("long tool output remains readable and a completed answer is in state before message_end", async (t) => {
	let seen = "";
	let saved: Message[] = [];
	const { main, chat } = await fixture(t, { emit: (event) => { if (event.type === "message_end") saved = [...chat.state().messages]; }, streamFn: async (context) => { seen = JSON.stringify(context); return reply("SIDE_FINAL"); } });
	await main.log.commit({ role: "toolResult", toolName: "read", toolCallId: "read1", content: [{ type: "text", text: "a".repeat(900) + "TOOL_END_FACT" }], isError: false, timestamp: 1 });
	await chat.ask([{ type: "text", text: "What does the end say?" }]);
	assert.match(seen, /TOOL_END_FACT/);
	assert.match(JSON.stringify(saved), /SIDE_FINAL/);
});

test("restore and edit use fresh main history with the same number of messages", async (t) => {
	const seen: string[] = [];
	const { main, chat } = await fixture(t, { emit: () => {}, streamFn: async (context) => { seen.push(JSON.stringify(context)); return reply(); } });
	await main.log.commit(question("OLD_MAIN_FACT"));
	chat.restore([question("Old side question"), reply("Old side answer")]);
	await main.log.truncateFrom(0);
	await main.log.commit(question("REPLACED_MAIN_FACT"));
	await chat.editAndResend(0, [{ type: "text", text: "Edited side question" }]);
	assert.match(seen[0], /REPLACED_MAIN_FACT/);
	assert.doesNotMatch(seen[0], /OLD_MAIN_FACT|Old side answer/);
	assert.equal(chat.messages.length, 2);
});

test("restored compressed main history is queryable through the real side tool loop", async (t) => {
	let turns = 0;
	const { main, chat } = await fixture(t, { emit: () => {}, streamFn: async (context) => {
		if (turns++ === 0) {
			assert.doesNotMatch(JSON.stringify(context.messages), /PRE_COMPACTION_SECRET/);
			return { ...reply(), stopReason: "toolUse", content: [{ type: "toolCall", id: "lookup", name: "read_main_chat", arguments: { query: "PRE_COMPACTION_SECRET" } }] };
		}
		assert.match(JSON.stringify(context.messages), /PRE_COMPACTION_SECRET/);
		return reply("Recovered early history");
	} });
	const messages = [question("PRE_COMPACTION_SECRET"), ...Array.from({ length: 80 }, (_, index) => question(`${index}: ${"Main details. ".repeat(200)}`))];
	main.restore(messages, { summary: "Recent summary", keptFrom: messages.length - 4, at: 1 });
	chat.restore([{ ...question("Hidden main context from an old version"), synthetic: true }, question("Saved side question"), reply("Saved answer")]);
	assert.equal(chat.messages.length, 2);
	await chat.ask([{ type: "text", text: "Find an earlier decision" }]);
	assert.equal(turns, 2);
	assert.equal(main.messages.length, messages.length);
	assert.match(JSON.stringify(chat.messages), /Recovered early history/);
});

test("claiming the run precedes async emission, preventing two concurrent asks", async (t) => {
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { release = resolve; });
	let requests = 0;
	const { chat } = await fixture(t, { emit: async (event) => { if (event.type === "message_start" && event.message.role === "user") await paused; }, streamFn: async () => { requests++; return reply(); } });
	const first = chat.ask([{ type: "text", text: "one" }]);
	assert.equal(chat.running, true);
	const second = chat.ask([{ type: "text", text: "two" }]);
	release(); await Promise.all([first, second]);
	assert.equal(requests, 1); assert.equal(chat.messages.length, 2);
});

test("reset fences old callbacks and cannot erase the next run's busy state or answer", async (t) => {
	let releaseOld!: (message: AssistantMessage) => void;
	let oldStarted!: () => void;
	const started = new Promise<void>((resolve) => { oldStarted = resolve; });
	const old = new Promise<AssistantMessage>((resolve) => { releaseOld = resolve; });
	let turns = 0;
	const seen: string[] = [];
	const { chat } = await fixture(t, { emit: (event) => { seen.push(JSON.stringify(event)); }, streamFn: async () => {
		if (turns++ === 0) { oldStarted(); return old; }
		return reply("NEW_ANSWER");
	} });
	const first = chat.ask([{ type: "text", text: "old question" }]); await started;
	chat.reset();
	await chat.ask([{ type: "text", text: "new question" }]);
	releaseOld(reply("STALE_ANSWER")); await first;
	assert.equal(chat.running, false);
	assert.match(JSON.stringify(chat.messages), /NEW_ANSWER/);
	assert.doesNotMatch(JSON.stringify(chat.messages), /STALE_ANSWER|old question/);
	assert.doesNotMatch(seen.join("\n"), /STALE_ANSWER/);
});

test("long side history compacts once across follow-ups while retaining the full persisted conversation", async (t) => {
	let summaries = 0;
	const requests: number[] = [];
	const { chat } = await fixture(t, { emit: () => {}, summaryStream: async function* () {
		summaries++;
		const message = reply("Previous side questions and decisions retained.");
		yield { type: "done", message }; return message;
	}, streamFn: async (context) => { requests.push(JSON.stringify(context.messages).length); return reply("Follow-up answer"); } });
	const history = Array.from({ length: 200 }, (_, index) => index % 2 ? reply("old answer ".repeat(300)) : question("old question ".repeat(300)));
	chat.restore(history);
	await chat.ask([{ type: "text", text: "Follow up" }]);
	await chat.ask([{ type: "text", text: "Another follow-up" }]);
	assert.equal(summaries, 1, "a second question reuses the compacted reading instead of summarizing everything again");
	assert.equal(chat.messages.length, 204);
	assert.ok(requests.every((size) => size < 128000), JSON.stringify(requests));
});
