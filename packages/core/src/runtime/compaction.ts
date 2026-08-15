/**
 * Context compaction.
 *
 * When history approaches the model's context window the oldest turns are replaced with a
 * summary. The summary is produced by the same model, because a cheap model summarising a
 * long technical trace loses exactly the details the agent needs (paths, symbol names,
 * failed attempts).
 */

import type { CompactionStrategy } from "../kernel/services.ts";
import { streamAssistant } from "../ai/index.ts";
import { estimateTokens } from "../tokens.ts";
import type { Message, ModelConfig, ProviderConfig } from "../types.ts";

/** Start compacting at this fraction of the context window. */
const THRESHOLD = 0.8;
/**
 * The most recent turns are kept verbatim, but by size rather than by count.
 *
 * Six messages is a small tail in a conversation of short replies and an enormous one when a
 * single tool result is a whole file. Counting messages meant the "recent" slice could be larger
 * than the window on its own, at which point compacting saved nothing and was abandoned — so the
 * conversation sailed past the limit with nothing to stop it.
 */
const KEEP_BUDGET = 0.3;
/** Never fewer than this, however big they are: the agent cannot work without its last exchange. */
const KEEP_MIN = 4;
/**
 * How much of the window the summary request itself may occupy.
 *
 * The history being summarised is by definition close to the window — sending it whole asks the
 * model to read more than it can hold, and the request fails. It fails silently, too: a failed
 * summary means "do not compact", so the one mechanism for staying inside the window switched
 * itself off exactly when it was needed. The older turns are condensed to fit this budget first.
 */
const SUMMARY_INPUT = 0.4;

const SUMMARY_PROMPT = `Summarise the conversation above so another engineer can pick the work up with no other context.

Cover, in this order:
1. What the user asked for, including constraints and decisions they made.
2. Files read or modified, with paths, and what changed in each.
3. Commands run and what they showed — especially failures.
4. What is done, what is in progress, and what is left.
5. Anything tried that did not work, so it is not retried.

Be specific: real paths, real symbol names, real error text. Do not summarise the summary.`;

/**
 * Which strategy is in force.
 *
 * Bound by the host at boot; unbound everywhere else, where the built-in answer is the right one.
 * Callers go through `compactWith` so that replacing the strategy is a plugin, not an edit to the
 * loop that runs out of room.
 */
let strategy: CompactionStrategy | null = null;

export function useCompaction(next: CompactionStrategy | null): void {
	strategy = next;
}

export function compactWith(
	messages: Message[],
	model: ModelConfig,
	provider: ProviderConfig,
): Promise<Message[] | null> {
	if (strategy) return strategy.compact(messages, model, provider);
	return compactIfNeeded(messages, model, provider);
}

export async function compactIfNeeded(
	messages: Message[],
	model: ModelConfig,
	provider: ProviderConfig,
	/**
	 * How to reach the model, injected so this can be exercised without one.
	 *
	 * Compaction is hard to observe in the wild — it happens once, deep in a long run, and the
	 * evidence is that a number went down. Being able to drive it directly is the only way to
	 * know the cut lands where it should.
	 */
	streamFn: typeof streamAssistant = streamAssistant,
): Promise<Message[] | null> {
	const used = estimateTokens(messages);
	if (used < model.contextWindow * THRESHOLD) return null;
	// Too short to have a past worth summarising, whatever it weighs.
	if (messages.length <= KEEP_MIN + 2) return null;

	// Keep recent turns until their budget is spent, then cut — never between an assistant
	// message and the tool results answering it, which both APIs reject.
	const keepBudget = model.contextWindow * KEEP_BUDGET;
	let cut = messages.length;
	let kept = 0;
	while (cut > 1) {
		const next = estimateTokens([messages[cut - 1]]);
		if (messages.length - cut >= KEEP_MIN && kept + next > keepBudget) break;
		kept += next;
		cut--;
	}
	while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	if (cut <= 1) return null;

	const older = messages.slice(0, cut);
	const recent = messages.slice(cut);

	const summary = await summarize(older, model, provider, streamFn);
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
	/*
	 * Any reduction is worth keeping.
	 *
	 * This used to insist on halving the history and throw the summary away otherwise — which
	 * meant the times it saved 40% were treated the same as the times it failed, and the next
	 * turn arrived at a history that was larger still. Smaller is the goal; how much smaller is
	 * whatever the conversation allows.
	 */
	return estimateTokens(compacted) < used ? compacted : null;
}

async function summarize(
	messages: Message[],
	model: ModelConfig,
	provider: ProviderConfig,
	streamFn: typeof streamAssistant,
): Promise<string | null> {
	const stream = streamFn(
		provider,
		model,
		{
			systemPrompt: "You write handover summaries for an engineering session. Be dense and concrete.",
			messages: [
				...condense(messages, model.contextWindow * SUMMARY_INPUT),
				{ role: "user", content: [{ type: "text", text: SUMMARY_PROMPT }], timestamp: Date.now() },
			],
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

/**
 * Shrink a history to fit a token budget by trimming each message rather than dropping any.
 *
 * Dropping whole messages would lose whole steps — the file that was edited, the command that
 * failed — and those are exactly what the summary is for. Every message keeps its head and its
 * tail instead: the head says what was being attempted, the tail says how it turned out, and
 * the middle of a 900-line file is what nobody needs in a summary of the work.
 */
function condense(messages: Message[], budget: number): Message[] {
	if (estimateTokens(messages) <= budget) return messages;
	// Characters, since that is what the estimate is derived from.
	const perMessage = Math.max(200, Math.floor((budget * 3.5) / Math.max(1, messages.length)));

	return messages.map((message) => ({
		...message,
		content: message.content.map((part) => {
			if (part.type === "text") return { ...part, text: clip(part.text, perMessage) };
			if (part.type === "thinking") return { ...part, thinking: clip(part.thinking, Math.floor(perMessage / 3)) };
			if (part.type === "toolCall") {
				return { ...part, argumentsText: clip(part.argumentsText ?? "", perMessage), arguments: {} };
			}
			return part;
		}),
	})) as Message[];
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.7);
	const tail = limit - head;
	return `${text.slice(0, head)}\n…（省略 ${text.length - limit} 字）…\n${text.slice(-tail)}`;
}
