import { errorResult } from "../agent/loop.ts";
import { buildIndex, loadIndex, saveIndex, searchIndex, type SymbolIndex } from "../index/symbols.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

const INDEX_KEY = "symbolIndex";

interface SymbolArgs {
	name: string;
	kind?: string;
	limit?: number;
}

/** Build once per session, then reuse; rebuilding on every call would be wasteful. */
async function getIndex(ctx: ToolContext): Promise<SymbolIndex> {
	const cached = ctx.state.get(INDEX_KEY) as SymbolIndex | undefined;
	if (cached) return cached;

	const stored = await loadIndex(ctx.cwd);
	if (stored) {
		ctx.state.set(INDEX_KEY, stored);
		return stored;
	}

	const built = await buildIndex(ctx.cwd, ctx.signal);
	ctx.state.set(INDEX_KEY, built);
	await saveIndex(built).catch(() => {});
	return built;
}

export const symbolTool: Tool<SymbolArgs> = {
	name: "symbol",
	snippet: "Find where a function, class or type is defined",
	guidelines: [
		"Use symbol to locate a definition, and grep to find its call sites — grep on a common name returns every usage.",
	],
	description:
		"Look up where a symbol is defined. Searches an index of function, class, interface, type and constant " +
		"declarations across the workspace and returns file:line for each match, best match first. " +
		"Faster and far more precise than grepping for a name that appears at every call site.",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Symbol name or a fragment of it." },
			kind: {
				type: "string",
				description: "Restrict to one kind: function, class, interface, type, enum, const, def, func, struct, method.",
			},
			limit: { type: "number", description: "Maximum matches. Default 40." },
		},
		required: ["name"],
		additionalProperties: false,
	},
	summarize: (args) => `Find definition of ${args.name}`,

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.name !== "string" || !args.name.trim()) return errorResult("`name` is required.");

		const index = await getIndex(ctx);
		const matches = searchIndex(index, args.name.trim(), args.kind, args.limit ?? 40);

		if (matches.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No definition found for "${args.name}" among ${index.symbols.length} indexed symbols across ${index.fileCount} files. It may be defined in a dependency, or declared in a form the index does not recognise — try grep.`,
					},
				],
				details: { kind: "symbol", query: args.name, count: 0 },
			};
		}

		const body = matches.map((m) => `${m.file}:${m.line}  [${m.kind}]  ${m.text}`).join("\n");
		return {
			content: [{ type: "text", text: body }],
			details: { kind: "symbol", query: args.name, count: matches.length, matches },
		};
	},
};

/** Drop the cached index so the next lookup re-scans. Used after the user rebuilds it. */
export function invalidateIndex(state: Map<string, unknown>): void {
	state.delete(INDEX_KEY);
}
