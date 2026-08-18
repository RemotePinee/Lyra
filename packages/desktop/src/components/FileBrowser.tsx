import { Folder } from "lucide-react";
import { useCallback, useState } from "react";
import type { FileContents, FileEntry } from "../../electron/ipc-types.ts";
import { FileViewer } from "./FileViewer.tsx";
import { FileTree } from "./files/FileTree.tsx";
import { isDescendantPath } from "./files/paths.ts";
import { storedWidth } from "../layout-widths.ts";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { useNarrow } from "./useNarrow.ts";
import { useApp } from "../store.ts";

/** Below this a tree and a file cannot sit side by side and still be readable, so they stack. */
const TWO_COLUMN_MIN = 460;

/**
 * How wide the tree column is, and how far it may be dragged.
 *
 * It used to be a fixed 212, which is a reasonable share of a 380px panel and an absurd one of a
 * panel opened to full screen — a 212px list beside a 1200px editor. So it is a preference now,
 * remembered like the other two pane widths.
 */
const TREE_KEY = "ly.files.treeWidth";
const TREE_DEFAULT = 232;
const TREE_MIN = 168;
const TREE_MAX = 480;

/**
 * The project's files: a tree on the left, whatever it opened on the right.
 *
 * This file is the arrangement only. What the tree contains, what right-clicking it offers and what
 * happens to a file when you rename it all live in `files/` — the tree grew from "expand a folder,
 * open a file" into something with a clipboard, a selection and a dozen operations, and none of
 * that is about where the two columns sit.
 */
export function FileBrowser() {
	const workspace = useApp((s) => s.workspace);
	const [narrow, body] = useNarrow(TWO_COLUMN_MIN);

	const [treeWidth, setTreeWidth] = useState(() => storedWidth(TREE_KEY, TREE_DEFAULT, TREE_MIN, TREE_MAX));
	const resizeTree = useCallback((next: number) => {
		setTreeWidth(next);
		window.localStorage.setItem(TREE_KEY, String(next));
	}, []);

	const [openPath, setOpenPath] = useState<string | null>(null);
	const [contents, setContents] = useState<FileContents | null>(null);
	const [loadingFile, setLoadingFile] = useState(false);
	const [openName, setOpenName] = useState<string | null>(null);
	/**
	 * Unsaved edits, by path.
	 *
	 * Held here rather than in the viewer because the viewer is remounted whenever you open a
	 * different file — leaving them there would silently discard work on every click. Memory
	 * only, like the terminal's scrollback: they last as long as the app does.
	 */
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	const root = workspace?.path ?? null;

	const openFile = useCallback(async (entry: FileEntry) => {
		setOpenPath(entry.path);
		setOpenName(entry.name);
		setLoadingFile(true);
		try {
			const read = await window.lyra.files.read(entry.path);
			// A second click while this was in flight wins.
			setOpenPath((current) => {
				if (current === entry.path) setContents(read);
				return current;
			});
		} finally {
			setLoadingFile(false);
		}
	}, []);

	/** Re-read after a save so the viewer's "saved" baseline matches what is on disk. */
	const reread = useCallback(async (path: string) => {
		const read = await window.lyra.files.read(path);
		if (read) setContents(read);
	}, []);

	/**
	 * A rename or a move, which the open file has to survive.
	 *
	 * Both by path, and both silently wrong if ignored: the pane would keep showing a file at an
	 * address that no longer exists, and saving it would recreate the old one. A folder counts too —
	 * renaming `src` moves everything under it, including whatever is open.
	 */
	const onMoved = useCallback((from: string, to: string) => {
		const follow = (path: string) =>
			path === from ? to : isDescendantPath(from, path) ? to + path.slice(from.length) : null;

		setOpenPath((current) => (current && follow(current)) || current);
		setDrafts((current) => {
			const moved = Object.entries(current).map(([path, text]) => [follow(path) ?? path, text] as const);
			return Object.fromEntries(moved);
		});
	}, []);

	const onRemoved = useCallback((paths: string[]) => {
		const gone = (path: string) => paths.some((each) => path === each || isDescendantPath(each, path));

		setOpenPath((current) => {
			if (!current || !gone(current)) return current;
			setContents(null);
			setOpenName(null);
			return null;
		});
		setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !gone(path))));
	}, []);

	if (!workspace || !root) {
		return (
			<PanelEmpty icon={Folder} title="文件">
				先打开一个项目，这里显示它的文件。
			</PanelEmpty>
		);
	}

	return (
		<div ref={body} className="flex min-h-0 flex-1 flex-col">
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
			 * The radius is concentric with the panel: 12 outer, less its 1px border, less the 6px
			 * this sits in from it.
			 */}
			<div className={`flex min-h-0 flex-1 gap-1.5 p-1.5 ${narrow ? "flex-col" : ""}`}>
				{/*
				 * A frame around the tree card, so the drag handle can hang outside it.
				 *
				 * The card clips its own overflow — it has to, or a long filename spills past the
				 * rounded corner — and the handle straddles the seam by design. Same arrangement as
				 * `NavPane`: the frame carries the width, the card keeps the clipping.
				 */}
				<div
					// Named so a test can measure the column rather than guessing at which box it is.
					data-ly-tree-column
					className={`relative ${
						!narrow
							? "shrink-0"
							: openPath
								? // Enough of the tree to keep your place, with the file taking the rest.
									"max-h-[38%] min-h-[86px] shrink-0"
								: "flex-1"
					}`}
					style={narrow ? undefined : { width: treeWidth }}
				>
					<div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[5px] border border-line-soft bg-card/35">
						<FileTree
							root={root}
							openPath={openPath}
							dirtyPaths={new Set(Object.keys(drafts))}
							onOpen={(entry) => void openFile(entry)}
							onMoved={onMoved}
							onRemoved={onRemoved}
						/>
					</div>

					{/* Only where the two are side by side; stacked, there is no vertical seam to drag. */}
					{!narrow && (
						<ResizeHandle
							edge="end"
							width={treeWidth}
							min={TREE_MIN}
							max={TREE_MAX}
							onResize={resizeTree}
							onReset={() => resizeTree(TREE_DEFAULT)}
							label="调整文件树宽度"
						/>
					)}
				</div>

				{/*
				 * Stacked and with nothing open, the tree takes the whole panel rather than half.
				 *
				 * `min-w-0` is what makes the viewer's own wrapping work: a flex child defaults to
				 * `min-width: auto`, so it grows to its content instead of holding the column's
				 * width — and the text overflows the panel however it is told to wrap.
				 */}
				{(!narrow || openPath) && (
					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[5px] border border-line-soft">
						{!openPath ? (
							<p className="p-6 text-center text-detail text-ink-faint">选择左侧文件查看内容</p>
						) : loadingFile ? (
							<p className="ly-pulse p-6 text-center text-detail text-ink-faint">读取中…</p>
						) : !contents ? (
							<p className="p-6 text-center text-detail text-ink-faint">读不到这个文件</p>
						) : (
							<FileViewer
								// Keyed on the path so a different file gets a fresh editor rather than
								// inheriting the previous one's undo history and scroll position.
								key={openPath}
								path={openPath}
								name={openName ?? openPath}
								contents={contents}
								draft={drafts[openPath]}
								onDraft={(next) =>
									setDrafts((current) => {
										if (next === undefined) {
											if (!(openPath in current)) return current;
											const { [openPath]: _gone, ...rest } = current;
											return rest;
										}
										return { ...current, [openPath]: next };
									})
								}
								onSaved={() => void reread(openPath)}
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
