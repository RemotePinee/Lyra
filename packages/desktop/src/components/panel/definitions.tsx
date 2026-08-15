/**
 * Which panels exist right now, and whether each can be opened.
 *
 * The registry says what is registered; this says what is *available* — a file browser needs a
 * project, a trajectory needs a conversation. Deciding it once, here, is what lets the tab strip
 * and the chooser and the add menu all disable the same things for the same stated reason.
 */

import { allPanels, type PanelDefinition } from "../../panels/registry.ts";
import type { PanelKind } from "../../sideStore.ts";
import { useApp } from "../../store.ts";
import "../../panels/builtin.tsx";

/** A panel with its availability already decided, which is all a view needs. */
export type ResolvedPanel = Omit<PanelDefinition, "unavailable"> & { unavailable?: string };

export function usePanelDefinitions(): ResolvedPanel[] {
	const workspace = useApp((s) => s.workspace);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const state = { workspace: Boolean(workspace), session: Boolean(activeSessionId) };
	return allPanels().map((panel) => ({ ...panel, unavailable: panel.unavailable?.(state) }));
}

/** What a tab shows. A kind with no registered panel renders nothing rather than crashing. */
export function renderPanel(kind: PanelKind) {
	const panel = allPanels().find((p) => p.kind === kind);
	if (!panel) return null;
	const Body = panel.render;
	return <Body />;
}
