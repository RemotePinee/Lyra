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
import { pruneToolResults } from "./prune.ts";
import { measureTotal } from "./context.ts";
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
const KEEP_BUDGET = 0.16;
/** Never fewer than this, however big they are: the agent cannot work without its last exchange. */
const KEEP_MIN = 4;
/**
 * What the conversation must weigh once compaction is done.
 *
 * Lower than the threshold that triggers it, and that gap is the whole point: coming back to just
 * under the trigger means the next few messages cross it again, so a long turn spends its time
 * summarising instead of working. Landing at 60% buys room for real work before the next pass.
 */
const SAFE_AFTER = 0.5;
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
	streamFn?: typeof streamAssistant,
	overhead = 0,
): Promise<Message[] | null> {
	if (strategy) return strategy.compact(messages, model, provider, streamFn);
	return compactIfNeeded(messages, model, provider, streamFn ?? streamAssistant, overhead);
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
	/**
	 * What the request carries besides the conversation: the system prompt and every tool schema.
	 *
	 * Passed in because it is fixed while the conversation is not, and conflating the two is what
	 * made compaction run forever. The measured total covers both, so deriving a per-message scale
	 * from it spreads the overhead across the messages — and then halving the conversation appears
	 * to halve the overhead too. It does not: the prompt and the schemas are sent in full every
	 * time. A conversation compacted against that arithmetic lands above the line it was aiming
	 * for, trips the threshold on the very next turn, and compacts again.
	 */
	overhead = 0,
): Promise<Message[] | null> {
	/*
	 * The provider's own count, not our estimate of it.
	 *
	 * `estimateTokens` is characters over 3.5. That is a fair average over English prose and code
	 * and badly low on CJK and on dense JSON — and it counts only the messages, while the request
	 * that has to fit also carries the system prompt, every tool schema and the skill catalogue.
	 * Both errors point the same way, so a conversation sitting at 200.7k of a 200k window reported
	 * something in the eighties and never crossed this line: the whole mechanism for staying inside
	 * the window was reading a number that could not reach its own threshold.
	 *
	 * `measureTotal` is what the context panel shows, so what triggers compaction is now the same
	 * figure the user is watching fill up. It falls back to the estimate before the first reply has
	 * landed, which is the only point at which there is nothing measured to use.
	 */
	const measured = measureTotal(messages);
	const used = measured.tokens;
	if (used < model.contextWindow * THRESHOLD) return null;

	/*
	 * Cut the oversized tool results first, and see whether that was enough.
	 *
	 * Cheapest thing first, and by a wide margin: cutting is string work, summarising is a model
	 * call that is slow, billed, and least reliable exactly when the window is tight. A conversation
	 * that has run three greps over a large repository is mostly those three results, so this alone
	 * routinely brings it back under the line — and when it does, no request is made at all.
	 *
	 * The measurement afterwards is an estimate of the saving rather than a fresh reading from the
	 * provider: nothing has been sent since, so there is no new `usage` to read. Subtracting what
	 * was removed from what was measured keeps the two in the same units.
	 */
	const pruned = pruneToolResults(messages);
	if (pruned !== messages) {
		const rawAll = estimateTokens(messages);
		const saved = Math.max(0, rawAll - estimateTokens(pruned));
		// Again on the conversation alone: the overhead is unaffected by cutting a tool result.
		const factor = measured.measured && rawAll > 0 ? Math.max(0, used - overhead) / rawAll : 1;
		if (used - saved * factor < model.contextWindow * THRESHOLD) return pruned;
		// Not enough on its own, but everything below now works on the smaller conversation.
		messages = pruned;
	}

	// Too short to have a past worth summarising, whatever it weighs.
	if (messages.length <= KEEP_MIN + 2) return messages === pruned ? pruned : null;

	/*
	 * The same correction applied per message, so the cut lands where it is meant to.
	 *
	 * The threshold above now uses the measured total, but the budget below is still spent one
	 * message at a time and there is no per-message figure from the provider to spend it against.
	 * Scaling the estimate by however wrong it was overall is the closest thing available — and
	 * without it the two halves disagree: on a conversation the estimator reads at a third of its
	 * real size, "keep the most recent 30%" keeps very nearly everything, and the summary replaces
	 * a stretch too small to be worth the request.
	 */
	/*
	 * The correction applies to the messages alone, never to the overhead.
	 *
	 * `used` is the whole request as the provider counted it — prompt, schemas and history — and
	 * `raw` estimates only the history. Dividing one by the other and calling it a per-message
	 * factor bakes a constant into a variable.
	 */
	const raw = estimateTokens(messages);
	const conversation = Math.max(0, used - overhead);
	const scale = measured.measured && raw > 0 ? conversation / raw : 1;

	// Keep recent turns until their budget is spent, then cut — never between an assistant
	// message and the tool results answering it, which both APIs reject.
	const keepBudget = model.contextWindow * KEEP_BUDGET;
	let cut = messages.length;
	let kept = 0;
	while (cut > 1) {
		const next = estimateTokens([messages[cut - 1]]) * scale;
		if (messages.length - cut >= KEEP_MIN && kept + next > keepBudget) break;
		kept += next;
		cut--;
	}
	while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	if (cut <= 1) return null;

	const older = messages.slice(0, cut);
	const recent = messages.slice(cut);

	const summary = await summarize(older, model, provider, streamFn);
	if (!summary) return dropOldest(messages, model, overhead, scale);

	/*
	 * What the user actually asked for, carried across verbatim.
	 *
	 * A summary is a paraphrase, and the thing that survives paraphrase worst is an instruction. A
	 * conversation that began 「先找原因先别修改代码」 and later said 「那进行彻底的修复」 has two
	 * instructions that contradict each other on purpose — the second supersedes the first — and a
	 * summary written from both is as likely to carry the first. The turn after compaction then
	 * explains why it has not started, and it is right about the history it was handed.
	 *
	 * So the newest thing a person typed is quoted rather than described. Only when it fell inside
	 * the summarised span: if it is still in the tail it is already there in full, and repeating it
	 * would be the same instruction twice with nothing to say which is current.
	 */
	const standing = lastRequest(older);
	const head: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: standing
					? `<session-summary>\n${summary}\n</session-summary>\n\n<standing-request>\nThis is the most recent thing the user asked for, quoted exactly. It is current and supersedes anything in the summary above that disagrees with it.\n\n${standing}\n</standing-request>`
					: `<session-summary>\n${summary}\n</session-summary>`,
			},
		],
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

	/*
	 * Keep dropping the oldest of what was kept until the result actually fits.
	 *
	 * This used to end at "any reduction is worth keeping" — build the replacement, check it was
	 * smaller than what it replaced, and hand it back. Smaller is not the requirement. A window at
	 * 277k that compacts to 250k has been compacted and still cannot be sent, and the next turn
	 * arrives at a conversation that is over the line with nothing left to try. Shrinking was being
	 * treated as success when the only success is fitting.
	 *
	 * So the target is absolute, and the loop converges on it. The summary is written once — that
	 * is the part that costs a request — and what varies afterwards is how much of the recent tail
	 * is kept beside it, which costs nothing to reconsider.
	 *
	 * Tool results are dropped with the call they answer. Sending one without the other is rejected
	 * by both APIs, so a cut in the middle of a pair is not a smaller conversation, it is a failed
	 * request.
	 */
	/*
	 * What the conversation may weigh, which is the window's share minus what is spent before it.
	 *
	 * The overhead is paid on every request whatever the history looks like, so the budget the
	 * summary and the tail have to fit inside is the remainder — not the whole window.
	 */
	const target = Math.max(0, model.contextWindow * SAFE_AFTER - overhead);
	const scaled = (list: Message[]) => estimateTokens(list) * scale;

	let kept_ = recent;
	let compacted = [head, acknowledgement, ...kept_];
	while (scaled(compacted) > target && kept_.length > 1) {
		let drop = 1;
		// Never leave a tool result whose call has just been dropped.
		while (drop < kept_.length && kept_[drop].role === "toolResult") drop++;
		kept_ = kept_.slice(drop);
		compacted = [head, acknowledgement, ...kept_];
	}

	/*
	 * A summary that did not shrink anything is not worth the message it arrived in.
	 *
	 * Compared in one unit — the scaled estimate — because the alternative was comparing an
	 * estimate against a measured total, where the estimator's own error decided the answer.
	 */
	return scaled(compacted) < scaled(messages) ? compacted : null;
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

	/*
	 * A failed request here is a declined summary, not a failed turn.
	 *
	 * The stream throws on a dropped socket and on an HTTP error, and nothing caught it — so a
	 * relay answering 503 did not merely leave the conversation uncompacted, it took the whole turn
	 * down from inside the step that was trying to make the turn possible. Retrying then failed the
	 * same way, at the same point, for as long as the relay stayed down.
	 *
	 * The caller's answer to `null` is to drop the oldest turns instead, which needs no request at
	 * all. That is the right outcome when the summariser is unreachable: less history, but a turn
	 * that can be sent.
	 */
	let final: Awaited<ReturnType<typeof stream.next>>;
	try {
		do {
			final = await stream.next();
		} while (!final.done);
	} catch {
		return null;
	}

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

/**
 * The newest thing a person actually typed in this stretch of conversation.
 *
 * Synthetic messages are excluded: the runtime's own nudges — "continue", the summary head from a
 * previous compaction — are not requests, and treating one as the standing instruction would pin
 * the conversation to a sentence nobody wrote.
 *
 * Text only, and bounded. An instruction is prose; the image pasted with it has already been
 * summarised along with everything else, and quoting a screenshot back in full would undo the
 * saving this whole pass exists for.
 */
function lastRequest(messages: Message[], limit = 2000): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" || message.synthetic) continue;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) continue;
		const points = [...text];
		return points.length <= limit ? text : `${points.slice(0, limit).join("")}…`;
	}
	return null;
}

/**
 * Getting under the line without a model, for when the summary could not be had.
 *
 * Summarising is a request, and a request fails — the relay is out of credentials, the key is
 * refused, the turn is cancelled. Answering that with `null` reads as "no compaction was needed",
 * and the caller carries on with a conversation that is over the window. The next turn measures the
 * same overfull history, asks for the same summary, and fails the same way. That is a conversation
 * pinned at its limit, spending a request per turn to stay there, which is exactly what a full
 * window feels like from the outside: it says it is compacting and nothing ever changes.
 *
 * Losing the oldest exchanges outright is worse than summarising them and better than every
 * alternative on offer here, because the alternative is a turn that cannot be sent at all. The
 * transcript keeps everything; what is dropped is what gets *replayed* to the model.
 *
 * Cuts on whole units. A tool result whose call has been dropped is rejected by both APIs, so a
 * boundary in the middle of a pair would turn one unsendable request into another.
 */
function dropOldest(messages: Message[], model: ModelConfig, overhead: number, scale: number): Message[] | null {
	const target = Math.max(0, model.contextWindow * SAFE_AFTER - overhead);
	const weight = (list: Message[]) => estimateTokens(list) * scale;

	let start = 0;
	while (start < messages.length - 1 && weight(messages.slice(start)) > target) {
		start++;
		// Never begin on an answer whose question has just been dropped.
		while (start < messages.length && messages[start].role === "toolResult") start++;
	}
	if (start === 0) return null;

	/*
	 * A marker in place of what went, because silence here is its own bug.
	 *
	 * Without it the conversation simply begins in the middle, and a model with no idea that
	 * anything preceded it will cheerfully re-derive work that was already done. Saying that the
	 * history was dropped rather than summarised is also the honest account: no one read it.
	 */
	const notice: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: "<dropped-history>\nEarlier turns were removed to fit the context window. Summarising them was not possible, so they are gone rather than condensed — do not assume anything about what came before. Ask, or re-read the files you need.\n</dropped-history>",
			},
		],
		timestamp: Date.now(),
		synthetic: true,
	};
	return [notice, ...messages.slice(start)];
}
