/**
 * Which directories are open, what is in them, and which rows that adds up to.
 *
 * Lazily expanded, one directory at a time. A project with a `node_modules` in it has more paths
 * than anything would ever want to walk up front, and the only ones that matter are the ones you
 * have actually opened on the way to what you were looking for.
 *
 * Kept apart from the component so the tree's state and the tree's drawing can be read separately —
 * and so the operations in `useFileActions` can say "re-read these two directories" without
 * reaching into a component's setState.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store.ts";
import { isDescendantPath, joinPath, relativeTo } from "./paths.ts";

export interface TreeNode {
	entry: FileEntry;
	depth: number;
}

export interface FileTree {
	/** Directory contents by path — the cache and the "has been opened" record in one. */
	children: Record<string, FileEntry[]>;
	expanded: Set<string>;
	rows: TreeNode[];
	filter: string;
	setFilter(next: string): void;
	/** The folder 在此文件夹中搜索 narrowed to, or null for the whole project. */
	scope: string | null;
	setScope(next: string | null): void;
	load(dir: string): Promise<FileEntry[]>;
	/** Re-read exactly these directories — what every operation does when it finishes. */
	refresh(dirs: Iterable<string>): Promise<void>;
	/** Re-read the root and everything currently open. */
	refreshOpen(): Promise<void>;
	toggle(path: string): void;
	expand(path: string): void;
	collapse(path: string): void;
	collapseAll(): void;
	/** Open every directory on the way to a path, so a newly created file can be selected. */
	reveal(path: string): Promise<void>;
}

export function useFileTree(root: string | null): FileTree {
	const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [scope, setScope] = useState<string | null>(null);

	const load = useCallback(async (dir: string) => {
		const entries = await window.lyra.files.list(dir);
		setChildren((current) => ({ ...current, [dir]: entries }));
		return entries;
	}, []);

	const refresh = useCallback(
		async (dirs: Iterable<string>) => {
			await Promise.all([...new Set(dirs)].map((dir) => load(dir)));
		},
		[load],
	);

	/*
	 * Re-read the tree when a turn ends.
	 *
	 * The agent writes files — that is most of what it does — and the panel was loading the tree
	 * once, when the project opened. Watching it work meant watching a list that had been true
	 * several minutes ago: files it had just created were simply absent. Every directory that is
	 * open gets re-read, since those are the ones being looked at.
	 */
	const running = useApp((s) => s.running);
	// A ref, so ending a turn re-reads whatever is open now without re-running on every expand.
	const openDirs = useRef(expanded);
	openDirs.current = expanded;

	const refreshOpen = useCallback(async () => {
		if (!root) return;
		await refresh([root, ...openDirs.current]);
	}, [root, refresh]);

	useEffect(() => {
		if (running || !root) return;
		void refreshOpen();
	}, [running, root, refreshOpen]);

	// Opening a different project starts from scratch rather than showing the old tree.
	useEffect(() => {
		setChildren({});
		setExpanded(new Set());
		setFilter("");
		setScope(null);
		if (root) void load(root);
	}, [root, load]);

	const expand = useCallback(
		(path: string) => {
			setExpanded((current) => {
				if (current.has(path)) return current;
				const next = new Set(current);
				next.add(path);
				return next;
			});
			void load(path);
		},
		[load],
	);

	const collapse = useCallback((path: string) => {
		setExpanded((current) => {
			if (!current.has(path)) return current;
			const next = new Set(current);
			next.delete(path);
			return next;
		});
	}, []);

	const toggle = useCallback(
		(path: string) => {
			setExpanded((current) => {
				const next = new Set(current);
				if (next.has(path)) next.delete(path);
				else {
					next.add(path);
					void load(path);
				}
				return next;
			});
		},
		[load],
	);

	const collapseAll = useCallback(() => setExpanded(new Set()), []);

	const reveal = useCallback(
		async (path: string) => {
			if (!root || !isDescendantPath(root, path)) return;
			// Every segment but the last: the last one is the file itself, which has nothing to open.
			const segments = relativeTo(root, path).split(/[/\\]/).slice(0, -1);
			let dir = root;
			const opened: string[] = [];
			for (const segment of segments) {
				dir = joinPath(dir, segment);
				opened.push(dir);
				await load(dir);
			}
			if (opened.length > 0) setExpanded((current) => new Set([...current, ...opened]));
		},
		[root, load],
	);

	/**
	 * Flatten the opened parts of the tree into the rows actually on screen.
	 *
	 * While filtering, the whole loaded tree is walked rather than only what is expanded, and a
	 * directory is kept when anything under it matches. Searching only inside folders you had
	 * already opened would answer a question nobody asked — the point of typing a name is to find
	 * where it is, which is precisely what you do not yet know.
	 */
	const rows = useMemo<TreeNode[]>(() => {
		const from = scope ?? root;
		if (!from) return [];
		const needle = filter.trim().toLowerCase();
		const out: TreeNode[] = [];

		const matches = (entry: FileEntry): boolean => entry.name.toLowerCase().includes(needle);
		const hasMatchBelow = (dir: string): boolean =>
			(children[dir] ?? []).some((entry) => matches(entry) || (entry.isDirectory && hasMatchBelow(entry.path)));

		const walk = (dir: string, depth: number) => {
			for (const entry of children[dir] ?? []) {
				if (!needle) {
					out.push({ entry, depth });
					if (entry.isDirectory && expanded.has(entry.path)) walk(entry.path, depth + 1);
					continue;
				}
				const deeper = entry.isDirectory && hasMatchBelow(entry.path);
				if (!matches(entry) && !deeper) continue;
				out.push({ entry, depth });
				// A directory on the path to a match opens itself; there is no point showing a
				// folder that matched and then hiding what matched inside it.
				if (deeper) walk(entry.path, depth + 1);
			}
		};
		walk(from, 0);
		return out;
	}, [root, scope, children, expanded, filter]);

	return {
		children,
		expanded,
		rows,
		filter,
		setFilter,
		scope,
		setScope,
		load,
		refresh,
		refreshOpen,
		toggle,
		expand,
		collapse,
		collapseAll,
		reveal,
	};
}
