/**
 * Wrapping a single tool call.
 *
 * The loop asks here instead of calling `tool.execute` directly, so a plugin can sit around the
 * call: time it, log it, refuse it, answer it from a cache, run it somewhere else. Around-middleware
 * rather than before/after hooks, because the interesting cases need both ends and the value in
 * between — you cannot time a call with two callbacks that do not share a stack frame.
 *
 * Bound by the host at boot like the other seams. Unbound, `runTool` is `tool.execute` with one
 * extra promise, which is what keeps the CLI and the tests on the same path as the app.
 */

import type { Tool, ToolContext, ToolResult } from "../types.ts";

export interface ToolCall {
	tool: Tool;
	args: Record<string, unknown>;
	ctx: ToolContext;
}

export type ToolMiddleware = (call: ToolCall, next: () => Promise<ToolResult>) => Promise<ToolResult>;

let dispatch: ToolMiddleware | null = null;

export function useToolPipeline(next: ToolMiddleware | null): void {
	dispatch = next;
}

export function runTool(call: ToolCall): Promise<ToolResult> {
	const base = () => call.tool.execute(call.args, call.ctx) as Promise<ToolResult>;
	return dispatch ? dispatch(call, base) : base();
}
