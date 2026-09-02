/**
 * A conversation's own reasoning level.
 *
 * Asserted on what actually reaches the provider rather than on what the meta says, because those
 * are two different claims and only the second one is the feature: a level stored perfectly and
 * never read would look right everywhere except in the bill.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig, ThinkingLevel } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: true,
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
	thinking: "medium",
};

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Two sessions over one store, and a record of what each turn asked the provider for.
 *
 * Two because the whole point is that they are separate; one store because in the app they share
 * one, and a bug that leaks through the store would be invisible with two.
 */
async function harness(settings: Settings = SETTINGS) {
	const root = await mkdtemp(join(tmpdir(), "ly-think-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.LYRA_HOME = home;

	const asked: (ThinkingLevel | undefined)[] = [];
	const store = new SessionStore(join(root, "sessions"));
	const make = async () => {
		const session = new AgentSession({
			cwd: root,
			settings,
			store,
			emit: () => {},
			// `(context, config)`; the level the turn resolved to is on the config.
			streamFn: async (_context, config) => {
				asked.push(config.thinking);
				return reply();
			},
		});
		await session.initialize();
		return session;
	};

	return {
		store,
		asked,
		make,
		/** The last level handed to the provider. */
		last: () => asked[asked.length - 1],
		cleanup: async () => {
			delete process.env.LYRA_HOME;
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

test("with nothing chosen, a turn runs at the app default", async () => {
	const h = await harness();
	try {
		const session = await h.make();
		await session.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "medium");
		assert.equal(session.meta.thinking, undefined, "a level nobody chose is not written down");
	} finally {
		await h.cleanup();
	}
});

test("a chosen level is what the next turn asks for", async () => {
	const h = await harness();
	try {
		const session = await h.make();
		await session.setThinking("high");
		await session.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "high");
	} finally {
		await h.cleanup();
	}
});

test("one conversation's level does not reach another", async () => {
	const h = await harness();
	try {
		const a = await h.make();
		const b = await h.make();
		await a.setThinking("high");

		await a.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "high");

		await b.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "medium", "the other conversation is still on the app default");

		// And back again, so this is not just about ordering.
		await a.prompt([{ type: "text", text: "again" }]);
		assert.equal(h.last(), "high");
	} finally {
		await h.cleanup();
	}
});

test("the level survives a restart, because it is in the log", async () => {
	const h = await harness();
	try {
		const session = await h.make();
		await session.setThinking("xhigh");

		// A second session over the same log is what reopening the conversation does.
		const reopened = new AgentSession({
			cwd: process.cwd(),
			settings: SETTINGS,
			store: h.store,
			emit: () => {},
			meta: session.meta,
		});
		const loaded = await h.store.load(session.meta.projectId, session.meta.id);
		assert.equal(loaded?.meta.thinking, "xhigh", "written to the file, not just held in memory");
		assert.equal(reopened.meta.thinking, "xhigh");
	} finally {
		await h.cleanup();
	}
});

test("null hands the conversation back to the app default", async () => {
	const h = await harness();
	try {
		const session = await h.make();
		await session.setThinking("high");
		await session.setThinking(null);
		await session.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "medium");
		assert.equal(session.meta.thinking, undefined, "cleared, not pinned to today's default");

		const loaded = await h.store.load(session.meta.projectId, session.meta.id);
		assert.equal(loaded?.meta.thinking, undefined, "and cleared on disk too");
	} finally {
		await h.cleanup();
	}
});

test("a level asked for by the caller still wins, for the one turn", async () => {
	const h = await harness();
	try {
		const session = await h.make();
		await session.setThinking("high");
		await session.prompt([{ type: "text", text: "hi" }], { thinking: "off" });
		assert.equal(h.last(), "off");

		// The conversation's own level is not consumed by that override.
		await session.prompt([{ type: "text", text: "again" }]);
		assert.equal(h.last(), "high");
	} finally {
		await h.cleanup();
	}
});

test("moving the app default moves the sessions that never chose, and only those", async () => {
	const h = await harness();
	try {
		const chosen = await h.make();
		const untouched = await h.make();
		await chosen.setThinking("low");

		const raised: Settings = { ...SETTINGS, thinking: "high" };
		chosen.updateSettings(raised);
		untouched.updateSettings(raised);

		await untouched.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "high", "it never had an opinion, so it follows the default");

		await chosen.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "low", "it had one, so the default does not overrule it");
	} finally {
		await h.cleanup();
	}
});

test("switching the model leaves the level alone", async () => {
	const h = await harness();
	try {
		const session = await h.make();
		await session.setThinking("high");
		await session.setModel(MODEL.id);
		await session.prompt([{ type: "text", text: "hi" }]);
		assert.equal(h.last(), "high", "a meta write for one field must not drop the other");
	} finally {
		await h.cleanup();
	}
});
