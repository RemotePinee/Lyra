/**
 * Which thinking levels a model is offered, and what gets sent when one is picked.
 *
 * The rule that matters is the order the rules are tried in. Vendor first, because the vendor is
 * whose API rejects the request: Google's returns HTTP 400 for `minimal`, and a rule matching a
 * bare `ultra` anywhere in an id used to reach past the Google check and hand `gemini-ultra` — a
 * real model — the GPT-5.6-sol set, `minimal` included.
 *
 * Nothing ever reached the wire wrong, because the effort mapping clamps as well. What was wrong
 * was the menu: 极简 and 低 both sent `low`, and 超高/最高/极致 all sent `high`. Four controls that
 * could not affect the thing they named.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelThinkingOptions, resolveReasoningEffort } from "../src/ai/thinking-options.ts";
import type { ModelConfig } from "../src/types/provider.ts";

const model = (modelId: string): ModelConfig => ({
	id: modelId,
	providerId: "p",
	modelId,
	name: modelId,
	contextWindow: 200_000,
	maxOutputTokens: 8192,
	supportsThinking: true,
});

const ids = (modelId: string) => resolveModelThinkingOptions(model(modelId)).map((option) => option.id);

/** What Google's API accepts, and nothing else. */
const GEMINI_SAFE = ["off", "low", "medium", "high"];

test("every Gemini variant is offered exactly the levels Google accepts", () => {
	for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.0-pro", "gemini-ultra", "gemini-3.0-ultra", "gemma-3"]) {
		assert.deepEqual(ids(id), GEMINI_SAFE, `${id} 的档位不对`);
	}
});

test("no Gemini model is ever offered a level its API rejects", () => {
	// The specific failure this is here for: `minimal` on a Google endpoint is an HTTP 400.
	for (const id of ["gemini-ultra", "gemini-3.0-ultra", "gemma-3-ultra"]) {
		const offered = ids(id);
		for (const forbidden of ["minimal", "xhigh", "max", "ultra"]) {
			assert.ok(!offered.includes(forbidden), `${id} 竟然给了 ${forbidden}`);
		}
	}
});

test("whatever is picked on a Gemini model, what goes out is one of three values", () => {
	// The clamp, which is the second line of defence and must keep working.
	const sent = new Set(
		["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((level) =>
			resolveReasoningEffort(level, model("gemini-ultra")),
		),
	);
	assert.deepEqual([...sent].sort(), ["high", "low", "medium"]);
});

test("GPT-5.6 and its ultra tier keep the levels they actually have", () => {
	assert.ok(ids("gpt-5.6").includes("max"), "GPT-5.6 应该有 max");
	assert.ok(!ids("gpt-5.6").includes("ultra"), "标准 GPT-5.6 没有 ultra");
	assert.ok(ids("gpt-5.6-sol").includes("ultra"), "sol 应该有 ultra");
	assert.ok(ids("gpt-5.6-ultra").includes("ultra"), "ultra 变体应该有 ultra");
});

test("a bare version number in some other model's name is not a GPT match", () => {
	// `id.includes("5.6")` matched this and handed it GPT-5.6's levels.
	assert.ok(!ids("llama-5.6b").includes("max"), "llama-5.6b 不该被当成 GPT-5.6");
});

test("a model nobody recognises is offered the levels everything supports", () => {
	/*
	 * The fallback used to be GPT-5.6's seven, so an unknown model was offered `minimal`, `xhigh`
	 * and `max` — and the effort mapping passes those through unchanged for an id it cannot place.
	 * Picking one sent a string the endpoint may reject, which is the exact failure this file is
	 * supposed to prevent.
	 */
	for (const id of ["llama-5.6b", "deepseek-v4", "some-model-nobody-has-heard-of"]) {
		assert.deepEqual(ids(id), GEMINI_SAFE, `${id} 应该拿到最保守的一组`);
	}
});

test("a conservative default does not silently downgrade a model that declares more", () => {
	// The escape hatch: configuration outranks inference, so nothing is capped that said otherwise.
	const rich = {
		...model("some-model-nobody-has-heard-of"),
		thinkingOptions: [{ id: "low" as const, label: "低" }, { id: "max" as const, label: "最高" }],
	};
	assert.deepEqual(resolveModelThinkingOptions(rich).map((o) => o.id), ["low", "max"]);
});

test("a model that declares its own levels is taken at its word", () => {
	const custom = { ...model("anything"), thinkingOptions: [{ id: "low" as const, label: "低" }] };
	assert.deepEqual(resolveModelThinkingOptions(custom).map((o) => o.id), ["low"]);
});

test("a model that cannot think is offered nothing", () => {
	assert.deepEqual(resolveModelThinkingOptions({ ...model("x"), supportsThinking: false }), []);
	assert.deepEqual(resolveModelThinkingOptions(null), []);
});

test("off means no effort parameter at all, not the string 'off'", () => {
	assert.equal(resolveReasoningEffort("off", model("gpt-5.6")), undefined);
	assert.equal(resolveReasoningEffort(undefined, model("gpt-5.6")), undefined);
});

test("Gemini models never receive effort none when thinking is off in openai-responses adapter", async () => {
	const { openaiResponsesProvider } = await import("../src/ai/openai-responses.ts");
	let capturedPayload: any = null;

	const mockFetch = async () => {
		// Return 400 immediately to terminate stream early
		return new Response(JSON.stringify({ error: { message: "mock" } }), { status: 400 });
	};

	const providerConfig = {
		id: "test",
		name: "test",
		baseUrl: "https://example.invalid",
		api: "openai-responses" as const,
		apiKey: "test",
		enabled: true,
		models: [],
	};

	// 1. Gemini model with thinking: "off"
	const geminiModel = {
		...model("gemini-3.7-flash-high"),
		supportsThinking: true,
	};

	const genGemini = openaiResponsesProvider.stream(
		providerConfig,
		geminiModel,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }], tools: [] },
		{
			thinking: "off",
			fetch: mockFetch as any,
			onPayload: (p) => {
				capturedPayload = p;
			},
		},
	);
	try {
		await genGemini.next();
	} catch {
		// Expected error from mockFetch
	}

	assert.ok(capturedPayload, "Payload should be sent");
	assert.equal(capturedPayload.reasoning, undefined, "Gemini with thinking: 'off' must not have reasoning property");

	// 2. OpenAI model with thinking: "off" should still have { reasoning: { effort: "none" } }
	const gptModel = {
		...model("gpt-5.6"),
		supportsThinking: true,
	};
	let capturedGptPayload: any = null;
	const genGpt = openaiResponsesProvider.stream(
		providerConfig,
		gptModel,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }], tools: [] },
		{
			thinking: "off",
			fetch: mockFetch as any,
			onPayload: (p) => {
				capturedGptPayload = p;
			},
		},
	);
	try {
		await genGpt.next();
	} catch {
		// Expected error from mockFetch
	}
	assert.ok(capturedGptPayload, "Payload should be sent for GPT");
	assert.deepEqual(capturedGptPayload.reasoning, { effort: "none" }, "GPT with thinking: 'off' retains effort: 'none'");
});
