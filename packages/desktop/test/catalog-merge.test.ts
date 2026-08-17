/**
 * Merging three sources into one list, and getting each entry's kind right.
 *
 * The rule under test is the one the catalogue was rebuilt around: a bundle on disk is whatever
 * its contents make it, and a registry index cannot overrule that. It matters because the index
 * this was built against is wrong about seven of its nine entries — every MCP server in it is
 * listed as a plugin — so "trust the index" and "read the disk" produce different pages, and only
 * one of them matches what installing actually did.
 *
 * The last test is the grey screen: the main process does not hot-reload, so a renderer can be
 * talking to a build that has never heard of `mcpBundles`. That used to throw before anything
 * rendered, which took the whole window with it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpBundle, McpServerConfig, Plugin, RegistryEntry } from "@lyra/core";

import { isEnabled, isInstalled, merge } from "../src/components/plugins/catalog.ts";

function plugin(id: string, extra: Partial<Plugin> = {}): Plugin {
	return {
		id,
		dir: `/home/me/.lyra/plugins/${id}`,
		manifest: { name: id },
		source: "user",
		skills: [],
		enabled: true,
		...extra,
	};
}

function bundle(id: string, servers: McpServerConfig[]): McpBundle {
	return { id, dir: `/home/me/.lyra/mcp/${id}`, manifest: { name: id }, source: "user", servers };
}

function server(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id,
		name: id,
		transport: "stdio",
		command: "npx",
		args: [],
		enabled: false,
		...extra,
	} as McpServerConfig;
}

function entry(id: string, kind: RegistryEntry["kind"]): RegistryEntry {
	return { id, name: id, repository: `https://github.com/x/${id}.git`, kind };
}

test("an installed bundle keeps the kind its contents gave it, whatever the index claims", () => {
	// Exactly the case in the wild: Context7 is an MCP server, and the index calls it a plugin.
	const items = merge([], [bundle("context7", [server("context7__c7")])], [], [
		{ from: "Lyra Plugins", entry: entry("context7", "plugin") },
	]);

	assert.equal(items.length, 1, "one thing, not one per source");
	assert.equal(items[0].kind, "mcp");
	assert.equal(items[0].bundle?.id, "context7");
	assert.equal(items[0].entry?.id, "context7", "the registry half is still attached");
});

test("something only a registry knows about takes the kind the registry claims", () => {
	const items = merge([], [], [], [{ from: "r", entry: entry("playwright", "mcp") }]);

	assert.equal(items[0].kind, "mcp");
	assert.equal(isInstalled(items[0]), false);
});

test("a plugin and an MCP bundle of the same name do not collide into one row", () => {
	const items = merge([plugin("waza")], [bundle("context7", [server("c7")])], [], []);

	assert.deepEqual(
		items.map((item) => [item.id, item.kind]),
		[
			["waza", "plugin"],
			["context7", "mcp"],
		],
	);
});

test("an MCP bundle's servers come from settings, not from what it declared", () => {
	// The declaration is where it started; what the user has is what they edited on the MCP page.
	const configured = [
		server("context7__c7", { origin: { bundle: "context7" }, enabled: true, args: ["--mine"] }),
		server("hand-made"),
	];
	const items = merge([], [bundle("context7", [server("context7__c7")])], configured, []);

	assert.equal(items[0].servers.length, 1, "only the rows this bundle wrote");
	assert.deepEqual((items[0].servers[0] as { args?: string[] }).args, ["--mine"]);
	assert.equal(isEnabled(items[0]), true);
});

test("an MCP bundle with every server off is installed but not enabled", () => {
	const items = merge([], [bundle("memory", [server("m")])], [server("m", { origin: { bundle: "memory" } })], []);

	assert.equal(isInstalled(items[0]), true);
	assert.equal(isEnabled(items[0]), false, "installing is not turning on");
});

test("a disabled plugin is installed and not enabled, the same as a bundle with no server on", () => {
	const items = merge([plugin("waza", { enabled: false })], [], [], []);

	assert.equal(isInstalled(items[0]), true);
	assert.equal(isEnabled(items[0]), false);
});

test("a main process that has never heard of MCP bundles does not take the page down with it", () => {
	/*
	 * What an un-restarted dev server sends: the field is simply absent. Each of these threw, and
	 * a throw here is not a missing row — React unmounts the tree, so it was the whole window.
	 *
	 * `configured` is checked with a bundle present on purpose: it is only read inside that loop,
	 * so passing it as undefined with no bundles proves nothing at all.
	 */
	const missing = undefined as unknown as McpBundle[];
	const noSettings = undefined as unknown as McpServerConfig[];

	assert.doesNotThrow(() => merge([plugin("waza")], missing, [], []));
	assert.doesNotThrow(() => merge([], [bundle("context7", [server("c7")])], noSettings, []));
	assert.doesNotThrow(() => merge(missing as unknown as Plugin[], missing, noSettings, undefined as never));

	// And it still produces the rows it can: degraded, not blank.
	assert.equal(merge([plugin("waza")], missing, [], []).length, 1);
	assert.deepEqual(merge([], [bundle("context7", [server("c7")])], noSettings, [])[0].servers, []);
});
