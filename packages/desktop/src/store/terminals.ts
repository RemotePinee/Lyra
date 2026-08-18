/**
 * Which terminals a project has open, and which one you are looking at.
 *
 * The shells themselves live in the main process and outlive everything here — this is only the
 * tab strip's view of them. Kept per project directory rather than per conversation, for the same
 * reason the shells are: a terminal is a thing running *in a project*, and moving between two
 * conversations in one repository should no more disturb it than switching browser tabs disturbs
 * a download.
 *
 * Outside React because two components need it — the strip in the pane's header and the pane
 * itself — and they are not in a position to pass it between them.
 */

import { create } from "zustand";
import type { TerminalTab } from "../../electron/ipc-types.ts";

interface TerminalsState {
	/** Tabs by project directory, in the order they were opened. */
	tabs: Record<string, TerminalTab[]>;
	/** Which tab each project is showing. */
	active: Record<string, string>;

	/** Take what the main process reports as the truth of what is running. */
	sync(cwd: string, tabs: TerminalTab[]): void;
	add(cwd: string, tab: TerminalTab): void;
	remove(cwd: string, id: string): void;
	select(cwd: string, id: string): void;
}

export const useTerminals = create<TerminalsState>((set, get) => ({
	tabs: {},
	active: {},

	sync: (cwd, tabs) => {
		const active = get().active[cwd];
		set({
			tabs: { ...get().tabs, [cwd]: tabs },
			// The tab that was showing may have exited while the pane was away.
			active: {
				...get().active,
				[cwd]: tabs.some((tab) => tab.id === active) ? active : (tabs[0]?.id ?? ""),
			},
		});
	},

	add: (cwd, tab) =>
		set({
			tabs: { ...get().tabs, [cwd]: [...(get().tabs[cwd] ?? []), tab] },
			active: { ...get().active, [cwd]: tab.id },
		}),

	remove: (cwd, id) => {
		const rest = (get().tabs[cwd] ?? []).filter((tab) => tab.id !== id);
		const active = get().active[cwd];
		set({
			tabs: { ...get().tabs, [cwd]: rest },
			/*
			 * Closing the tab you are on moves to a neighbour, not to nothing.
			 *
			 * The first survivor is close enough: with two or three tabs any choice is the one
			 * next to it, and a pane that went blank because the last click removed what it was
			 * showing would be the worse answer by far.
			 */
			active: { ...get().active, [cwd]: id === active ? (rest[0]?.id ?? "") : active },
		});
	},

	select: (cwd, id) => set({ active: { ...get().active, [cwd]: id } }),
}));
