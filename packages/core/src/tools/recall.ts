/**
 * Reading back what compaction took out of the window.
 *
 * A summary is lossy by construction, and the loss is the point — a hundred turns cannot be carried
 * verbatim. What makes that acceptable is that the original is not gone: the session log keeps every
 * message ever committed, in full, and this searches it.
 *
 * That changes what compaction is. Without it, summarising is a decision about what the agent is
 * allowed to remember, made once, by a model with no idea what it will need later — so the honest
 * response is to keep as much as possible in the window, which is exactly the pressure that makes
 * long sessions unaffordable. With it, summarising is a cache eviction: the detail is one call away,
 * and the agent can tell when it needs to make that call. Compacting to a tenth of the window stops
 * being reckless.
 *
 * Deliberately not a general file search. `grep` over the log would work and would be terrible: the
 * matches come back as JSON, one line per record, with an entire tool result on the line that
 * matched. This answers in messages, trimmed, oldest first.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { errorResult } from "../agent/tool-run.ts";
import { lyraHome, projectIdFor } from "../session/store.ts";
import type { Message, Tool, ToolResult } from "../types.ts";

/** How many matching messages to answer with when the caller does not say. */
const DEFAULT_LIMIT = 8;
/** However many are asked for. More than this is a re-read of the session, not a recall. */
const MAX_LIMIT = 20;
/**
 * How much of a matching message to quote.
 *
 * Enough to carry a full request, an error with its stack, or the head of a file. Beyond that the
 * answer starts costing more window than the summary saved, which would make recalling a thing
 * you have to be careful about — and a tool the agent is wary of is a tool it does not use.
 */
const QUOTE_CHARS = 1200;

interface RecallArgs {
	query: string;
	limit?: number;
}

export const recallTool: Tool<RecallArgs> = {
	name: "recall",
	snippet: "Search this session's earlier history",
	description:
		"Search the full transcript of this session, including messages that context compaction has since removed from view. Use it to recover the exact wording of an earlier request, a file's earlier contents, a command's exact output, or any detail a summary condensed. Matching is case-insensitive; every space-separated term must appear in the message.",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"Terms to look for. All of them must appear in a message for it to match, so start broad — one distinctive word — and add terms only if there are too many results.",
			},
			limit: {
				type: "number",
				description: `Maximum messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	summarize: (args) => `Recall “${args.query}”`,

	async execute(args, ctx): Promise<ToolResult> {
		const terms = args.query
			.toLowerCase()
			.split(/\s+/)
			.filter((term) => term.length > 0);
		if (terms.length === 0) return errorResult("recall needs something to search for.");

		const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)));
		const path = join(lyraHome(), "sessions", projectIdFor(ctx.cwd), `${ctx.sessionId}.jsonl`);

		let hits: { index: number; message: Message }[];
		try {
			hits = await search(path, terms, ctx.signal);
		} catch {
			return errorResult("This session has no transcript on disk yet, so there is nothing to recall.");
		}

		if (hits.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No message in this session contains all of: ${terms.join(", ")}.\n\nTry one distinctive term rather than a phrase — matching is literal, not semantic.`,
					},
				],
			};
		}

		/*
		 * Newest matches, shown oldest first.
		 *
		 * The cap has to drop something, and the older half of a long session is the half most
		 * likely to have been summarised twice over — but reading them back in the order they
		 * happened is what makes a sequence of them legible as a sequence.
		 */
		const shown = hits.slice(-limit);
		const body = shown.map((hit) => quote(hit.index, hit.message)).join("\n\n");
		const omitted = hits.length - shown.length;
		const footer = omitted > 0 ? `\n\n[${omitted} older match${omitted === 1 ? "" : "es"} not shown; narrow the query to reach them]` : "";

		return {
			content: [{ type: "text", text: `${hits.length} match${hits.length === 1 ? "" : "es"} in this session.\n\n${body}${footer}` }],
			details: { query: args.query, matches: hits.length, shown: shown.length },
		};
	},
};

/**
 * Every message in the log whose text contains all the terms.
 *
 * Streamed line by line rather than read whole. A long session's log runs to tens of megabytes —
 * that is the entire reason this tool exists — and loading it to search it would spend more memory
 * than the context window it is trying to protect.
 */
async function search(path: string, terms: string[], signal?: AbortSignal): Promise<{ index: number; message: Message }[]> {
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const hits: { index: number; message: Message }[] = [];
	let index = 0;

	try {
		for await (const line of lines) {
			if (signal?.aborted) break;
			if (!line) continue;

			let record: { type?: string; message?: Message };
			try {
				record = JSON.parse(line);
			} catch {
				// A half-written final line is normal on a session that is still running.
				continue;
			}
			if (record.type !== "message" || !record.message) continue;

			const message = record.message;
			const position = index++;
			const text = textOf(message).toLowerCase();
			if (terms.every((term) => text.includes(term))) hits.push({ index: position, message });
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	return hits;
}

/** Everything in a message that a person would have read, flattened for matching and quoting. */
function textOf(message: Message): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") parts.push(`${block.name} ${block.argumentsText ?? JSON.stringify(block.arguments ?? {})}`);
	}
	return parts.join("\n");
}

/**
 * One match, labelled and trimmed.
 *
 * Head and tail rather than head alone: a tool result puts its answer at the top and its totals,
 * its error and its "N more matches" at the bottom, and the middle is the part nobody needs.
 */
function quote(index: number, message: Message): string {
	const when = new Date(message.timestamp).toISOString().replace("T", " ").slice(0, 16);
	const who = message.role === "toolResult" ? `tool:${message.toolName}` : message.role;
	const text = textOf(message).trim();

	const points = [...text];
	const body =
		points.length <= QUOTE_CHARS
			? text
			: `${points.slice(0, Math.floor(QUOTE_CHARS * 0.75)).join("")}\n… [${points.length - QUOTE_CHARS} characters omitted] …\n${points.slice(-Math.floor(QUOTE_CHARS * 0.25)).join("")}`;

	return `--- message ${index} · ${who} · ${when} ---\n${body}`;
}
