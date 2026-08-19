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

import type { AssistantContent, AssistantMessage, Message } from "@lyra/core";

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
	 */
	| { kind: "message"; message: Message; index: number; upTo: number }
	| { kind: "tools"; calls: Call[] };

/** The runtime's "carry on" message, recognised by what it says as well as by its flag. */
export function isNudge(message: Message | undefined): boolean {
	if (message?.role !== "user") return false;
	return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
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

	/** Extend the run this lands in, or start one. Empty batches leave the transcript alone. */
	const work = (calls: Call[]) => {
		if (calls.length === 0) return;
		const last = out[out.length - 1];
		if (last?.kind === "tools") last.calls.push(...calls);
		else out.push({ kind: "tools", calls });
	};

	for (const [index, message] of messages.entries()) {
		while (nextMark < marks.length && marks[nextMark] === index) {
			out.push({ kind: "compaction" });
			nextMark++;
		}

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

		const said = spoken(message.content);
		const calls: Call[] = [];
		for (const block of message.content.slice(said)) {
			if (block.type === "toolCall") calls.push({ block, stopReason: message.stopReason });
		}

		if (said > 0) {
			out.push({ kind: "message", message, index, upTo: said });
		} else if (calls.length === 0 && message.stopReason !== "pending") {
			/*
			 * Nothing said, nothing done, and the turn is over.
			 *
			 * What is left is reasoning, or a failure with no output — this message's only chance
			 * to show it, so it gets a row. While the same message is still streaming it gets
			 * none: the one thing it could draw is a folded line of reasoning that the first call
			 * to arrive would take away again, and a row that exists for two seconds and then
			 * removes itself is the flicker this whole file is arranged to avoid.
			 */
			out.push({ kind: "message", message, index, upTo: message.content.length });
		}

		work(calls);
	}

	// A compaction recorded after the last message still belongs at the end.
	while (nextMark < marks.length) {
		out.push({ kind: "compaction" });
		nextMark++;
	}
	return out;
}
