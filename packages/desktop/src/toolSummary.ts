/**
 * Human-readable one-liners for tool calls.
 *
 * The main process sends a summary with each live `tool_start`, but a session reopened from
 * disk only has the raw call, so the same labels are derived here from the arguments.
 */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const str = (key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);

	switch (name) {
		case "read":
			return `Read ${str("path") ?? ""}`.trim();
		case "write":
			return `Write ${str("path") ?? ""}`.trim();
		case "edit":
			return `Edit ${str("path") ?? ""}`.trim();
		case "ls":
			return `List ${str("path") ?? "."}`;
		case "glob":
			return `Find ${str("pattern") ?? ""}`.trim();
		case "grep":
			return `Search "${str("pattern") ?? ""}"`;
		case "bash":
			return str("description") ?? (str("command") ?? "bash").split("\n")[0].slice(0, 80);
		case "bash_output":
			return `Check job ${str("id") ?? ""}`.trim();
		case "todo_write":
			return "Update task list";
		case "task":
			return str("description") ?? "Sub-agent task";
		case "skill":
			return `Skill: ${str("name") ?? ""}`.trim();
		case "web_fetch":
			return `Fetch ${str("url") ?? ""}`.trim();
		default:
			// MCP tools are named mcp__<server>__<tool>; show the readable half.
			if (name.startsWith("mcp__")) {
				const [, server, tool] = name.split("__");
				return `${server}: ${tool}`;
			}
			return name;
	}
}
