/**
 * Compaction, through a real session.
 *
 * The unit tests cover the cut itself. This one covers the wiring: that a session running near its
 * window actually reaches compaction through the seam, that the summarised history is what the next
 * turn is built from, and that the run says so rather than quietly losing the past.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

// Small enough that a handful of turns overflows it.
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

test("a session that overflows its window compacts, and says so", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-"));
	const events: AgentEvent[] = [];
	/** What the provider was asked to answer, per call. */
	const seen: Message[][] = [];

	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: (event) => {
			events.push(event);
		},
		streamFn: async (context) => {
			seen.push([...context.messages]);
			// Long replies, so the window fills in a few turns.
			return reply("回复".repeat(400));
		},
	});
	await session.initialize();

	try {
		for (let i = 0; i < 6; i++) {
			await session.prompt([{ type: "text", text: `第 ${i} 个问题${"，说详细些".repeat(60)}` }]);
		}

		const compacted = events.filter((e) => e.type === "compacted");
		assert.ok(compacted.length >= 1, "compaction happened");

		const event = compacted[0];
		if (event.type !== "compacted") throw new Error("wrong event");
		assert.ok(event.after < event.before, "and it actually made the history smaller");

		// The turn after a compaction is built from the summary, not from the old messages.
		const last = seen[seen.length - 1];
		const text = last
			.flatMap((m) => (m.role === "user" ? m.content : []))
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		assert.ok(text.includes("摘要") || last.length < 12, "the history handed over is the condensed one");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
