import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig } from "../src/types.ts";
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

interface Harness {
	session: AgentSession;
	events: AgentEvent[];
	/** Every prompt the scripted provider was asked to answer, in order. */
	turns: string[];
	settle(): Promise<void>;
	cleanup(): Promise<void>;
}

/**
 * A session wired to a scripted provider.
 *
 * `duringTurn` runs while the model is "thinking", which is the only moment a task can be
 * dispatched into a session that is genuinely busy — the case the queue exists for.
 */
async function harness(duringTurn?: (session: AgentSession) => void): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "dw-task-"));
	const store = new SessionStore(join(root, "sessions"));
	const events: AgentEvent[] = [];
	const turns: string[] = [];

	const session: AgentSession = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store,
		emit: (event) => {
			events.push(event);
		},
		streamFn: async (context) => {
			const last = [...context.messages].reverse().find((m) => m.role === "user");
			turns.push(last && last.role === "user" ? textOf(last.content) : "");
			duringTurn?.(session);
			return reply("ok");
		},
	});
	await session.initialize();

	return {
		session,
		events,
		turns,
		/** Wait for the session and its queue to go quiet, since draining is not awaited. */
		async settle() {
			for (let i = 0; i < 400; i++) {
				const pending = session.taskQueue.some((t) => t.status === "queued" || t.status === "running");
				if (!session.running && !pending) return;
				await new Promise((r) => setTimeout(r, 5));
			}
			throw new Error("the queue never settled");
		},
		/*
		 * Retried, because `abort` returns before the log does.
		 *
		 * Stopping a session resolves its pending approvals and cancels the queue immediately,
		 * but the append that records the last message is already in flight and lands a tick
		 * later — straight into the directory being removed.
		 */
		cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
	};
}

function textOf(content: { type: string; text?: string }[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

test("a task dispatched into an idle session runs straight away", async () => {
	const h = await harness();
	try {
		await h.session.enqueueTask("查一下构建为什么慢");
		await h.settle();

		assert.deepEqual(h.turns, ["查一下构建为什么慢"]);
		assert.equal(h.session.taskQueue[0].status, "done");
	} finally {
		await h.cleanup();
	}
});

test("a task dispatched mid-turn waits for the turn to finish, then runs", async () => {
	let dispatched = false;
	const h = await harness((session) => {
		if (dispatched) return;
		dispatched = true;
		void session.enqueueTask("接着把测试补上");
	});
	try {
		await h.session.prompt([{ type: "text", text: "先重构这个模块" }]);
		await h.settle();

		assert.deepEqual(
			h.turns,
			["先重构这个模块", "接着把测试补上"],
			"the dispatched task must run after the work it was queued behind, not inside it",
		);
		assert.equal(h.session.taskQueue[0].status, "done");
	} finally {
		await h.cleanup();
	}
});

test("a dispatched task is marked as such in the transcript", async () => {
	const h = await harness();
	try {
		await h.session.enqueueTask("跑一下 lint");
		await h.settle();

		const user = h.session.messages.find((m) => m.role === "user");
		assert.equal(user?.role, "user");
		assert.equal(
			user?.role === "user" ? user.origin : undefined,
			"side-chat",
			"without this the user finds an instruction they never wrote, in their own voice",
		);
	} finally {
		await h.cleanup();
	}
});

test("a queued task can be withdrawn before it starts", async () => {
	let dispatched = false;
	let queuedId: string | null = null;
	const h = await harness((session) => {
		if (dispatched) return;
		dispatched = true;
		void session.enqueueTask("这个不该跑").then((task) => {
			queuedId = task.id;
			void session.cancelTask(task.id);
		});
	});
	try {
		await h.session.prompt([{ type: "text", text: "干点别的" }]);
		await h.settle();

		assert.deepEqual(h.turns, ["干点别的"], "a withdrawn task must never reach the model");
		assert.equal(h.session.taskQueue.find((t) => t.id === queuedId)?.status, "cancelled");
	} finally {
		await h.cleanup();
	}
});

test("stopping the session empties the queue rather than carrying on", async () => {
	let dispatched = false;
	const h = await harness((session) => {
		if (dispatched) return;
		dispatched = true;
		void session.enqueueTask("排在后面的活");
	});
	try {
		await h.session.prompt([{ type: "text", text: "开始" }]);
		// The task is queued by now; pressing stop must not leave it to run afterwards.
		h.session.abort();
		await h.settle();

		assert.deepEqual(h.turns, ["开始"], "stop means stop, including work waiting behind the turn");
		assert.equal(h.session.taskQueue[0].status, "cancelled");
	} finally {
		await h.cleanup();
	}
});

test("the queue is broadcast on every change", async () => {
	const h = await harness();
	try {
		await h.session.enqueueTask("做点事");
		await h.settle();

		const queues = h.events.filter((e): e is Extract<AgentEvent, { type: "tasks" }> => e.type === "tasks");
		assert.ok(queues.length >= 3, "queued, running and settled are each worth announcing");
		assert.equal(queues[0].tasks[0].status, "queued");
		assert.equal(queues[queues.length - 1].tasks[0].status, "done");
	} finally {
		await h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The model is settled by the first message
// ---------------------------------------------------------------------------

test("the model can still be chosen while the conversation is empty", async () => {
	const h = await harness();
	try {
		const changed = await h.session.setModel("fake/other");
		assert.equal(changed, true);
		assert.equal(h.session.meta.modelId, "fake/other");
	} finally {
		await h.cleanup();
	}
});

test("changing the model is refused once there is history to replay", async () => {
	const h = await harness();
	try {
		await h.session.prompt([{ type: "text", text: "开始" }]);
		const before = h.session.meta.modelId;

		const changed = await h.session.setModel("fake/other");
		assert.equal(changed, false, "stored messages carry handles another model cannot replay");
		assert.equal(h.session.meta.modelId, before, "and the refusal must leave the model as it was");
	} finally {
		await h.cleanup();
	}
});
