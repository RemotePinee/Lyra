/**
 * Installing and listing what the catalogue offers.
 *
 * Two kinds of bundle, told apart by their contents rather than by where they sit: a plugin is a
 * directory of skills, and an MCP bundle is a directory whose whole content is a server
 * declaration. Installing the second writes its servers into settings, which is the only place a
 * session reads them from — that is what stops the same server existing twice, once here and once
 * on the MCP settings page, with two switches that could not see each other.
 */

import { ipcMain, shell } from "electron";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpBundle, Settings } from "@lyra/core";
import { lyraHome, fetchRegistry, installEntry, loadPlugins, loadSkills, uninstallEntry } from "@lyra/core";
import type { RegistryEntry } from "../ipc-types.ts";

export interface PluginsIpcDeps {
	settings(): Settings;
	saveSettings(next: Settings): Promise<unknown>;
}

export function registerPluginsIpc({ settings, saveSettings }: PluginsIpcDeps): void {
	const disabledPlugins = () => settings().disabledPlugins;
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
	 * A plugin is inert until the loader picks it up on the next session. An MCP bundle takes one
	 * step more: its servers are merged into settings, where the MCP page can show them, the user
	 * can point Filesystem at the right directory, and the session will actually connect to them.
	 * They arrive switched off — installing is not the same as trusting, and a server is a command
	 * that runs on this machine with this user's permissions.
	 */
	ipcMain.handle("registry:install", async (_event, entry: RegistryEntry, registryName?: string) => {
		try {
			const installed = await installEntry(entry, registryName);
			if (installed.kind === "mcp" && installed.servers.length > 0) {
				const current = settings();
				// Re-installing something replaces its servers rather than doubling them up.
				const others = current.mcpServers.filter((server) => server.origin?.bundle !== entry.id);
				await saveSettings({
					...current,
					mcpServers: [...others, ...installed.servers.map((server) => ({ ...server, enabled: false }))],
				});
			}
			return { ok: true as const, dir: installed.dir, kind: installed.kind, servers: installed.servers.length };
		} catch (cause) {
			return { ok: false as const, message: cause instanceof Error ? cause.message : String(cause) };
		}
	});

	/*
	 * Removing the directory is only half of it.
	 *
	 * An MCP bundle left rows behind in settings; leaving them there would keep a server the user
	 * just uninstalled in the list, still connectable, pointing at a command that is no longer on
	 * disk. `origin.bundle` is what ties the two together.
	 */
	ipcMain.handle("registry:uninstall", async (_event, id: string) => {
		await uninstallEntry(id);
		const current = settings();
		const remaining = current.mcpServers.filter((server) => server.origin?.bundle !== id);
		if (remaining.length !== current.mcpServers.length) {
			await saveSettings({ ...current, mcpServers: remaining });
		}
	});

	/**
	 * Bring what is on disk and what is in settings back into agreement.
	 *
	 * Every MCP bundle installed before the split went into `~/.lyra/plugins` and was loaded
	 * through the plugin's own `mcpServers` list — a path that no longer exists. Left alone, an
	 * upgrade would silently disconnect every MCP server anybody had installed: still on disk,
	 * still in the catalogue, connected to nothing.
	 *
	 * So anything on disk without a matching row gets one. It keeps the state it had, which for a
	 * bundle loaded the old way means "on unless the user switched this plugin off" — a migration
	 * that turns working servers off is as wrong as one that turns unknown servers on. Idempotent:
	 * the second call finds a row for everything and writes nothing.
	 */
	const reconcile = async (bundles: McpBundle[]): Promise<void> => {
		const current = settings();
		const known = new Set(current.mcpServers.map((server) => server.origin?.bundle).filter(Boolean));
		const missing = bundles.filter((bundle) => !known.has(bundle.id));
		if (missing.length === 0) return;

		const disabled = new Set(current.disabledPlugins);
		const restored = missing.flatMap((bundle) =>
			bundle.servers.map((server) => ({
				...server,
				enabled: !disabled.has("*") && !disabled.has(bundle.id),
			})),
		);
		await saveSettings({ ...current, mcpServers: [...current.mcpServers, ...restored] });
	};

	/**
	 * Move a bundle to the directory its kind belongs in.
	 *
	 * Cosmetic, deliberately: sorting reads the contents, so a bundle in the wrong place already
	 * works. This only keeps the two directories meaning what their names say, and a failure is
	 * ignored for exactly that reason — there is nothing to recover from.
	 */
	const tidy = async (bundles: McpBundle[]): Promise<void> => {
		const home = join(lyraHome(), "mcp");
		for (const bundle of bundles) {
			if (bundle.source !== "user" || bundle.dir.startsWith(home)) continue;
			await mkdir(home, { recursive: true }).catch(() => {});
			await rename(bundle.dir, join(home, basename(bundle.dir))).catch(() => {});
		}
	};

	ipcMain.handle("plugins:list", async (_event, cwd: string) => {
		const [plugins, skills] = await Promise.all([
			loadPlugins(
				[
					...(cwd ? [{ dir: join(cwd, ".lyra", "plugins"), source: "workspace" as const }] : []),
					{ dir: join(lyraHome(), "plugins"), source: "user" as const },
					// Both roots, because a bundle is sorted by what it holds — one installed before
					// the split is still filed under `plugins` and still has to come back as MCP.
					{ dir: join(lyraHome(), "mcp"), source: "user" as const },
				],
				disabledPlugins(),
			),
			loadSkills([
				...(cwd ? [{ dir: join(cwd, ".lyra", "skills"), source: "workspace" as const }] : []),
				{ dir: join(lyraHome(), "skills"), source: "user" as const },
			]),
		]);
		/*
		 * Done on the way out of a read, which is not where side effects usually belong.
		 *
		 * The alternative is a migration at startup, and this page is reached before the first
		 * session exists — someone opening 设置 › MCP on a fresh launch would see an empty list
		 * and conclude their servers were gone. Both are idempotent and both no-op once there is
		 * nothing left to fix, so the cost of running them here is a comparison per scan.
		 */
		await reconcile(plugins.mcpBundles);
		void tidy(plugins.mcpBundles);

		const looseNames = new Set(skills.skills.map((skill) => skill.name));
		return {
			plugins: plugins.plugins,
			mcpBundles: plugins.mcpBundles,
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
		const dir = join(pluginsDir(scope, cwd), "hello-lyra");
		await writeExamplePlugin(dir);
		await shell.openPath(dir);
		return dir;
	});
}

function pluginsDir(scope: "workspace" | "user", cwd: string): string {
	return scope === "workspace" ? join(cwd, ".lyra", "plugins") : join(lyraHome(), "plugins");
}

/**
 * Write a working example bundle.
 *
 * The format is only obvious once you have seen one, so this ships a manifest and a skill with a
 * real script — which is the whole of what a plugin is.
 *
 * It used to also drop a `.mcp.json` pointing at Context7, on the grounds that a bundle could
 * carry both. That is the shape the split removed, and shipping it as *the example* would have
 * taught every new plugin to be the thing the loader now warns about. An MCP server is installed
 * from the catalogue's MCP tab, or added by hand in 设置 › MCP.
 */
async function writeExamplePlugin(dir: string): Promise<void> {
	await mkdir(join(dir, ".lyra-plugin"), { recursive: true });
	await mkdir(join(dir, "skills", "changelog", "scripts"), { recursive: true });

	await writeFile(
		join(dir, ".lyra-plugin", "plugin.json"),
		`${JSON.stringify(
			{
				name: "hello-lyra",
				version: "0.1.0",
				description: "示例插件：一个技能加一份配套脚本。",
				author: { name: "You" },
				skills: "./skills/",
				interface: {
					displayName: "Hello Lyra",
					shortDescription: "示例插件，演示技能与脚本的打包方式",
					category: "Developer Tools",
					capabilities: ["Read", "Write"],
					brandColor: "#339CFF",
					defaultPrompt: ["用 changelog 技能整理最近的提交"],
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	await writeFile(
		join(dir, "skills", "changelog", "SKILL.md"),
		[
			"---",
			"name: changelog",
			"description: 整理 git 提交为分类变更日志。当用户要求写 changelog、发布说明、版本变更时使用。",
			"---",
			"",
			"# 整理变更日志",
			"",
			"1. 运行本技能自带的脚本拿到结构化提交：",
			"   `bash scripts/collect.sh 30`",
			"2. 按 Added / Changed / Fixed 归类",
			"3. 每条一句话，写清楚对用户的影响，不要写实现细节",
			"",
			"脚本路径相对于本技能目录，调用时请使用系统提示里给出的绝对路径。",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		join(dir, "skills", "changelog", "scripts", "collect.sh"),
		[
			"#!/usr/bin/env bash",
			"# Print the last N commits as `hash\\tsubject`, newest first.",
			"set -euo pipefail",
			'git log --oneline --no-merges -n "${1:-20}" --pretty=format:"%h%x09%s"',
			"",
		].join("\n"),
		{ encoding: "utf8", mode: 0o755 },
	);
}
