/**
 * Which panels the side panel can show.
 *
 * The list was a literal inside the component and a matching `if` chain further down, which meant
 * adding a panel touched both and nothing else could add one at all. Here each panel is a record —
 * label, icon, shortcut, when it is unavailable, and what to render — so the component only has to
 * loop, and a plugin can contribute one by registering it.
 *
 * `availability` is a predicate over the app state rather than a boolean, because whether a panel
 * can open changes while the app runs: the terminal needs a workspace, the side chat needs a
 * conversation, and both arrive after the panel list is first built.
 */

import type { ComponentType } from "react";
import type { GitCompare } from "lucide-react";
import type { PanelKind } from "../sideStore.ts";

export interface PanelAvailability {
	workspace: boolean;
	session: boolean;
}

export interface PanelDefinition {
	kind: PanelKind;
	label: string;
	icon: typeof GitCompare;
	shortcut: string;
	/** Why it cannot be opened right now, given the current state. */
	unavailable?(state: PanelAvailability): string | undefined;
	render: ComponentType;
}

const registered: PanelDefinition[][] = [];

export function registerPanels(panels: PanelDefinition[]): () => void {
	registered.push(panels);
	return () => {
		const at = registered.indexOf(panels);
		if (at >= 0) registered.splice(at, 1);
	};
}

/**
 * Every panel, in registration order, later registrations replacing earlier ones by kind.
 *
 * Same rule as the tool registry: a plugin that wants its own Git panel registers under `review`
 * and displaces the built-in, rather than having to prevent it from loading.
 */
export function allPanels(): PanelDefinition[] {
	const byKind = new Map<PanelKind, PanelDefinition>();
	for (const set of registered) for (const panel of set) byKind.set(panel.kind, panel);
	return [...byKind.values()];
}
