/**
 * Reading the catalogue: the three sources, fetched and kept fresh.
 *
 * The shape of what comes out, and the rules for merging it, are in `catalog.ts` — separated
 * because those are decisions about data and these are decisions about when to ask for it. The
 * split is also what makes the merge testable without a renderer.
 */

import type { McpBundle, Plugin, RegistryEntry, Skill } from "@lyra/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useApp } from "../../store.ts";
import { merge, type CatalogItem } from "./catalog.ts";

export interface Catalog {
	items: CatalogItem[];
	skills: Skill[];
	/** Registries that answered with something other than a list. */
	errors: { url: string; message: string }[];
	diagnostics: { path: string; message: string }[];
	loading: boolean;
	/** Configured registry URLs, so an empty page can tell the difference from an empty registry. */
	sources: string[];
	refresh: () => void;
}

export function useCatalog(): Catalog {
	const workspace = useApp((s) => s.workspace);
	const settings = useApp((s) => s.settings);
	/*
	 * The shared "something was installed" signal.
	 *
	 * This view is not the only one showing these directories — 设置 › 插件 and the tab counts
	 * read them too — and any of them can be the one that changed them. Listening to the same
	 * counter is what stops the other pages from showing a moment ago.
	 */
	const extensionsNonce = useApp((s) => s.extensionsNonce);
	const bumpExtensions = useApp((s) => s.bumpExtensions);

	const [local, setLocal] = useState<{
		plugins: Plugin[];
		mcpBundles: McpBundle[];
		skills: Skill[];
		diagnostics: { path: string; message: string }[];
	}>({ plugins: [], mcpBundles: [], skills: [], diagnostics: [] });
	const [remote, setRemote] = useState<{ from: string; entry: RegistryEntry }[]>([]);
	const [errors, setErrors] = useState<{ url: string; message: string }[]>([]);
	const [loading, setLoading] = useState(true);
	const [nonce, setNonce] = useState(0);

	/*
	 * The configured list is a fresh array on every render and its contents almost never change.
	 * Keying the effect on the joined string and rebuilding from that is what stops every registry
	 * being re-fetched whenever an unrelated piece of state moves, and it keeps the dependency
	 * honest: the value the effect reads is the value it depends on.
	 */
	/*
	 * Both indexes, fetched as one list.
	 *
	 * They are configured separately because they answer separate questions, but by the time an
	 * entry is here it carries its own `kind` and the catalogue files it accordingly — a skill
	 * collection from the skill index and a plugin from the plugin index arrive as the same shape.
	 * Keeping two parallel fetches, two loading flags and two error lists would be two of everything
	 * to express one difference that is already in the data.
	 */
	const urlsKey = [...(settings?.pluginRegistries ?? []), ...(settings?.skillRegistries ?? [])].join("|");
	const urls = useMemo(() => (urlsKey ? urlsKey.split("|") : []), [urlsKey]);

	const cwd = workspace?.path ?? "";
	/** Re-scan when a plugin is switched on or off, which rewrites this list and nothing else. */
	const disabledKey = (settings?.disabledPlugins ?? []).join("|");

	// Both halves land independently; a slow registry must not hold back what is already on disk.
	useEffect(() => {
		let cancelled = false;
		void window.lyra.plugins.list(cwd).then((scan) => {
			if (cancelled) return;
			setLocal({
				plugins: scan.plugins ?? [],
				/*
				 * Defaulted, because the two processes can disagree about the shape.
				 *
				 * The main process does not hot-reload — change anything it imports and it keeps
				 * serving the previous build until the app is restarted, while the renderer already
				 * has the new code. During that window this field does not exist, and reading it as
				 * an array threw before anything was rendered: the whole view went grey, with no
				 * indication that the answer was "restart the dev server".
				 */
				mcpBundles: scan.mcpBundles ?? [],
				skills: scan.skills ?? [],
				diagnostics: scan.pluginDiagnostics ?? [],
			});
		});
		return () => {
			cancelled = true;
		};
	}, [cwd, disabledKey, nonce, extensionsNonce]);

	useEffect(() => {
		let cancelled = false;
		if (urls.length === 0) {
			setRemote([]);
			setErrors([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		void Promise.all(urls.map((url) => window.lyra.plugins.fetchRegistry(url))).then((results) => {
			if (cancelled) return;
			setRemote(
				results.flatMap((result) =>
					result.ok ? result.registry.entries.map((entry) => ({ from: result.registry.name, entry })) : [],
				),
			);
			setErrors(results.flatMap((result, i) => (result.ok ? [] : [{ url: urls[i], message: result.message }])));
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [urls, nonce]);

	/*
	 * Settings is where an MCP bundle's servers live, so the merge has to read it.
	 *
	 * Not the bundle's own `.mcp.json`: what the user has is whatever they edited on the MCP page
	 * — a Filesystem pointed at their own directory, a server they switched off. The declaration
	 * on disk is only the starting point it was installed from.
	 */
	const items = useMemo(
		() => merge(local.plugins, local.mcpBundles, settings?.mcpServers ?? [], remote, local.skills),
		// `settings` rather than `settings.mcpServers`: the list is a fresh array on every render,
		// the object it hangs off is not — it is only replaced when something is actually saved.
		[local.plugins, local.mcpBundles, settings, remote, local.skills],
	);

	/** Re-read here, and tell every other list that reads the same directories to do the same. */
	const refresh = useCallback(() => {
		setNonce((n) => n + 1);
		bumpExtensions();
	}, [bumpExtensions]);

	return {
		items,
		skills: local.skills,
		errors,
		diagnostics: local.diagnostics,
		loading,
		sources: urls,
		refresh,
	};
}

/*
 * Re-exported: every caller wants the hook and the model together, and having them reach into two
 * files to get one page's worth of types is a split showing through where it should not.
 */
export { groupByCategory, isEnabled, isInstalled, UNFILED, type CatalogItem } from "./catalog.ts";
