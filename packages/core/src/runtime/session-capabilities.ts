/**
 * What a session can do, as opposed to what it has done.
 *
 * Tools, skills, sub-agents and MCP servers are discovered together, replaced together when the
 * settings change, and read together every turn — so they are one object rather than ten fields on
 * the session. It also gives the diagnostics somewhere to live: a skill that failed to parse is
 * part of this answer, not an error to throw away.
 *
 * The scratch state map rides along because its lifetime is the same. It holds the symbol index,
 * the todo list and the skill catalogue — things a tool wrote down for the next tool to read.
 */

import { McpManager, type McpServerStatus } from "../mcp/client.ts";
import type { Settings } from "../config/settings.ts";
import type { Plugin, PluginDiagnostic } from "../plugins/loader.ts";
import type { Skill, SkillDiagnostic } from "../skills/loader.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { invalidateIndex } from "../tools/index.ts";
import { AGENTS_KEY, BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import type { Tool } from "../types.ts";
import { loadCapabilities } from "./session-setup.ts";

export class SessionCapabilities {
	tools: Tool[] = [];
	skills: Skill[] = [];
	skillDiagnostics: SkillDiagnostic[] = [];
	plugins: Plugin[] = [];
	pluginDiagnostics: PluginDiagnostic[] = [];
	mcpStatuses: McpServerStatus[] = [];
	agents: AgentDefinition[] = [...BUILTIN_AGENTS];

	/** Shared scratch space for tools that need to remember something across calls. */
	readonly state = new Map<string, unknown>();
	readonly mcp = new McpManager();

	/**
	 * Tools that only exist on a particular host — the desktop app contributes browser automation
	 * backed by a real BrowserWindow, which the platform-agnostic core cannot build.
	 *
	 * Assigned in the body rather than declared as a parameter property: Node's type stripping
	 * runs the source as-is and cannot rewrite one into a field.
	 */
	private readonly extraTools: Tool[];

	constructor(extraTools: Tool[] = []) {
		this.extraTools = extraTools;
	}

	/** Discover everything again. Safe to call after the settings change. */
	async load(cwd: string, settings: Settings): Promise<void> {
		const loaded = await loadCapabilities(cwd, settings, this.mcp, this.extraTools);
		this.plugins = loaded.plugins;
		this.pluginDiagnostics = loaded.pluginDiagnostics;
		this.skills = loaded.skills;
		this.skillDiagnostics = loaded.skillDiagnostics;
		this.agents = loaded.agents;
		this.mcpStatuses = loaded.mcpStatuses;
		this.tools = loaded.tools;
		// Two tools read these back rather than taking them as arguments.
		this.state.set(SKILLS_KEY, this.skills);
		this.state.set(AGENTS_KEY, this.agents);
	}

	/** Drop the cached symbol index so the next lookup re-reads it from disk. */
	invalidateSymbolIndex(): void {
		invalidateIndex(this.state);
	}

	async dispose(): Promise<void> {
		await this.mcp.closeAll();
	}
}
