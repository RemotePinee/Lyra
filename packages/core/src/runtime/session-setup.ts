/**
 * Everything a session has to load before it can do anything.
 *
 * Plugins, skills, sub-agent definitions, MCP servers and the tools they contribute. Separate from
 * the session because it is a pure "read the world and report what is there" step — which is what
 * makes it possible to re-run after settings change without touching anything else.
 *
 * Precedence is the theme: what the workspace carries beats what the user installed globally, and
 * loose files beat what a plugin bundled. The most specific statement of intent wins.
 */

import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { Settings } from "../config/settings.ts";
import { McpManager, type McpServerStatus } from "../mcp/client.ts";
import { loadPlugins, type Plugin, type PluginDiagnostic } from "../plugins/loader.ts";
import { loadSkills, parseFrontmatter, type Skill, type SkillDiagnostic } from "../skills/loader.ts";
import { registeredSkills } from "../skills/registry.ts";
import { lyraHome } from "../session/store.ts";
import { builtinTools } from "../tools/index.ts";
import { BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import type { Tool } from "../types.ts";

export interface LoadedCapabilities {
	plugins: Plugin[];
	pluginDiagnostics: PluginDiagnostic[];
	skills: Skill[];
	skillDiagnostics: SkillDiagnostic[];
	agents: AgentDefinition[];
	mcpStatuses: McpServerStatus[];
	tools: Tool[];
}

/** Load skills, agents and MCP tools. Safe to call again after settings change. */
export async function loadCapabilities(
	cwd: string,
	settings: Settings,
	mcp: McpManager,
	extraTools: Tool[],
): Promise<LoadedCapabilities> {
	const loadedPlugins = await loadPlugins(
		[
			{ dir: join(cwd, ".lyra", "plugins"), source: "workspace" as const },
			{ dir: join(lyraHome(), "plugins"), source: "user" as const },
		],
		settings.disabledPlugins,
	);
	const plugins = loadedPlugins.plugins;
	const pluginDiagnostics = loadedPlugins.diagnostics;

	const loaded = await loadSkills([
		{ dir: join(cwd, ".lyra", "skills"), source: "workspace" as const },
		{ dir: join(lyraHome(), "skills"), source: "user" as const },
	]);
	// Loose skills win over bundled ones with the same name, so a project can override a
	// plugin's skill by dropping a directory next to it.
	const looseNames = new Set(loaded.skills.map((skill) => skill.name));
	const pluginSkills = plugins
		.filter((plugin) => plugin.enabled)
		.flatMap((plugin) => plugin.skills)
		.filter((skill) => !looseNames.has(skill.name));

	// Code-provided skills sit behind both, for the same reason: what the user put on disk is
	// the most specific statement of intent in the room.
	const known = new Set([...looseNames, ...pluginSkills.map((skill) => skill.name)]);
	const fromPlugins = registeredSkills().filter((skill) => !known.has(skill.name));

	const skills = [...loaded.skills, ...pluginSkills, ...fromPlugins];
	const skillDiagnostics = loaded.diagnostics;

	const agents = [...BUILTIN_AGENTS, ...(await loadAgentDefinitions(cwd))];

	const pluginServers = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.mcpServers);
	const mcpStatuses = await mcp.connectAll([...settings.mcpServers, ...pluginServers]);
	const tools = [...builtinTools(), ...extraTools, ...mcp.allTools()];

	return { plugins, pluginDiagnostics, skills, skillDiagnostics, agents, mcpStatuses, tools };
}


/**
 * Load custom sub-agent definitions from `.lyra/agents/*.md`, mirroring the skill format:
 * YAML frontmatter for metadata, markdown body for the system prompt.
 */
async function loadAgentDefinitions(cwd: string): Promise<AgentDefinition[]> {
	const out: AgentDefinition[] = [];

	for (const [dir, source] of [
		[join(cwd, ".lyra", "agents"), "workspace"],
		[join(lyraHome(), "agents"), "user"],
	] as const) {
		const entries = await readdir(dir).catch(() => []);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const raw = await readFile(join(dir, entry), "utf8").catch(() => null);
			if (!raw) continue;
			const parsed = parseFrontmatter(raw);
			if (!parsed) continue;
			const { frontmatter, body } = parsed;
			const name = typeof frontmatter.name === "string" ? frontmatter.name : entry.replace(/\.md$/, "");
			if (out.some((a) => a.name === name)) continue;
			out.push({
				name,
				description: typeof frontmatter.description === "string" ? frontmatter.description : name,
				systemPrompt: body,
				tools: Array.isArray(frontmatter.tools)
					? (frontmatter.tools as unknown[]).filter((t): t is string => typeof t === "string")
					: "*",
				model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
				source,
			});
		}
	}
	return out;
}
