import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/client.ts";
import { lyraHome } from "../session/store.ts";
import type { ProviderConfig, ThinkingLevel } from "../types.ts";

/** How much the agent may do without stopping to ask. */
export type PermissionMode =
	/** Ask before every mutating tool. */
	| "ask"
	/** Ask only for commands that are not recognised as read-only. */
	| "auto"
	/** Never ask. */
	| "full";

export interface ProjectEntry {
	id: string;
	name: string;
	path: string;
	pinned: boolean;
	lastOpenedAt: number;
}

/** Everything the appearance page controls. Applied as CSS variables at runtime. */
export interface AppearanceSettings {
	theme: "system" | "light" | "dark";
	/** Accent colour, shared by both schemes. */
	accent: string;
	lightBackground: string;
	lightForeground: string;
	darkBackground: string;
	darkForeground: string;
	uiFont: string;
	codeFont: string;
	uiFontSize: number;
	codeFontSize: number;
	translucentSidebar: boolean;
	/** 0–100. Scales the distance between surface layers and text. */
	contrast: number;
	pointerCursor: boolean;
	reduceMotion: "system" | "on" | "off";
	/** Whether diffs are shown by colour or by leading +/- markers. */
	diffMarkers: "color" | "symbols";
	fontSmoothing: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
	theme: "dark",
	accent: "#339CFF",
	lightBackground: "#FFFFFF",
	lightForeground: "#1A1C1F",
	darkBackground: "#171717",
	darkForeground: "#EDEDED",
	uiFont: '"Inter Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
	codeFont: '"JetBrains Mono Variable", ui-monospace, "SF Mono", SFMono-Regular, Menlo, "PingFang SC", monospace',
	uiFontSize: 13,
	codeFontSize: 12,
	translucentSidebar: false,
	contrast: 60,
	pointerCursor: false,
	reduceMotion: "system",
	diffMarkers: "color",
	fontSmoothing: true,
};

export interface HookConfig {
	id: string;
	/** Shell command run at the hook point. */
	command: string;
	/** Only fire for these tool names; empty means every tool. */
	tools: string[];
	event: "before-tool" | "after-tool";
	enabled: boolean;
	/** A non-zero exit from a before-tool hook blocks the call. */
	blocking: boolean;
}

/** A prompt the app sends on its own schedule, in a fresh session each time. */
export interface ScheduledTask {
	id: string;
	name: string;
	/** Workspace the task runs in. */
	cwd: string;
	prompt: string;
	schedule: { kind: "interval"; minutes: number } | { kind: "daily"; time: string };
	enabled: boolean;
	lastRunAt?: number;
	lastSessionId?: string;
	lastError?: string;
}

export interface Settings {
	/**
	 * Keys for the search services that want one.
	 *
	 * Optional throughout: search works without any of them through the keyless provider, and a key
	 * is an upgrade rather than a prerequisite. Read at call time so pasting one in takes effect
	 * without a restart.
	 */
	searchApiKeys?: { tavily?: string; exa?: string; brave?: string };
	/** Which search provider to use when more than one is usable. */
	searchProvider?: string | null;
	/**
	 * Internal hosts the agent may reach, named one at a time.
	 *
	 * Private addresses are refused rather than asked about, because a prompt showing
	 * `169.254.169.254` is a question almost nobody can answer. Somebody who genuinely runs a
	 * service on their own network needs a way to say so — and this is it: a decision made once,
	 * while thinking about it, rather than mid-turn.
	 *
	 * Matched by hostname. It cannot open a private address reached through a public name, which
	 * is the shape of an attack rather than a configuration anybody intends.
	 */
	allowedHosts?: string[];
	version: 1;
	providers: ProviderConfig[];
	mcpServers: McpServerConfig[];
	projects: ProjectEntry[];
	/** `${providerId}/${modelId}` of the model used for new sessions. */
	defaultModelId: string | null;
	permissionMode: PermissionMode;
	thinking: ThinkingLevel;
	/**
	 * Attempts per model request, including the first.
	 *
	 * Only the connection is retried — a stream already delivering text never is. Worth raising
	 * on a flaky relay, worth setting to 1 when you would rather see failures immediately.
	 */
	retryAttempts: number;
	/** Last level chosen above "off", restored when fast mode is switched back off. */
	lastThinking?: ThinkingLevel;
	appearance: AppearanceSettings;
	hooks: HookConfig[];
	scheduledTasks: ScheduledTask[];
	/**
	 * Plugin ids that are switched off; everything found on disk is on by default.
	 *
	 * `*` is a sentinel meaning "none of them", for a session that has to be reproducible and
	 * therefore cannot inherit whatever happens to be installed. It is not an id, and the settings
	 * page clears it when a plugin is switched back on.
	 */
	disabledPlugins: string[];
	/**
	 * Plugin registry index URLs the user has added, browsed from the plugins page.
	 *
	 * Empty by default. Shipping a preset would mean pointing at a collection whose contents we
	 * do not control and cannot promise will stay there — and a dead URL in a fresh install reads
	 * as a broken feature rather than as an empty one.
	 */
	pluginRegistries: string[];
	/** Rules the user chose to always allow, keyed by tool kind. */
	alwaysAllow: string[];
	sync: {
		enabled: boolean;
		port: number;
		/** Shared secret a mobile client presents to pair. Regenerated on demand. */
		token: string | null;
	};
	editor: {
		defaultOpenTarget: string;
		showBottomPanel: boolean;
	};
}

export const DEFAULT_SETTINGS: Settings = {
	version: 1,
	providers: [],
	mcpServers: [],
	projects: [],
	defaultModelId: null,
	permissionMode: "auto",
	thinking: "medium",
	retryAttempts: 3,
	appearance: DEFAULT_APPEARANCE,
	hooks: [],
	scheduledTasks: [],
	disabledPlugins: [],
	pluginRegistries: [],
	alwaysAllow: [],
	sync: { enabled: false, port: 4517, token: null },
	editor: { defaultOpenTarget: "Zed", showBottomPanel: true },
	searchApiKeys: {},
	allowedHosts: [],
};

export function settingsPath(): string {
	return join(lyraHome(), "settings.json");
}

export async function loadSettings(): Promise<Settings> {
	const raw = await readFile(settingsPath(), "utf8").catch(() => null);
	if (!raw) return { ...DEFAULT_SETTINGS };
	try {
		const parsed = JSON.parse(raw) as Partial<Settings>;
		// Merge against defaults so a settings file written by an older build keeps working.
		return {
			...DEFAULT_SETTINGS,
			...parsed,
			sync: { ...DEFAULT_SETTINGS.sync, ...parsed.sync },
			editor: { ...DEFAULT_SETTINGS.editor, ...parsed.editor },
			appearance: migrateAppearance({ ...DEFAULT_APPEARANCE, ...parsed.appearance }),
			hooks: parsed.hooks ?? [],
			scheduledTasks: parsed.scheduledTasks ?? [],
			disabledPlugins: parsed.disabledPlugins ?? [],
			pluginRegistries: parsed.pluginRegistries ?? [],
			providers: parsed.providers ?? [],
			mcpServers: parsed.mcpServers ?? [],
			projects: parsed.projects ?? [],
			alwaysAllow: parsed.alwaysAllow ?? [],
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Font stacks that were once the default, and are no longer.
 *
 * Settings are written out in full, so every existing install has the old system stack recorded
 * as if it had been chosen deliberately — a new default would never reach anyone. Anything still
 * holding a value this list knows about is taken to have never made a choice, and moves on.
 * A stack the user actually typed is not in the list, and stays.
 */
const SUPERSEDED_FONTS: Record<"uiFont" | "codeFont", string[]> = {
	uiFont: ['-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'],
	codeFont: ['ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'],
};

function migrateAppearance(appearance: AppearanceSettings): AppearanceSettings {
	const next = { ...appearance };
	for (const key of ["uiFont", "codeFont"] as const) {
		if (SUPERSEDED_FONTS[key].includes(next[key])) next[key] = DEFAULT_APPEARANCE[key];
	}
	return next;
}

export async function saveSettings(settings: Settings): Promise<void> {
	const path = settingsPath();
	await mkdir(lyraHome(), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
	await rename(tmp, path);
}

/** Find a model across all configured providers by its `${providerId}/${modelId}` id. */
export function resolveModel(settings: Settings, id: string | null) {
	if (!id) return null;
	for (const provider of settings.providers) {
		if (!provider.enabled) continue;
		const model = provider.models.find((m) => m.id === id);
		if (model) return { provider, model };
	}
	return null;
}

/** Every enabled model, flattened for the model picker. */
export function availableModels(settings: Settings) {
	return settings.providers
		.filter((p) => p.enabled)
		.flatMap((p) => p.models.map((m) => ({ provider: p, model: m })));
}
