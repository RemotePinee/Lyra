import { bashOutputTool, bashTool } from "../../tools/bash.ts";
import { editTool } from "../../tools/edit.ts";
import { globTool } from "../../tools/glob.ts";
import { grepTool } from "../../tools/grep.ts";
import { lsTool } from "../../tools/ls.ts";
import { previewTool } from "../../tools/preview.ts";
import { readTool } from "../../tools/read.ts";
import { skillTool } from "../../skills/tool.ts";
import { symbolTool } from "../../tools/symbol.ts";
import { taskTool } from "../../tools/task.ts";
import { todoTool } from "../../tools/todo.ts";
import { webFetchTool } from "../../tools/web.ts";
import { writeTool } from "../../tools/write.ts";
import { useToolPipeline } from "../../agent/tool-pipeline.ts";
import type { Tool, ToolResult } from "../../types.ts";
import type { Context, Plugin } from "../context.ts";
import { EVENTS, TOOLS, type ToolRegistry } from "../services.ts";

class Registry implements ToolRegistry {
	private readonly sets: Tool[][] = [];

	register(tools: Tool[]): () => void {
		this.sets.push(tools);
		return () => {
			const at = this.sets.indexOf(tools);
			if (at >= 0) this.sets.splice(at, 1);
		};
	}

	all(): Tool[] {
		/*
		 * Later registrations win on name collision.
		 *
		 * That is what makes replacement possible: a plugin providing its own `bash` — sandboxed,
		 * remote, whatever it needs to be — displaces the built-in simply by loading after it,
		 * with nothing removed by hand.
		 */
		const byName = new Map<string, Tool>();
		for (const set of this.sets) for (const tool of set) byName.set(tool.name, tool);
		return [...byName.values()];
	}

	byName(name: string): Tool | undefined {
		return this.all().find((tool) => tool.name === name);
	}
}

/**
 * The tools that ship with the app.
 *
 * Grouped by what they touch rather than listed flat, so a configuration can drop a whole area —
 * an agent with no shell, or one that reads but never writes — by not loading that group.
 */
export const FILE_TOOLS = [readTool, writeTool, editTool, lsTool, globTool, grepTool, symbolTool] as unknown as Tool[];
export const SHELL_TOOLS = [bashTool, bashOutputTool] as unknown as Tool[];
export const AGENT_TOOLS = [todoTool, taskTool, skillTool] as unknown as Tool[];
export const WEB_TOOLS = [webFetchTool, previewTool] as unknown as Tool[];

export const toolsPlugin: Plugin = {
	name: "tools",
	apply(ctx: Context) {
		const registry = new Registry();
		const withdraw = ctx.provide<ToolRegistry>(TOOLS, registry);

		/*
		 * Every tool call goes through the bus.
		 *
		 * Nothing listens by default, so the waterfall reaches its base — the tool itself — with one
		 * extra promise. What it buys is that wrapping a call is a listener rather than a patch:
		 * timing, refusing, caching, running it on another machine.
		 */
		useToolPipeline((call, next) => ctx.waterfall<ToolResult>(EVENTS.toolCall, [call], next));
		const groups = [
			registry.register(FILE_TOOLS),
			registry.register(SHELL_TOOLS),
			registry.register(AGENT_TOOLS),
			registry.register(WEB_TOOLS),
		];

		return () => {
			useToolPipeline(null);
			for (const remove of groups) remove();
			withdraw();
		};
	},
};
