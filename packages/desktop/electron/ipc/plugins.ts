/**
 * Installing and listing plugins.
 *
 * Two kinds live side by side: what the workspace carries in `.deepwise/plugins`, and what the user
 * installed for themselves. Both are directories of code, so both are listed with their source
 * attached — where a plugin came from is the first thing anyone asks when it misbehaves.
 */

import { ipcMain, shell } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deepwiseHome, fetchRegistry, installEntry, loadPlugins, loadSkills, uninstallEntry } from "@deepwise/core";
import type { RegistryEntry } from "../ipc-types.ts";

export interface PluginsIpcDeps {
	pluginsDir(scope: "workspace" | "user", cwd: string): string;
	writeExamplePlugin(dir: string): Promise<void>;
	disabledPlugins(): string[];
}

export function registerPluginsIpc({ pluginsDir, writeExamplePlugin, disabledPlugins }: PluginsIpcDeps): void {
	ipcMain.handle("registry:fetch", async (_event, url: string) => {
		try {
			return { ok: true as const, registry: await fetchRegistry(url) };
		} catch (cause) {
			return { ok: false as const, message: cause instanceof Error ? cause.message : String(cause) };
		}
	});

	/*
	 * Cloning is a write to disk from a URL the user typed, so it says what it did.
	 *
	 * The entry itself is inert until the plugin loader picks it up on the next session, and its
	 * MCP servers still arrive switched off — installing is not the same as trusting.
	 */
	ipcMain.handle("registry:install", async (_event, entry: RegistryEntry) => {
		try {
			return { ok: true as const, dir: await installEntry(entry) };
		} catch (cause) {
			return { ok: false as const, message: cause instanceof Error ? cause.message : String(cause) };
		}
	});

	ipcMain.handle("registry:uninstall", async (_event, id: string) => {
		await uninstallEntry(id);
	});

	ipcMain.handle("plugins:list", async (_event, cwd: string) => {
		const [plugins, skills] = await Promise.all([
			loadPlugins(
				[
					...(cwd ? [{ dir: join(cwd, ".deepwise", "plugins"), source: "workspace" as const }] : []),
					{ dir: join(deepwiseHome(), "plugins"), source: "user" as const },
				],
				disabledPlugins(),
			),
			loadSkills([
				...(cwd ? [{ dir: join(cwd, ".deepwise", "skills"), source: "workspace" as const }] : []),
				{ dir: join(deepwiseHome(), "skills"), source: "user" as const },
			]),
		]);
		const looseNames = new Set(skills.skills.map((skill) => skill.name));
		return {
			plugins: plugins.plugins,
			pluginDiagnostics: plugins.diagnostics,
			skills: [
				...skills.skills,
				...plugins.plugins
					.filter((plugin) => plugin.enabled)
					.flatMap((plugin) => plugin.skills)
					.filter((skill) => !looseNames.has(skill.name)),
			],
			skillDiagnostics: skills.diagnostics,
		};
	});

	ipcMain.handle("plugins:revealDir", async (_event, scope: "workspace" | "user", cwd: string) => {
		const dir = pluginsDir(scope, cwd);
		await mkdir(dir, { recursive: true });
		await shell.openPath(dir);
		return dir;
	});

	ipcMain.handle("plugins:installExample", async (_event, scope: "workspace" | "user", cwd: string) => {
		const dir = join(pluginsDir(scope, cwd), "hello-deepwise");
		await writeExamplePlugin(dir);
		await shell.openPath(dir);
		return dir;
	});
}
