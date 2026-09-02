/**
 * Where one row of the transcript ends and the next begins, decided on plain data.
 *
 * The transcript is not the message list. A stretch of tool work is one line however many
 * messages it took, and it has to be the *same* line from the first call to the last. A group
 * that only forms once the model stops talking is a group that appears mid-turn, pushes what is
 * under it down, and then hands its contents to the row above and vanishes — which is what made
 * the transcript move while the agent worked.
 *
 * So the rule here never asks whether a message has finished. It reads what has arrived, and
 * what has arrived only ever grows.
 */

import type { AssistantContent, AssistantMessage, Message, UserContent } from "@lyra/core";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

/** A call together with the state of the message that made it: a call is live only while its turn is. */
export type Call = { block: ToolCallBlock; stopReason: AssistantMessage["stopReason"] };

export type Run =
	| { kind: "compaction" }
	/**
	 * A message, and how much of it is this row's.
	 *
	 * `upTo` is a count of content blocks: everything from there to the end is tool work, which
	 * belongs to the run below rather than to the reply. It is the whole message whenever the
	 * message has no trailing calls, which is most of them.
	 *
	 * `turnStats` rides along for assistant rows. It used to be computed where the row is drawn,
	 * which meant a fresh object per render — so `MessageRow`'s memo compared unequal every time
	 * and every visible reply was rebuilt whenever anything re-rendered the transcript. Computed
	 * here it is derived from the messages alone, which is what it is a fact about, and its
	 * identity changes exactly when the transcript does.
	 */
	| { kind: "message"; message: Message; index: number; upTo: number; turnStats?: TurnStats }
	| { kind: "tools"; calls: Call[] };

/** The runtime's "carry on" message, recognised by what it says as well as by its flag. */
export function isNudge(message: Message | undefined): boolean {
	if (message?.role !== "user") return false;
	return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
}

export type TurnStats = {
	durationMs: number;
	sseDurationMs: number;
	outputTokens: number;
	requestCount: number;
};

/**
 * Calculates accumulated turn statistics (total duration in ms, sse output duration in ms, total output tokens, total requests)
 * for the turn that ends at or before `endMessageIndex`.
 *
 * A turn consists of:
 * - Assistant messages (including toolUse calls, intermediate thought steps, and the final response).
 * - Tool result messages and continuation nudges between them.
 * The turn starts immediately after the previous real (non-synthetic, non-nudge) user message.
 */
/** A turn that has spent nothing yet. */
function noStats(): TurnStats {
	return { durationMs: 0, sseDurationMs: 0, outputTokens: 0, requestCount: 0 };
}

/**
 * Add one reply's cost to a running total, and hand back a new object.
 *
 * New rather than mutated: these are handed to a memoised row, and a total that changes in place
 * is one React is entitled to decide has not changed at all.
 */
function accumulate(into: TurnStats, message: AssistantMessage): TurnStats {
	const duration = typeof message.durationMs === "number" && message.durationMs > 0 ? message.durationMs : 0;
	const sse = typeof message.sseDurationMs === "number" && message.sseDurationMs > 0 ? message.sseDurationMs : 0;
	const output = typeof message.usage?.output === "number" && message.usage.output > 0 ? message.usage.output : 0;
	return {
		durationMs: into.durationMs + duration,
		// Fallback when sseDurationMs was not recorded (e.g. older messages on disk).
		sseDurationMs: into.sseDurationMs + (sse || duration),
		outputTokens: into.outputTokens + output,
		requestCount: into.requestCount + 1,
	};
}

/**
 * The wordings 「继续」 sends, which are the same act as an automatic nudge.
 *
 * Exported and imported by `ResumeRow` rather than written out twice: two copies of a sentence
 * that has to match exactly is a mismatch waiting for the day somebody improves the wording.
 */
export const CARRY_ON_PROMPTS = [
	"继续，从暂停的地方接着做。",
	"继续，从中断的地方接着做。",
	"继续，把清单里没做完的做完。",
] as const;

/** The text of a user message, joined. */
function userText(message: Message): string {
	if (message.role !== "user") return "";
	return message.content
		.filter((c): c is Extract<UserContent, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/**
 * Whether this message is picking up a turn that stopped, rather than beginning one.
 *
 * Pressing 继续 after a failure is not a new question — it is the same piece of work, carried on
 * across the break. Counting it as a new turn is what made the timings meaningless: a task that
 * took twenty minutes and was interrupted twice reported the length of its last leg, and the tokens
 * of its last leg, so neither the elapsed time nor the tokens-per-second described anything that
 * actually happened.
 *
 * Only when the reply before it actually stopped. The same sentence typed into a conversation that
 * ended normally is a new instruction and starts a new turn, which is the honest reading of it.
 */
function resumesTurn(messages: Message[], index: number): boolean {
	const message = messages[index];
	if (!message || message.role !== "user") return false;
	if (!CARRY_ON_PROMPTS.includes(userText(message) as (typeof CARRY_ON_PROMPTS)[number])) return false;
	for (let i = index - 1; i >= 0; i--) {
		const previous = messages[i];
		if (previous.role === "toolResult") continue;
		if (previous.role !== "assistant") return false;
		// The two ways a reply stops short: it failed, or it was stopped. Both leave work unfinished
		// and are what 继续 exists to pick up.
		return previous.stopReason === "error" || previous.stopReason === "aborted";
	}
	return false;
}

/** Whether this message is a person starting a turn, rather than the runtime keeping one going. */
function opensTurn(message: Message): boolean {
	return message.role === "user" && !message.synthetic && !isNudge(message);
}

export function computeTurnStats(messages: Message[], endMessageIndex: number): TurnStats {
	// Walk backwards from endMessageIndex until we hit a real user message or index 0
	let startIndex = 0;
	for (let i = endMessageIndex; i >= 0; i--) {
		// A 继续 after a failure belongs to the turn it is continuing, so the walk goes on past it
		// to the question that actually started the work.
		if (opensTurn(messages[i]) && !resumesTurn(messages, i)) {
			startIndex = i + 1;
			break;
		}
	}

	let stats = noStats();
	for (let i = startIndex; i <= endMessageIndex && i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") stats = accumulate(stats, msg);
	}
	return stats;
}

/**
 * How far into a reply the model was still addressing you.
 *
 * Counted to the end of the last block of actual text. Everything after it is the model working,
 * and work joins the work around it — the sentence that introduces a batch of calls and the calls
 * themselves are one thought, and the next batch continues it. Text is the one thing that ends a
 * run, because that is the model stopping to say something and a group must not swallow it.
 *
 * Whether the message is still streaming is deliberately not consulted. That answer changes
 * halfway through a turn, and any grouping derived from it changes with it.
 */
/** Whether any reasoning has arrived — the live ticker's reason to have a row. */
function reasoning(content: AssistantContent[]): boolean {
	return content.some((block) => block.type === "thinking" && block.thinking.length > 0);
}

/**
 * Which reply's reasoning the live row shows, or -1 for none.
 *
 * Not simply the last reply's. A reply begins as an empty message, and its reasoning follows a
 * beat later — with a real model, often several hundred milliseconds later. Keyed to the last
 * reply, the row emptied for exactly that beat at the start of every reply in the turn: the
 * previous reasoning gone, the next not yet there, and everything below it flinching up and
 * back. So the row shows the newest reasoning the turn actually has, walking back from the
 * last reply past any that have none yet.
 *
 * The walk stops at the start of the turn (a real user message; the runtime's own are passed
 * over), at a reply that has said something (its prose is the newest thing on screen, and
 * older reasoning would be stale under it), and at a finished reply with no calls (that one
 * has a row of its own already). Nothing is shown at all once the last reply has prose: the
 * answer has arrived, and it carries its own reasoning.
 */
function liveReasoning(messages: Message[], live: number): number {
	if (live < 0) return -1;
	const last = messages[live];
	if (last.role !== "assistant" || spoken(last.content) > 0) return -1;
	for (let at = live; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user") {
			if (message.synthetic || isNudge(message)) continue;
			return -1;
		}
		if (message.role !== "assistant") continue;
		if (spoken(message.content) > 0) return -1;
		const calls = message.content.some((block) => block.type === "toolCall");
		if (reasoning(message.content) && (calls || message.stopReason === "pending")) return at;
		if (!calls && message.stopReason !== "pending") return -1;
	}
	return -1;
}

/** How many blocks come before the first call — the reasoning, which is the row's whole content. */
function beforeCalls(content: AssistantContent[]): number {
	const first = content.findIndex((block) => block.type === "toolCall");
	return first < 0 ? content.length : first;
}

function spoken(content: AssistantContent[]): number {
	let end = 0;
	for (const [index, block] of content.entries()) {
		if (block.type === "text" && block.text.trim()) end = index + 1;
	}
	return end;
}

/**
 * A message list, as rows.
 *
 * `compactions` are indices into `messages`: the marker goes where the summary was taken, not at
 * the end, because everything above it is a summary as far as the model is concerned.
 */
export function runs(messages: Message[], compactions: { at: number }[] = []): Run[] {
	const out: Run[] = [];
	// Sorted so the marks can be consumed in order as the transcript is walked.
	const marks = [...compactions].map((c) => c.at).sort((a, b) => a - b);
	let nextMark = 0;
	/** The reply being made, if one is: the last assistant message, whatever state it is in. */
	let live = -1;
	for (let at = messages.length - 1; at >= 0 && live < 0; at--) {
		if (messages[at].role === "assistant") live = at;
	}
	const reasoningRow = liveReasoning(messages, live);

	/** Extend the run this lands in, or start one. Empty batches leave the transcript alone. */
	const work = (calls: Call[]) => {
		if (calls.length === 0) return;
		const last = out[out.length - 1];
		if (last?.kind === "tools") last.calls.push(...calls);
		else out.push({ kind: "tools", calls });
	};

	/*
	 * What the turn in progress has spent, carried down the transcript as it is walked.
	 *
	 * The same answer `computeTurnStats` gives, arrived at in one pass instead of one backward
	 * scan per row. On a session of several thousand messages that difference is the whole cost:
	 * the scan was being run for every visible reply, on every render of the transcript.
	 */
	let turn = noStats();

	for (const [index, message] of messages.entries()) {
		while (nextMark < marks.length && marks[nextMark] === index) {
			out.push({ kind: "compaction" });
			nextMark++;
		}

		// A person speaking starts a new turn; the runtime's own messages continue the one running.
		if (opensTurn(message) && !resumesTurn(messages, index)) turn = noStats();

		/*
		 * Tool results are not entries in the transcript; they are the contents of a card.
		 *
		 * This is what kept the runs from ever forming. Every call is answered by a `toolResult`
		 * message, and treating those as ordinary messages put one between every pair of calls —
		 * so a run of seven arrived as seven runs of one. They render nothing on their own, so
		 * passing over them changes only the grouping.
		 */
		if (message.role === "toolResult") continue;

		/*
		 * The runtime talking to the model is invisible, including the fact that it happened —
		 * so it must not divide what it sits between. The work either side of a nudge is one
		 * continuous stretch, and a row drawn through the middle of it would break the run in
		 * two at a line nobody can see.
		 */
		if (message.role === "user" && (message.synthetic || isNudge(message))) continue;

		if (message.role !== "assistant") {
			out.push({ kind: "message", message, index, upTo: message.content.length });
			continue;
		}

		turn = accumulate(turn, message);

		const said = spoken(message.content);
		const calls: Call[] = [];
		for (const block of message.content.slice(said)) {
			if (block.type === "toolCall") calls.push({ block, stopReason: message.stopReason });
		}

		if (said > 0) {
			out.push({ kind: "message", message, index, upTo: said, turnStats: turn });
		} else if (calls.length === 0 && message.stopReason !== "pending") {
			/*
			 * Nothing said, nothing done, and the turn is over.
			 *
			 * What is left is reasoning, or a failure with no output — this message's only chance
			 * to show it, so it gets a row. The same message still streaming is handled below.
			 */
			out.push({ kind: "message", message, index, upTo: message.content.length, turnStats: turn });
		}

		work(calls);

		/*
		 * The reasoning of the reply being made right now, under the run it is driving.
		 *
		 * Reasoning before a call is never shown once the reply is done — a turn of thirty calls
		 * would otherwise be thirty lines of thinking with a run between each — so while the reply
		 * is being made, its reasoning has nowhere of its own to go. Given a row above the run, it
		 * vanished the moment its first call arrived and merged into the run above, and the next
		 * reply's reasoning then appeared below: everything under it moved down and up with every
		 * call in the turn.
		 *
		 * So it goes under the run instead, and stays there: still shown while its own call runs,
		 * replaced in place by the next reply's reasoning once that has actually arrived, and taken
		 * over by the answer when the prose finally starts — which lands in exactly the same place.
		 * One row, one position, for the whole of the turn. Placed after the last reply rather than
		 * after the reply it belongs to, so a call from a newer reply still joins the run above it,
		 * and a message the user sends meanwhile still comes after it.
		 */
		if (index === live && reasoningRow >= 0) {
			const shown = messages[reasoningRow] as AssistantMessage;
			out.push({ kind: "message", message: shown, index: reasoningRow, upTo: beforeCalls(shown.content), turnStats: turn });
		}
	}

	// A compaction recorded after the last message still belongs at the end.
	while (nextMark < marks.length) {
		out.push({ kind: "compaction" });
		nextMark++;
	}
	return out;
}
