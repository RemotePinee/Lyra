/**
 * Everything the catalogue can show, from the three places it comes from.
 *
 * A bundle reaches this window down one of two paths: it was cloned from a registry, or somebody
 * put a directory in `~/.lyra/plugins`. Those are different facts about the same kind of thing,
 * and the page is not a good place to keep them apart — a card wants to say "this is Chrome, it
 * controls the browser, and you have it" without first asking which list it came out of.
 *
 * What it does have to keep apart is *what* the thing is. A plugin is a bundle of skills; an MCP
 * bundle is a server declaration that happened to arrive in a git repository. They install
 * differently (one lands on disk, the other also writes into settings), they are switched on
 * differently (one flag, versus one per server), and the catalogue used to call both of them
 * "插件" — which is how a page of nine entries came to be seven MCP servers wearing the wrong
 * word. `kind` is that distinction, read off the contents rather than taken on trust.
 *
 * The three sources are merged on `id`, once, and what comes out carries every half: `installed`
 * for a plugin on disk, `bundle` + `servers` for an MCP server on disk, `entry` for what a
 * registry says it is.
 */

import type { BundleKind, McpBundle, McpServerConfig, Plugin, RegistryEntry } from "@lyra/core";

/** Bundles with nothing to file them under. Not a category anyone chose — see `groupByCategory`. */
export const UNFILED = " unfiled";

export interface CatalogItem {
	/** Unique within the merged list; `id` alone collides between a registry and a local copy. */
	key: string;
	id: string;
	name: string;
	description: string;
	logo?: string;
	brandColor?: string;
	category: string;
	/**
	 * Which of the two things this is.
	 *
	 * For anything on disk it is a fact, read off what the directory holds. For anything still in
	 * a registry it is the index's claim, which installing corrects if the clone disagrees.
	 */
	kind: BundleKind;
	/** On disk as a plugin, with its skills and enabled state. */
	installed: Plugin | null;
	/** On disk as an MCP bundle, with what its `.mcp.json` declares. */
	bundle: McpBundle | null;
	/** The rows this MCP bundle put into settings, which is where its servers actually live. */
	servers: McpServerConfig[];
	/** Offered by a registry, with somewhere to clone it from. */
	entry: RegistryEntry | null;
	/** Which registry offered it, for the rare case of two offering the same name. */
	from: string | null;
}

/** On disk, either kind — the question every "do I have this" check is really asking. */
export function isInstalled(item: CatalogItem): boolean {
	return item.installed !== null || item.bundle !== null;
}

/**
 * Switched on, in whichever sense applies.
 *
 * A plugin has one flag. An MCP bundle has one per server it brought, and the honest summary is
 * "any of them": a bundle with two servers and one of them on is doing something.
 */
export function isEnabled(item: CatalogItem): boolean {
	if (item.installed) return item.installed.enabled;
	if (item.bundle) return item.servers.some((server) => server.enabled);
	return false;
}

/**
 * One list, with each bundle appearing once.
 *
 * Installed first, so that what you have keeps its own name and description — the manifest on disk
 * is the thing actually running, and a registry index that has drifted since it was cloned should
 * not rename it under you. The registry half is attached anyway, because it carries the homepage
 * and the repository, which the local copy has no idea about.
 *
 * `kind` follows the same rule and for the same reason: on disk it is known, so the index cannot
 * overrule it. That is the whole correction — an entry listed as a plugin whose directory holds
 * one `.mcp.json` comes back from here as what it is.
 */
export function merge(
	plugins: Plugin[],
	bundles: McpBundle[],
	configured: McpServerConfig[],
	remote: { from: string; entry: RegistryEntry }[],
): CatalogItem[] {
	/*
	 * Every list is defaulted, because three of the four crossed a process boundary to get here.
	 *
	 * The main process does not hot-reload: change what it imports and it goes on answering with
	 * the previous build while the renderer already has the new code. `mcpBundles` did not exist
	 * in that build, and iterating it threw before a single element was rendered — React unmounts
	 * the tree on an uncaught error, so the window went grey with nothing on it to read. A missing
	 * field should cost the rows it would have produced, not the page.
	 */
	plugins = plugins ?? [];
	bundles = bundles ?? [];
	configured = configured ?? [];
	remote = remote ?? [];

	const byId = new Map<string, CatalogItem>();

	for (const plugin of plugins) {
		const ui = plugin.manifest.interface;
		byId.set(plugin.id, {
			key: plugin.id,
			id: plugin.id,
			name: ui?.displayName ?? plugin.manifest.name ?? plugin.id,
			description: ui?.shortDescription ?? plugin.manifest.description ?? "",
			logo: ui?.logo,
			brandColor: ui?.brandColor,
			category: ui?.category ?? UNFILED,
			kind: "plugin",
			installed: plugin,
			bundle: null,
			servers: [],
			entry: null,
			from: null,
		});
	}

	for (const bundle of bundles) {
		const ui = bundle.manifest.interface;
		byId.set(bundle.id, {
			key: bundle.id,
			id: bundle.id,
			name: ui?.displayName ?? bundle.manifest.name ?? bundle.id,
			description: ui?.shortDescription ?? bundle.manifest.description ?? "",
			logo: ui?.logo,
			brandColor: ui?.brandColor,
			category: ui?.category ?? UNFILED,
			kind: "mcp",
			installed: null,
			bundle,
			// Matched on the directory name, which is what install stamped into every row it wrote.
			servers: configured.filter((server) => server.origin?.bundle === bundle.id),
			entry: null,
			from: null,
		});
	}

	for (const { from, entry } of remote) {
		const existing = byId.get(entry.id);
		if (existing) {
			existing.entry = entry;
			existing.from = from;
			// Only where the local copy said nothing; the manifest wins wherever it spoke.
			if (!existing.description) existing.description = entry.description ?? "";
			if (!existing.logo) existing.logo = entry.logo;
			if (existing.category === UNFILED && entry.category) existing.category = entry.category;
			continue;
		}
		byId.set(entry.id, {
			key: `${from}:${entry.id}`,
			id: entry.id,
			name: entry.name,
			description: entry.description ?? "",
			logo: entry.logo,
			brandColor: entry.brandColor,
			category: entry.category ?? UNFILED,
			kind: entry.kind,
			installed: null,
			bundle: null,
			servers: [],
			entry,
			from,
		});
	}

	return [...byId.values()];
}

/**
 * Group into the sections the page draws, in a stable order.
 *
 * Named categories come first, alphabetically — any other order would need a notion of importance
 * that nothing in a registry index provides, and inventing one (a "Featured" row picked by us)
 * would be a claim we cannot back. Whatever declared no category goes last, under a heading the
 * caller supplies, so the common case of a registry with no categories at all is one plain grid
 * rather than a section called 其他 containing everything.
 */
export function groupByCategory(items: CatalogItem[]): { category: string; items: CatalogItem[] }[] {
	const groups = new Map<string, CatalogItem[]>();
	for (const item of items) {
		const list = groups.get(item.category);
		if (list) list.push(item);
		else groups.set(item.category, [item]);
	}

	const named = [...groups.entries()]
		.filter(([category]) => category !== UNFILED)
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([category, items]) => ({ category, items: items.sort(byName) }));

	const unfiled = groups.get(UNFILED);
	return unfiled ? [...named, { category: UNFILED, items: unfiled.sort(byName) }] : named;
}

function byName(a: CatalogItem, b: CatalogItem): number {
	return a.name.localeCompare(b.name);
}
