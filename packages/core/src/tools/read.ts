import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { displayPath, imageMimeType, looksBinary, resolveWorkspacePath } from "./paths.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ReadArgs {
	path: string;
	offset?: number;
	limit?: number;
}

/** Tracks which files the agent has read, so `edit` can refuse to patch unseen files. */
const READ_FILES_KEY = "readFiles";

export function markRead(ctx: ToolContext, absolute: string): void {
	const seen = (ctx.state.get(READ_FILES_KEY) as Set<string> | undefined) ?? new Set<string>();
	seen.add(absolute);
	ctx.state.set(READ_FILES_KEY, seen);
}

export function hasRead(ctx: ToolContext, absolute: string): boolean {
	return (ctx.state.get(READ_FILES_KEY) as Set<string> | undefined)?.has(absolute) === true;
}

export const readTool: Tool<ReadArgs> = {
	name: "read",
	snippet: "Read file contents, with line numbers",
	guidelines: [
		"Use read to examine files instead of `cat`, `head`, `sed` or `tail`.",
		"Read a file before editing it, and read enough of it to understand the surrounding code.",
	],
	description:
		"Read a file from the workspace. Text files come back with 1-indexed line numbers in `NNNN→content` form. " +
		"Images are returned to you as actual images. Use `offset` and `limit` to page through long files; " +
		"reading without them returns the first 2000 lines.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			offset: { type: "number", description: "1-indexed line to start from." },
			limit: { type: "number", description: "Maximum number of lines to return. Defaults to 2000." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	summarize: (args) => `Read ${args.path}`,

	async execute(args, ctx): Promise<ToolResult> {
		let absolute: string;
		try {
			absolute = resolveWorkspacePath(ctx.cwd, args.path);
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}

		let info: Stats;
		try {
			info = await stat(absolute);
		} catch {
			return errorResult(`File not found: ${args.path}`);
		}
		if (info.isDirectory()) return errorResult(`${args.path} is a directory. Use \`ls\` or \`glob\` instead.`);

		const mime = imageMimeType(absolute);
		if (mime) {
			if (info.size > MAX_IMAGE_BYTES) {
				return errorResult(`Image is ${(info.size / 1024 / 1024).toFixed(1)} MB, above the 5 MB limit.`);
			}
			const data = await readFile(absolute);
			markRead(ctx, absolute);
			return {
				content: [{ type: "image", data: data.toString("base64"), mimeType: mime }],
				details: { kind: "image", path: displayPath(ctx.cwd, absolute), bytes: info.size, mimeType: mime },
			};
		}

		const buffer = await readFile(absolute);
		if (looksBinary(buffer)) {
			return errorResult(`${args.path} looks like a binary file (${info.size} bytes) and cannot be read as text.`);
		}

		const text = buffer.toString("utf8");
		const allLines = text.split("\n");
		// A trailing newline produces a final empty element that is not a real line.
		if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();

		const offset = Math.max(1, args.offset ?? 1);
		const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
		const slice = allLines.slice(offset - 1, offset - 1 + limit);

		if (slice.length === 0) {
			return errorResult(`Line ${offset} is past the end of the file (${allLines.length} lines).`);
		}

		const width = String(offset + slice.length - 1).length;
		const body = slice
			.map((line, i) => {
				const truncated =
					line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]` : line;
				return `${String(offset + i).padStart(width, " ")}→${truncated}`;
			})
			.join("\n");

		const shownEnd = offset + slice.length - 1;
		const footer =
			shownEnd < allLines.length
				? `\n\n[showing lines ${offset}-${shownEnd} of ${allLines.length}; call read again with offset=${shownEnd + 1} for more]`
				: "";

		markRead(ctx, absolute);
		return {
			content: [{ type: "text", text: body + footer }],
			details: {
				kind: "text",
				path: displayPath(ctx.cwd, absolute),
				totalLines: allLines.length,
				shownFrom: offset,
				shownTo: shownEnd,
			},
		};
	},
};
