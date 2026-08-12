import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/client.ts";
import { deepwiseHome } from "../session/store.ts";
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
	uiFont: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
	codeFont: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
	uiFontSize: 13,
	codeFontSize: 12,
	translucentSidebar: true,
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
	version: 1;
	providers: ProviderConfig[];
	mcpServers: McpServerConfig[];
	projects: ProjectEntry[];
	/** `${providerId}/${modelId}` of the model used for new sessions. */
	defaultModelId: string | null;
	permissionMode: PermissionMode;
	thinking: ThinkingLevel;
	/** Last level chosen above "off", restored when fast mode is switched back off. */
	lastThinking?: ThinkingLevel;
	theme: "dark" | "light" | "system";
	appearance: AppearanceSettings;
	hooks: HookConfig[];
	scheduledTasks: ScheduledTask[];
	/** Plugin ids the user switched off; everything found on disk is on by default. */
	disabledPlugins: string[];
	language: "zh-CN" | "en-US" | "auto";
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
	theme: "dark",
	appearance: DEFAULT_APPEARANCE,
	hooks: [],
	scheduledTasks: [],
	disabledPlugins: [],
	language: "auto",
	alwaysAllow: [],
	sync: { enabled: false, port: 4517, token: null },
	editor: { defaultOpenTarget: "Zed", showBottomPanel: true },
};

export function settingsPath(): string {
	return join(deepwiseHome(), "settings.json");
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
			appearance: { ...DEFAULT_APPEARANCE, ...parsed.appearance },
			hooks: parsed.hooks ?? [],
			scheduledTasks: parsed.scheduledTasks ?? [],
			disabledPlugins: parsed.disabledPlugins ?? [],
			providers: parsed.providers ?? [],
			mcpServers: parsed.mcpServers ?? [],
			projects: parsed.projects ?? [],
			alwaysAllow: parsed.alwaysAllow ?? [],
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: Settings): Promise<void> {
	const path = settingsPath();
	await mkdir(deepwiseHome(), { recursive: true });
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
