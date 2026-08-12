/**
 * Context compaction.
 *
 * When history approaches the model's context window the oldest turns are replaced with a
 * summary. The summary is produced by the same model, because a cheap model summarising a
 * long technical trace loses exactly the details the agent needs (paths, symbol names,
 * failed attempts).
 */

import { streamAssistant } from "../ai/index.ts";
import { estimateTokens } from "../tokens.ts";
import type { Message, ModelConfig, ProviderConfig } from "../types.ts";

/** Start compacting at this fraction of the context window. */
const THRESHOLD = 0.8;
/** Keep this fraction of the window free for the summary plus the next turn. */
const TARGET = 0.5;
/** Recent turns are never summarised — the model needs them verbatim to keep working. */
const KEEP_RECENT = 6;

const SUMMARY_PROMPT = `Summarise the conversation above so another engineer can pick the work up with no other context.

Cover, in this order:
1. What the user asked for, including constraints and decisions they made.
2. Files read or modified, with paths, and what changed in each.
3. Commands run and what they showed — especially failures.
4. What is done, what is in progress, and what is left.
5. Anything tried that did not work, so it is not retried.

Be specific: real paths, real symbol names, real error text. Do not summarise the summary.`;

export async function compactIfNeeded(
	messages: Message[],
	model: ModelConfig,
	provider: ProviderConfig,
): Promise<Message[] | null> {
	const used = estimateTokens(messages);
	if (used < model.contextWindow * THRESHOLD) return null;
	if (messages.length <= KEEP_RECENT + 2) return null;

	// Never split an assistant message from the tool results that answer it: a tool_result
	// with no preceding tool_use is rejected by both APIs.
	let cut = messages.length - KEEP_RECENT;
	while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	if (cut <= 1) return null;

	const older = messages.slice(0, cut);
	const recent = messages.slice(cut);

	const summary = await summarize(older, model, provider);
	if (!summary) return null;

	const head: Message = {
		role: "user",
		content: [{ type: "text", text: `<session-summary>\n${summary}\n</session-summary>` }],
		timestamp: Date.now(),
		synthetic: true,
	};
	const acknowledgement: Message = {
		role: "assistant",
		content: [{ type: "text", text: "Understood. Continuing from that summary." }],
		api: provider.api,
		provider: provider.id,
		model: model.modelId,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const compacted = [head, acknowledgement, ...recent];
	// If summarising did not actually save anything, keep the original history.
	return estimateTokens(compacted) < used * TARGET ? compacted : null;
}

async function summarize(messages: Message[], model: ModelConfig, provider: ProviderConfig): Promise<string | null> {
	const stream = streamAssistant(
		provider,
		model,
		{
			systemPrompt: "You write handover summaries for an engineering session. Be dense and concrete.",
			messages: [...messages, { role: "user", content: [{ type: "text", text: SUMMARY_PROMPT }], timestamp: Date.now() }],
			tools: [],
		},
		{ thinking: "off", maxTokens: Math.min(8000, model.maxOutputTokens) },
	);

	let final: Awaited<ReturnType<typeof stream.next>>;
	do {
		final = await stream.next();
	} while (!final.done);

	const message = final.value;
	if (message.stopReason === "error" || message.stopReason === "aborted") return null;
	const text = message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	return text || null;
}
