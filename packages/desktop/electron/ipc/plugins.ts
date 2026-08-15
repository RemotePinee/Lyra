/**
 * Installing and listing plugins.
 *
 * Two kinds live side by side: what the workspace carries in `.lyra/plugins`, and what the user
 * installed for themselves. Both are directories of code, so both are listed with their source
 * attached — where a plugin came from is the first thing anyone asks when it misbehaves.
 */

import { ipcMain, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lyraHome, fetchRegistry, installEntry, loadPlugins, loadSkills, uninstallEntry } from "@lyra/core";
import type { RegistryEntry } from "../ipc-types.ts";

export interface PluginsIpcDeps {
	disabledPlugins(): string[];
}

export function registerPluginsIpc({ disabledPlugins }: PluginsIpcDeps): void {
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
					...(cwd ? [{ dir: join(cwd, ".lyra", "plugins"), source: "workspace" as const }] : []),
					{ dir: join(lyraHome(), "plugins"), source: "user" as const },
				],
				disabledPlugins(),
			),
			loadSkills([
				...(cwd ? [{ dir: join(cwd, ".lyra", "skills"), source: "workspace" as const }] : []),
				{ dir: join(lyraHome(), "skills"), source: "user" as const },
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
 * The format is only obvious once you have seen one, so this ships a manifest, a skill with a
 * real script, and an MCP declaration pointing at Context7 — the three pieces a plugin can carry.
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
				description: "示例插件：一个技能 + 配套脚本 + 一个 MCP 服务器。",
				author: { name: "You" },
				skills: "./skills/",
				mcpServers: "./.mcp.json",
				interface: {
					displayName: "Hello Lyra",
					shortDescription: "示例插件，演示技能、脚本与 MCP 的打包方式",
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
		join(dir, ".mcp.json"),
		`${JSON.stringify(
			{ mcpServers: { context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } } },
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
