/**
 * Cutting oversized tool results down before they are sent, without asking a model.
 *
 * A single `grep` can answer with 96,000 characters — its match limit counts matches, and a match
 * in a minified file is one very long line. Two or three of those fill a 200k window on their own,
 * and by the time compaction notices, the thing it has to summarise is mostly the same file read
 * three ways. Summarising is a model call: slow, billed, and fallible exactly when the window is
 * tight. Cutting is neither.
 *
 * So this runs first and costs nothing. What survives is a head, a marker that says what was taken,
 * and a tail — the shape of a tool result being what it is: the beginning carries the answer, the
 * end carries the totals and the error, and the middle is the part you scroll past.
 *
 * Only the copy sent to the model is cut. The session log keeps the complete result, so the card in
 * the transcript still opens to everything the tool actually said, and a later replay of the log is
 * unaffected. This is a view, not an edit.
 *
 * Idempotent by construction: the replacement is strictly shorter than the threshold, so a second
 * pass over the same message finds nothing left to do.
 */

import type { Message, ToolResultMessage } from "../types.ts";

/**
 * Above this, a result is cut. Below it, nothing happens at all.
 *
 * Roughly 2,300 tokens of prose or code. Large enough that ordinary results — a file read, a test
 * run, a directory listing — pass through untouched, and small enough that a handful of the
 * pathological ones cannot spend a window between them.
 */
export const PRUNE_THRESHOLD_CHARS = 8192;
/** Kept from the front, where a tool puts its answer. */
export const PRUNE_HEAD_CHARS = 4096;
/** Kept from the back, where it puts totals, errors and "N more matches". */
export const PRUNE_TAIL_CHARS = 1024;

/** Says what happened, in the model's own reading order, and how much is missing. */
function marker(omitted: number): string {
	return `\n\n… [${omitted.toLocaleString("en-US")} characters omitted by Lyra to fit the context window; the full result is kept in the session and shown in the transcript. Narrow the search or read a specific file if you need the middle.] …\n\n`;
}

/**
 * The text of a tool result, cut to size, or `null` if it was already small enough.
 *
 * Split on code points rather than UTF-16 units, so a surrogate pair is never left half-written —
 * a lone surrogate is not text any provider will accept. A grapheme cluster can still be split;
 * that costs one malformed emoji at a boundary, where the alternative is a scan of the whole
 * string for a saving nobody can see.
 */
export function pruneText(text: string, threshold = PRUNE_THRESHOLD_CHARS): string | null {
	const points = [...text];
	if (points.length <= threshold) return null;

	const head = points.slice(0, PRUNE_HEAD_CHARS).join("");
	const tail = points.slice(points.length - PRUNE_TAIL_CHARS).join("");
	const omitted = points.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS;
	return `${head}${marker(omitted)}${tail}`;
}

/**
 * One message, with any oversized text cut down. Returns the same object when nothing changed.
 *
 * Identity is the signal callers use to decide whether anything happened, so it matters that an
 * untouched message comes back as itself rather than as an equal copy.
 */
function pruneMessage(message: Message, threshold: number): Message {
	if (message.role !== "toolResult") return message;

	/*
	 * Measured over the text blocks together, cut on the one that is actually big.
	 *
	 * A result is usually one text block, but it does not have to be. Judging each block on its own
	 * would let ten blocks of eight thousand characters through, and cutting every block to a share
	 * of the budget would mangle a small block sitting beside a huge one.
	 */
	const total = message.content.reduce((sum, block) => sum + (block.type === "text" ? [...block.text].length : 0), 0);
	if (total <= threshold) return message;

	let cut = false;
	const content = message.content.map((block) => {
		if (block.type !== "text") return block;
		const pruned = pruneText(block.text, threshold);
		if (pruned === null) return block;
		cut = true;
		return { ...block, text: pruned };
	});
	if (!cut) return message;
	return { ...message, content } as ToolResultMessage;
}

/**
 * The conversation as it should be sent: every oversized tool result cut, everything else as it was.
 *
 * Returns the same array when nothing needed cutting, so the common case allocates nothing and a
 * caller can tell at a glance whether this pass did anything.
 */
export function pruneToolResults(messages: Message[], threshold = PRUNE_THRESHOLD_CHARS): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		const pruned = pruneMessage(message, threshold);
		if (pruned !== message) changed = true;
		return pruned;
	});
	return changed ? next : messages;
}
