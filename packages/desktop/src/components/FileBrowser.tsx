import { ChevronRight, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileContents, FileEntry } from "../../electron/ipc-types.ts";
import { FileViewer } from "./FileViewer.tsx";
import { iconColour, lookFor } from "./fileIcon.tsx";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { Scroller } from "./Scroller.tsx";
import { SearchField } from "./SearchField.tsx";
import { ScrollText } from "./ScrollText.tsx";
import { useNarrow } from "./useNarrow.ts";
import { useApp } from "../store.ts";

/** Below this a tree and a file cannot sit side by side and still be readable, so they stack. */
const TWO_COLUMN_MIN = 460;

interface TreeNode {
	entry: FileEntry;
	depth: number;
}

/**
 * The project's files, as a tree you can open things from.
 *
 * Lazily expanded, one directory at a time. A project with a `node_modules` in it has more
 * paths than anything would ever want to walk up front, and the only ones that matter are the
 * ones you have actually opened on the way to what you were looking for.
 */
export function FileBrowser() {
	const workspace = useApp((s) => s.workspace);
	const [narrow, body] = useNarrow(TWO_COLUMN_MIN);

	/** Directory contents, keyed by path — the cache and the expansion state in one. */
	const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(null);
	const [contents, setContents] = useState<FileContents | null>(null);
	const [loadingFile, setLoadingFile] = useState(false);
	/**
	 * Unsaved edits, by path.
	 *
	 * Held here rather than in the viewer because the viewer is remounted whenever you open a
	 * different file — leaving them there would silently discard work on every click. Memory
	 * only, like the terminal's scrollback: they last as long as the app does.
	 */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [filter, setFilter] = useState("");

	const root = workspace?.path;

	const load = useCallback(async (dir: string) => {
		const entries = await window.deepwise.files.list(dir);
		setChildren((current) => ({ ...current, [dir]: entries }));
	}, []);

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
	useEffect(() => {
		if (running || !root) return;
		void load(root);
		for (const dir of openDirs.current) void load(dir);
	}, [running, root, load]);

	// Opening a different project starts from scratch rather than showing the old tree.
	useEffect(() => {
		setChildren({});
		setExpanded(new Set());
		setSelected(null);
		setContents(null);
		setDrafts({});
		setFilter("");
		if (root) void load(root);
	}, [root, load]);

	function toggleDirectory(path: string) {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else {
				next.add(path);
				if (!children[path]) void load(path);
			}
			return next;
		});
	}

	async function openFile(entry: FileEntry) {
		setSelected(entry.path);
		setLoadingFile(true);
		try {
			const read = await window.deepwise.files.read(entry.path);
			// A second click while this was in flight wins.
			setSelected((current) => {
				if (current === entry.path) setContents(read);
				return current;
			});
		} finally {
			setLoadingFile(false);
		}
	}

	/** Re-read after a save so the viewer's "saved" baseline matches what is on disk. */
	async function reread(path: string) {
		const read = await window.deepwise.files.read(path);
		if (read) setContents(read);
	}

	/**
	 * Flatten the opened parts of the tree into the rows actually on screen.
	 *
	 * While filtering, the whole loaded tree is walked rather than only what is expanded, and a
	 * directory is kept when anything under it matches. Searching only inside folders you had
	 * already opened would answer a question nobody asked — the point of typing a name is to
	 * find where it is, which is precisely what you do not yet know.
	 */
	const rows = useMemo<TreeNode[]>(() => {
		if (!root) return [];
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
		walk(root, 0);
		return out;
	}, [root, children, expanded, filter]);

	if (!workspace) {
		return (
			<PanelEmpty icon={Folder} title="文件">
				先打开一个项目，这里显示它的文件。
			</PanelEmpty>
		);
	}

	const activeName = selected ? (selected.split("/").filter(Boolean).pop() ?? selected) : null;

	return (
		<div ref={body} className="flex min-h-0 flex-1 flex-col">
			{/*
			 * A search box, not the project's name.
			 *
			 * The name is already on the composer and in the sidebar; a third copy of it bought a
			 * whole row and told you nothing. Finding a file in a tree you have not expanded yet
			 * is the thing this pane is actually for.
			 */}
			<div className="shrink-0 px-1.5 pb-1.5">
				<SearchField value={filter} onChange={setFilter} placeholder={`搜索 ${workspace.name} 内的文件`} />
			</div>

			{/*
			 * Two panes, each its own card, stacked when narrow and side by side when there is room.
			 *
			 * Both stay on screen either way. Swapping the tree out for the file — which is what
			 * this did at panel width — meant every look at a second file cost a trip back, and you
			 * could never see where the open one sat among its siblings. Turning the split ninety
			 * degrees keeps both, because vertical space is what a narrow panel has to spare.
			 *
			 * Separated by a gap rather than by a rule. A tree and an editor are two different
			 * things to look at, not two halves of one — the space between them says so more
			 * quietly than a line does, and it is what lets each keep its own rounded corners.
			 *
			 * `PANE_RADIUS` is concentric with the panel: 12 outer, less its 1px border, less the
			 * 6px this sits in from it.
			 */}
			<div className={`flex min-h-0 flex-1 gap-1.5 p-1.5 pt-0 ${narrow ? "flex-col" : ""}`}>
				<div
					className={`flex min-h-0 flex-col overflow-hidden rounded-[5px] border border-line-soft bg-card/35 ${
						!narrow
							? "w-[212px] shrink-0"
							: selected
								? // Enough of the tree to keep your place, with the file taking the rest.
									"max-h-[38%] min-h-[86px] shrink-0"
								: "flex-1"
					}`}
				>
					<Scroller className="flex-1" contentClassName="px-1 py-1" fadeColor="transparent">
						{rows.map(({ entry, depth }) => (
							<button
								key={entry.path}
								type="button"
								data-dw-tip={entry.path}
								onClick={() => (entry.isDirectory ? toggleDirectory(entry.path) : void openFile(entry))}
								className={`dw-scroll flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[12px] transition-colors ${
									// Marked at every width now that the tree stays visible beside what it opened.
									selected === entry.path ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover/60"
								}`}
								// Indent by depth; the guide is the offset itself rather than a rule.
								style={{ paddingLeft: 6 + depth * 12 }}
							>
								{entry.isDirectory ? (
									<ChevronRight
										size={11}
										strokeWidth={2.2}
										className="shrink-0 text-ink-faint transition-transform duration-150"
										style={expanded.has(entry.path) ? { transform: "rotate(90deg)" } : undefined}
									/>
								) : (
									// Keep the chevron's width so file names line up with directory names.
									<span className="w-[11px] shrink-0" />
								)}
								{(() => {
									const look = lookFor(entry.name, entry.isDirectory, expanded.has(entry.path));
									return (
										<look.Icon
											size={12.5}
											strokeWidth={1.75}
											className="shrink-0"
											style={{ color: iconColour(look) }}
										/>
									);
								})()}
								<ScrollText text={entry.name} className="min-w-0 flex-1" />
								{drafts[entry.path] !== undefined && (
									// The dot is the only trace an unsaved file leaves in the tree.
									<span
										data-dw-tip="有未保存的修改"
										className="h-[5px] w-[5px] shrink-0 rounded-full bg-info"
									/>
								)}
							</button>
						))}

						{rows.length === 0 && (
							<p className="px-2 py-6 text-center text-[12px] text-ink-faint">这个目录是空的</p>
						)}
					</Scroller>
				</div>

				{/*
				 * Stacked and with nothing open, the tree takes the whole panel rather than half.
				 *
				 * `min-w-0` is what makes the viewer's own wrapping work: a flex child defaults to
				 * `min-width: auto`, so it grows to its content instead of holding the column's
				 * width — and the text overflows the panel however it is told to wrap.
				 */}
				{(!narrow || selected) && (
					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[5px] border border-line-soft">
						{!selected ? (
							<p className="p-6 text-center text-[12px] text-ink-faint">选择左侧文件查看内容</p>
						) : loadingFile ? (
							<p className="dw-pulse p-6 text-center text-[12px] text-ink-faint">读取中…</p>
						) : !contents ? (
							<p className="p-6 text-center text-[12px] text-ink-faint">读不到这个文件</p>
						) : (
							<FileViewer
								// Keyed on the path so a different file gets a fresh editor rather than
								// inheriting the previous one's undo history and scroll position.
								key={selected}
								path={selected}
								name={activeName ?? selected}
								contents={contents}
								draft={drafts[selected]}
								onDraft={(next) =>
									setDrafts((current) => {
										if (next === undefined) {
											if (!(selected in current)) return current;
											const { [selected]: _gone, ...rest } = current;
											return rest;
										}
										return { ...current, [selected]: next };
									})
								}
								onSaved={() => void reread(selected)}
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
