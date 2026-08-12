import { ChevronRight, GitCompare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceDiffFile } from "../../electron/ipc-types.ts";
import { DiffView } from "./DiffView.tsx";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { Scroller } from "./Scroller.tsx";
import { SearchField } from "./SearchField.tsx";
import { iconColour, lookFor } from "./fileIcon.tsx";
import { useApp } from "../store.ts";

/**
 * The last meaningful segment of a path.
 *
 * `split("/").pop()` is not enough: git reports an untracked *directory* as `.claude/`, whose
 * final segment is the empty string — which showed up in the list as a row with an icon, a
 * status letter, and no name at all.
 */
function baseName(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

/** True for the trailing-slash form git uses when a whole directory is untracked. */
function isDirectory(path: string): boolean {
	return path.endsWith("/");
}

/**
 * Past this many changed lines, everything starts folded.
 *
 * Opening a review of a thousand-line change onto a thousand rendered lines buries the file
 * list you were going to navigate by. Under it, the change is small enough that showing it
 * outright saves a click.
 */
const FOLD_THRESHOLD = 400;

/**
 * Uncommitted changes, as one scrolling column.
 *
 * An accordion rather than a list beside a viewer. Reviewing what an agent did is *reading
 * through*, not looking something up: you go top to bottom, and being able to leave two files
 * open next to each other is worth more than being able to jump to a file by name. It also
 * needs no second column, which is what makes it work unchanged in a 368px panel.
 *
 * The surrounding card — border, radius, title bar — belongs to `SidePanel`, so this renders
 * the review and nothing else.
 */
export function ReviewPanel() {
	const workspace = useApp((s) => s.workspace);
	const running = useApp((s) => s.running);

	const [files, setFiles] = useState<WorkspaceDiffFile[]>([]);
	const [totals, setTotals] = useState({ added: 0, removed: 0 });
	const [branch, setBranch] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [filter, setFilter] = useState("");
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [folded, setFolded] = useState(false);

	const refresh = useCallback(async () => {
		if (!workspace) return;
		setLoading(true);
		try {
			const diff = await window.deepwise.diff.workspaceDiff(workspace.path);
			setFiles(diff.files);
			setTotals({ added: diff.added, removed: diff.removed });
			setBranch(diff.branch);

			/*
			 * Decide the starting state from the size of the change, not from what was open
			 * before — a refresh mid-review should not collapse what the user just expanded.
			 */
			const big = diff.added + diff.removed > FOLD_THRESHOLD;
			setFolded(big);
			setOpen((current) => {
				if (current.size > 0) return current;
				return big ? new Set() : new Set(diff.files.map((f) => f.path));
			});
		} finally {
			setLoading(false);
		}
	}, [workspace]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// The agent edits files as it works; re-read the diff once each turn settles.
	useEffect(() => {
		if (!running) void refresh();
	}, [running, refresh]);

	const visible = filter ? files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : files;

	function toggle(path: string) {
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{/* Where you are: which branch, compared against what. */}
			<div className="flex h-8 shrink-0 items-center gap-1.5 px-2.5">
				<GitCompare size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
				<span className="min-w-0 truncate text-[12px] text-ink-muted">
					{branch ? <span className="text-ink">{branch}</span> : "工作区"}
					<span className="px-1 text-ink-faint">→</span>
					未提交改动
				</span>
				<span className="shrink-0 font-mono text-[11.5px]">
					<span className="text-ok">+{totals.added.toLocaleString()}</span>{" "}
					<span className="text-danger">−{totals.removed.toLocaleString()}</span>
				</span>
				<div className="min-w-1 flex-1" />
				<button
					type="button"
					title="刷新"
					aria-label="刷新改动"
					onClick={() => void refresh()}
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink active:scale-90"
				>
					<RefreshCw size={12.5} strokeWidth={1.8} className={loading ? "dw-pulse" : undefined} />
				</button>
			</div>

			{!loading && files.length === 0 ? (
				<PanelEmpty icon={GitCompare} title="审阅改动">
					{!workspace
						? "先打开一个项目，这里显示它工作区里未提交的改动。"
						: workspace.isGitRepo
							? "当前工作区没有未提交的改动。"
							: "当前项目不是 Git 仓库，没有可以对比的改动。"}
				</PanelEmpty>
			) : (
				<>
					{files.length > 8 && (
						<div className="shrink-0 px-1.5 pb-1.5">
							<SearchField value={filter} onChange={setFilter} placeholder={`筛选 ${files.length} 个文件`} />
						</div>
					)}

					{folded && open.size === 0 && (
						<p className="shrink-0 px-2.5 pb-1.5 text-[11px] leading-relaxed text-ink-faint">
							改动较大，文件默认折叠。点击文件名展开。
						</p>
					)}

					{/*
					 * No edge fade here, unlike every other scroller in the app.
					 *
					 * It is drawn over the viewport, so it would wash out the very row that is
					 * pinned to the top — and a sticky header already says "there is more above"
					 * more plainly than a gradient does.
					 */}
					<Scroller className="flex-1" contentClassName="px-1.5 pb-2" fade={false}>
						{visible.map((file) => {
							const expanded = open.has(file.path);
							const look = lookFor(baseName(file.path), isDirectory(file.path));
							return (
								<div key={file.path} className="mb-0.5">
									{/*
									 * Pinned to the top of its own file while that file is on screen.
									 *
									 * Scroll into a three-hundred-line diff and the question becomes
									 * "which file am I in" — the name has to stay put to answer it.
									 * Each header sticks within its own wrapper, so the next one pushes
									 * the last one out on the way past, rather than stacking up.
									 *
									 * The opaque background is what makes that work at all: a
									 * transparent sticky row has the diff scrolling through it. It is
									 * the panel's own colour, so it is invisible until it does its job.
									 *
									 * No expanded state on the row. The chevron already says whether it
									 * is open, and a fill saying the same thing reads as a selection —
									 * which this is not; several can be open at once.
									 */}
									<button
										type="button"
										title={file.path}
										onClick={() => toggle(file.path)}
										aria-expanded={expanded}
										className="sticky top-0 z-10 flex w-full items-center gap-1.5 rounded-md bg-shell py-1.5 pr-2 pl-1 text-left text-[12px] text-ink-muted transition-colors hover:bg-card-hover"
									>
										<ChevronRight
											size={11}
											strokeWidth={2.2}
											className="shrink-0 text-ink-faint transition-transform duration-150"
											style={expanded ? { transform: "rotate(90deg)" } : undefined}
										/>
										<look.Icon size={12.5} strokeWidth={1.75} className="shrink-0" style={{ color: iconColour(look) }} />
										{/*
										 * The directory is what tells two `index.ts` apart, so it stays —
										 * truncated from the left, where the shared prefix is.
										 */}
										<span className="min-w-0 flex-1 truncate text-left" dir="rtl">
											<span dir="ltr">{file.path}</span>
										</span>
										<span className="shrink-0 font-mono text-[11px]">
											{file.added > 0 && <span className="text-ok">+{file.added}</span>}
											{file.added > 0 && file.removed > 0 && " "}
											{file.removed > 0 && <span className="text-danger">−{file.removed}</span>}
											{file.added === 0 && file.removed === 0 && <span className="text-ink-faint">—</span>}
										</span>
									</button>

									{/*
									 * Flush, with no card around it.
									 *
									 * A rounded border here had to be clipped to stop the diff's square row
									 * tints poking out of the corners — and that clip cut into the pinned
									 * line-number column, leaving a notch out of its top-left. The card was
									 * never carrying its weight anyway: each row already has its own fill,
									 * and the file name above it is pinned on an opaque strip, so the two
									 * things the border was separating were both already legible without it.
									 */}
									{expanded && (
										<div className="dw-enter mt-0.5 mb-1.5 border-y border-line-soft">
											{isDirectory(file.path) ? (
												<p className="px-3 py-4 text-center text-[11.5px] leading-relaxed text-ink-faint">
													整个目录都还没有被 Git 跟踪，暂时没有可对比的内容。
												</p>
											) : file.hunks.length === 0 ? (
												<p className="px-3 py-4 text-center text-[11.5px] text-ink-faint">
													这个文件没有可以按行对比的内容（二进制或过大）。
												</p>
											) : (
												<DiffView hunks={file.hunks} />
											)}
										</div>
									)}
								</div>
							);
						})}

						{visible.length === 0 && (
							<p className="px-2 py-6 text-center text-[12px] text-ink-faint">没有匹配的文件</p>
						)}
					</Scroller>
				</>
			)}
		</div>
	);
}
