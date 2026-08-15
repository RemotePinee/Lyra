import { readFile, writeFile } from "node:fs/promises";
import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolResult } from "../types.ts";
import { computeDiff, formatDiff } from "./diff.ts";
import { displayPath, resolveWorkspacePath } from "./paths.ts";
import { hasRead, markRead } from "./read.ts";

interface EditArgs {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export const editTool: Tool<EditArgs> = {
	name: "edit",
	snippet: "Replace exact text in a file",
	guidelines: [
		"`old_string` must match the file byte for byte, including indentation.",
		"Keep `old_string` as small as it can be while staying unique. Do not pad it with unchanged lines.",
		"When several separate spots in one file need the same change, use replace_all instead of repeated calls.",
	],
	description:
		"Replace an exact string in a file. `old_string` must match the file byte for byte, including indentation, " +
		"and must be unique unless `replace_all` is true. Read the file first. " +
		"Include a few surrounding lines in `old_string` when the snippet would otherwise be ambiguous.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			old_string: { type: "string", description: "Exact text to replace." },
			new_string: { type: "string", description: "Replacement text. Must differ from old_string." },
			replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
		},
		required: ["path", "old_string", "new_string"],
		additionalProperties: false,
	},
	mutating: true,
	executionMode: "sequential",
	summarize: (args) => `Edit ${args.path}`,

	async execute(args, ctx): Promise<ToolResult> {
		let absolute: string;
		try {
			absolute = resolveWorkspacePath(ctx.cwd, args.path);
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}

		if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
			return errorResult("`old_string` and `new_string` must both be strings.");
		}
		if (args.old_string === args.new_string) {
			return errorResult("`old_string` and `new_string` are identical, so this edit would do nothing.");
		}
		if (!hasRead(ctx, absolute)) {
			return errorResult(`Read ${args.path} before editing it.`);
		}

		let before: string;
		try {
			before = await readFile(absolute, "utf8");
		} catch {
			return errorResult(`File not found: ${args.path}`);
		}

		const occurrences = countOccurrences(before, args.old_string);
		if (occurrences === 0) {
			return errorResult(
				`\`old_string\` was not found in ${args.path}. It must match exactly, including whitespace and indentation.`,
			);
		}
		if (occurrences > 1 && !args.replace_all) {
			return errorResult(
				`\`old_string\` appears ${occurrences} times in ${args.path}. Add surrounding lines to make it unique, or set replace_all: true.`,
			);
		}

		const after = args.replace_all
			? before.split(args.old_string).join(args.new_string)
			: before.replace(args.old_string, args.new_string);

		const diff = computeDiff(before, after);
		const shown = displayPath(ctx.cwd, absolute);

		if (ctx.requestApproval) {
			const decision = await ctx.requestApproval({
				kind: "edit",
				title: `Edit ${shown}`,
				detail: formatDiff(diff, shown),
				subject: absolute,
			});
			if (decision === "reject") return errorResult("The user rejected this edit.");
		}

		await writeFile(absolute, after, "utf8");
		markRead(ctx, absolute);

		return {
			content: [
				{
					type: "text",
					text: `Edited ${shown}: ${occurrences} replacement${occurrences === 1 ? "" : "s"}, +${diff.added} -${diff.removed}.`,
				},
			],
			details: {
				kind: "edit",
				path: shown,
				replacements: args.replace_all ? occurrences : 1,
				added: diff.added,
				removed: diff.removed,
				hunks: diff.hunks,
			},
		};
	},
};

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}
