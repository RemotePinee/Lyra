/**
 * Which file is open, and what has been typed into it.
 *
 * Its own store because the file and the tree are two panes now, and a pane cannot hold state its
 * sibling needs. It used to live inside the file browser, which was the right place while the
 * browser *was* both halves — the tree on the left, the file on the right, one component owning
 * the pair. Splitting them into panes that can be moved, resized and closed independently means
 * the thing they share has to sit outside both.
 *
 * Memory only, like the terminal's scrollback. Restoring an editor full of unsaved edits from a
 * previous launch is a promise this cannot keep — the file may have changed underneath it — so the
 * dock remembers that the pane was open and the pane comes back empty.
 */

import { create } from "zustand";
import type { FileContents, FileEntry } from "../../electron/ipc-types.ts";
import { isDescendantPath } from "../components/files/paths.ts";

interface OpenFileState {
	path: string | null;
	/** The file's own name, so the pane can be titled before its contents arrive. */
	name: string | null;
	contents: FileContents | null;
	loading: boolean;
	/**
	 * Unsaved edits, by path.
	 *
	 * Kept for every file touched, not just the open one: the editor is remounted whenever a
	 * different file is opened, so anything held inside it would be silently discarded on every
	 * click through the tree.
	 */
	drafts: Record<string, string>;

	open(entry: FileEntry): Promise<void>;
	/** Re-read after a save, so the editor's "saved" baseline matches what is on disk. */
	reread(path: string): Promise<void>;
	setDraft(path: string, text: string | undefined): void;
	/**
	 * A rename or a move the open file has to survive.
	 *
	 * By path, and silently wrong if ignored: the pane would go on showing a file at an address
	 * that no longer exists, and saving it would recreate the old one. Folders count too —
	 * renaming `src` moves everything under it, including whatever is open.
	 */
	moved(from: string, to: string): void;
	removed(paths: string[]): void;
	/** Let go of everything. Used when the project changes: the paths belong to the old one. */
	clear(): void;
}

const EMPTY = { path: null, name: null, contents: null, loading: false } as const;

export const useOpenFile = create<OpenFileState>((set, get) => ({
	...EMPTY,
	drafts: {},

	async open(entry) {
		set({ path: entry.path, name: entry.name, loading: true });
		try {
			const read = await window.lyra.files.read(entry.path);
			// A second click while this was in flight wins.
			if (get().path === entry.path) set({ contents: read });
		} finally {
			if (get().path === entry.path) set({ loading: false });
		}
	},

	async reread(path) {
		const read = await window.lyra.files.read(path);
		if (read && get().path === path) set({ contents: read });
	},

	setDraft(path, text) {
		const drafts = get().drafts;
		if (text === undefined) {
			if (!(path in drafts)) return;
			const { [path]: _gone, ...rest } = drafts;
			set({ drafts: rest });
			return;
		}
		set({ drafts: { ...drafts, [path]: text } });
	},

	moved(from, to) {
		const follow = (path: string) =>
			path === from ? to : isDescendantPath(from, path) ? to + path.slice(from.length) : path;

		const { path, drafts } = get();
		if (path) {
			const next = follow(path);
			if (next !== path) set({ path: next, name: next.slice(next.lastIndexOf("/") + 1) });
		}
		set({ drafts: Object.fromEntries(Object.entries(drafts).map(([at, text]) => [follow(at), text])) });
	},

	removed(paths) {
		const gone = (path: string) => paths.some((each) => path === each || isDescendantPath(each, path));
		const { path, drafts } = get();
		if (path && gone(path)) set({ ...EMPTY });
		set({ drafts: Object.fromEntries(Object.entries(drafts).filter(([at]) => !gone(at))) });
	},

	clear: () => set({ ...EMPTY, drafts: {} }),
}));
