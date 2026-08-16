/**
 * Plugins.
 *
 * A plugin is a *bundle*: a manifest plus a `skills/` directory (each skill may carry its own
 * `scripts/`, `assets/` and sub-agent definitions) plus an optional MCP server declaration.
 * It is not a third mechanism alongside skills and MCP — it is the packaging format that ships
 * them together, which is why loading one simply contributes skills and MCP servers to the
 * session.
 *
 * Layout (compatible with Codex's, so existing bundles drop straight in):
 *
 *   my-plugin/
 *     .lyra-plugin/plugin.json   (or .codex-plugin/plugin.json, or ./plugin.json)
 *     skills/<name>/SKILL.md
 *     skills/<name>/scripts/…
 *     .mcp.json
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { McpServerConfig } from "../mcp/client.ts";
import { loadSkills, type Skill } from "../skills/loader.ts";

export interface PluginInterface {
	displayName?: string;
	shortDescription?: string;
	longDescription?: string;
	developerName?: string;
	category?: string;
	capabilities?: string[];
	brandColor?: string;
	logo?: string;
	defaultPrompt?: string[];
	websiteURL?: string;
}

export interface PluginManifest {
	name: string;
	version?: string;
	description?: string;
	author?: { name?: string } | string;
	homepage?: string;
	license?: string;
	keywords?: string[];
	/** Directory holding this plugin's skills, relative to the plugin root. */
	skills?: string;
	/** JSON file declaring MCP servers, relative to the plugin root. */
	mcpServers?: string;
	interface?: PluginInterface;
}

export interface Plugin {
	/** Directory name; unique within a source. */
	id: string;
	dir: string;
	manifest: PluginManifest;
	source: "workspace" | "user";
	skills: Skill[];
	mcpServers: McpServerConfig[];
	enabled: boolean;
	/** Populated when the bundle is present but unusable. */
	error?: string;
}

export interface PluginDiagnostic {
	path: string;
	message: string;
}

const MANIFEST_LOCATIONS = [
	join(".lyra-plugin", "plugin.json"),
	join(".codex-plugin", "plugin.json"),
	"plugin.json",
];

export async function loadPlugins(
	sources: { dir: string; source: Plugin["source"] }[],
	disabled: string[] = [],
): Promise<{ plugins: Plugin[]; diagnostics: PluginDiagnostic[] }> {
	const plugins: Plugin[] = [];
	const diagnostics: PluginDiagnostic[] = [];
	const seen = new Set<string>();

	for (const { dir, source } of sources) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
		if (!entries) continue;

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const pluginDir = join(dir, entry.name);
			if (!(await stat(pluginDir).then((s) => s.isDirectory()).catch(() => false))) continue;

			const found = await readManifest(pluginDir);
			if (!found) continue;
			if (!found.manifest) {
				diagnostics.push({ path: pluginDir, message: found.error });
				continue;
			}

			const manifest = found.manifest;
			const id = manifest.name || entry.name;
			// Workspace plugins are loaded first, so a user-level plugin of the same name loses.
			if (seen.has(id)) {
				diagnostics.push({ path: pluginDir, message: `插件 "${id}" 已由更高优先级的来源提供` });
				continue;
			}
			seen.add(id);

			/*
			 * `*` turns everything off.
			 *
			 * A session that must be reproducible — one running in CI, or one being used to
			 * reproduce a report — cannot have its capabilities decided by whatever happens to be
			 * installed on the machine. Naming every plugin to disable it is not an option there,
			 * because the point is precisely not knowing what is installed.
			 */
			const enabled = !disabled.includes("*") && !disabled.includes(id);
			const skillsDir = resolveInside(pluginDir, manifest.skills ?? "./skills/");
			const loadedSkills = skillsDir ? await loadSkills([{ dir: skillsDir, source }]) : { skills: [], diagnostics: [] };
			for (const diagnostic of loadedSkills.diagnostics) {
				diagnostics.push({ path: diagnostic.path, message: diagnostic.message });
			}

			const mcpResult = manifest.mcpServers
				? await readMcpServers(pluginDir, manifest.mcpServers, id)
				: { servers: [], error: undefined };
			if (mcpResult.error) diagnostics.push({ path: pluginDir, message: mcpResult.error });

			plugins.push({
				id,
				dir: pluginDir,
				manifest,
				source,
				// Tag skills so the UI can show which plugin brought them in.
				skills: loadedSkills.skills.map((skill) => ({ ...skill, pluginId: id })),
				mcpServers: mcpResult.servers.map((server) => ({ ...server, enabled: server.enabled && enabled })),
				enabled,
			});
		}
	}

	return { plugins, diagnostics };
}

type ManifestResult = { manifest: PluginManifest; error?: undefined } | { manifest?: undefined; error: string };

async function readManifest(pluginDir: string): Promise<ManifestResult | null> {
	for (const location of MANIFEST_LOCATIONS) {
		const raw = await readFile(join(pluginDir, location), "utf8").catch(() => null);
		if (raw === null) continue;
		try {
			const parsed = JSON.parse(raw) as PluginManifest;
			if (!parsed.name || typeof parsed.name !== "string") {
				return { error: `${location} 缺少 name 字段` };
			}
			return { manifest: parsed };
		} catch (error) {
			return { error: `${location} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
		}
	}
	return inferManifest(pluginDir);
}

/**
 * A bundle that never declared itself one.
 *
 * The manifest is our format, and almost nothing in the wild ships it. What the good skill
 * collections do ship is `skills/<name>/SKILL.md` — the same layout, arrived at independently,
 * because it is the obvious one. Requiring the file anyway meant a repository full of perfectly
 * loadable skills cloned into a directory that did nothing, and the only way to fix it was for
 * us to fork it or for them to adopt us.
 *
 * So the shape is the declaration: a directory holding `skills/` or a `.mcp.json` is a plugin,
 * whatever it calls itself. Anything else is still skipped — a directory has to contain
 * something we can actually load before it earns a row in the list.
 *
 * `.claude-plugin/marketplace.json` is read for what it says, not for permission. Collections
 * published for Claude Code carry their name, description, version and author there, and taking
 * them means an inferred bundle arrives with a real label instead of its directory name.
 */
async function inferManifest(pluginDir: string): Promise<ManifestResult | null> {
	const hasSkills = await stat(join(pluginDir, "skills"))
		.then((s) => s.isDirectory())
		.catch(() => false);
	const hasMcp = await stat(join(pluginDir, ".mcp.json"))
		.then((s) => s.isFile())
		.catch(() => false);
	if (!hasSkills && !hasMcp) return null;

	const manifest: PluginManifest = { name: basename(pluginDir) };
	if (hasMcp) manifest.mcpServers = ".mcp.json";

	const raw = await readFile(join(pluginDir, ".claude-plugin", "marketplace.json"), "utf8").catch(() => null);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as {
				name?: string;
				description?: string;
				owner?: { name?: string };
				plugins?: { version?: string; category?: string; homepage?: string }[];
			};
			if (typeof parsed.name === "string" && parsed.name) manifest.name = parsed.name;
			if (typeof parsed.description === "string") manifest.description = parsed.description;
			if (typeof parsed.owner?.name === "string") manifest.author = { name: parsed.owner.name };
			// The collection's own entry is the one whose source is the root; in practice, the first.
			const head = parsed.plugins?.[0];
			if (head) {
				if (typeof head.version === "string") manifest.version = head.version;
				if (typeof head.homepage === "string") manifest.homepage = head.homepage;
				manifest.interface = {
					displayName: manifest.name,
					shortDescription: manifest.description,
					category: typeof head.category === "string" ? head.category : undefined,
				};
			}
		} catch {
			// A malformed marketplace file costs the labels, not the plugin.
		}
	}

	return { manifest };
}

async function readMcpServers(
	pluginDir: string,
	relative: string,
	pluginId: string,
): Promise<{ servers: McpServerConfig[]; error?: string }> {
	const path = resolveInside(pluginDir, relative);
	if (!path) return { servers: [], error: `mcpServers 路径逃出了插件目录：${relative}` };

	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) return { servers: [], error: `找不到 MCP 配置文件：${relative}` };

	let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { servers: [], error: `MCP 配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
	}

	const servers: McpServerConfig[] = [];
	for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
		const normalized = normalizeServer(`${pluginId}__${name}`, name, config, pluginDir);
		if (normalized) servers.push(normalized);
	}
	return { servers };
}

/**
 * Translate one entry of a `.mcp.json` into our config shape.
 *
 * `type` is optional in the wild — a `command` implies stdio and a `url` implies HTTP.
 * `bearer_token_env_var` is resolved from the environment rather than stored, so a bundle
 * can be shared without embedding a token.
 */
function normalizeServer(
	id: string,
	name: string,
	config: Record<string, unknown>,
	pluginDir: string,
): McpServerConfig | null {
	const type = typeof config.type === "string" ? config.type : undefined;
	const command = typeof config.command === "string" ? config.command : undefined;
	const url = typeof config.url === "string" ? config.url : undefined;

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries((config.env as Record<string, unknown>) ?? {})) {
		if (typeof value === "string") env[key] = value;
	}

	if (command || type === "stdio") {
		if (!command) return null;
		return {
			id,
			name,
			transport: "stdio",
			// A relative command is resolved against the plugin so bundled binaries work.
			command: command.startsWith(".") ? join(pluginDir, command) : command,
			args: Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === "string") : [],
			env,
			enabled: true,
			pluginId: id.split("__")[0],
		};
	}

	if (url) {
		const headers: Record<string, string> = {};
		const tokenVar = config.bearer_token_env_var;
		if (typeof tokenVar === "string" && process.env[tokenVar]) {
			headers.authorization = `Bearer ${process.env[tokenVar]}`;
		}
		for (const [key, value] of Object.entries((config.headers as Record<string, unknown>) ?? {})) {
			if (typeof value === "string") headers[key] = value;
		}
		return {
			id,
			name,
			transport: type === "sse" ? "sse" : "http",
			url,
			headers,
			enabled: true,
			pluginId: id.split("__")[0],
		};
	}

	return null;
}

/** Resolve a manifest-supplied relative path, refusing anything that escapes the plugin. */
function resolveInside(pluginDir: string, relative: string): string | null {
	if (isAbsolute(relative)) return null;
	const resolved = resolve(pluginDir, relative);
	const root = resolve(pluginDir);
	return resolved === root || resolved.startsWith(`${root}/`) ? resolved : null;
}

/** One-line summary for the plugin list. */
export function pluginSummary(plugin: Plugin): string {
	return (
		plugin.manifest.interface?.shortDescription ??
		plugin.manifest.description ??
		`${plugin.skills.length} 个技能`
	);
}
