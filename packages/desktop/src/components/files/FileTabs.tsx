/**
 * The files this pane has had open, as a strip you can go back through.
 *
 * The pane held exactly one file and forgot it the moment you clicked another, so moving between
 * two files meant finding the second one in the tree every single time. Same idea as the terminal's
 * tabs, and for the same reason: once a pane holds several of something, choosing between them is
 * part of what the pane is.
 *
 * Where the toolbar used to be. Those controls are marks in the pane's header now — see
 * `FileActions` — which is what freed this row for something that changes as you work.
 */

import { X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { useOpenFile } from "../../store/openFile.ts";

export function FileTabs() {
	const tabs = useOpenFile((s) => s.tabs);
	/*
	 * The tab being opened wins over the one on screen, for the moment they differ.
	 *
	 * `path` only moves once the file's contents have arrived — that is what stopped the content
	 * area flickering — so highlighting `path` alone would leave a click unacknowledged until the
	 * read landed. The strip answers immediately; the content area answers when it has something.
	 */
	const open = useOpenFile((s) => s.opening ?? s.path);
	const drafts = useOpenFile((s) => s.drafts);
	const strip = useRef<HTMLDivElement>(null);

	/*
	 * Fade whichever end has more tabs beyond it, and only that end.
	 *
	 * A permanent fade on both sides dims the first and last tab of a strip that fits, which reads
	 * as those tabs being disabled. Driven from the scroll position so the softness means what it
	 * says: there is more this way.
	 */
	const markEdges = useCallback(() => {
		const el = strip.current;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		el.style.setProperty("--ly-fade-left", el.scrollLeft > 1 ? "18px" : "0px");
		el.style.setProperty("--ly-fade-right", el.scrollLeft < max - 1 ? "18px" : "0px");
	}, []);

	useEffect(markEdges, [markEdges, tabs.length]);

	// Keep the open file in view: it can be selected from the tree or the dropdown, which may
	// scroll it in from either end.
	useEffect(() => {
		if (!open) return;
		strip.current?.querySelector(`[data-file-tab="${CSS.escape(open)}"]`)?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
		});
		markEdges();
	}, [open, markEdges]);

	// One file is not a choice, and a row offering it is a row of noise taking height from the file.
	if (tabs.length < 2) return null;

	return (
		<div
			ref={strip}
			onScroll={markEdges}
			role="tablist"
			aria-label="打开的文件"
			className="ly-fade-tail flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1"
		>
			{tabs.map((tab) => {
				const current = tab.path === open;
				const unsaved = tab.path in drafts;
				return (
					<div
						key={tab.path}
						data-file-tab={tab.path}
						className={`group/tab flex h-[22px] shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 transition-colors duration-[var(--ly-t-quick)] ${
							current ? "bg-card-hover text-ink" : "text-ink-faint hover:text-ink"
						}`}
					>
						<button
							type="button"
							role="tab"
							aria-selected={current}
							data-ly-tip={tab.path}
							onClick={() =>
								void useOpenFile
									.getState()
									.open({ name: tab.name, path: tab.path, isDirectory: false, size: 0 })
							}
							className="max-w-[160px] truncate py-1 text-detail whitespace-nowrap"
						>
							{tab.name}
						</button>
						{/*
						 * Unsaved edits, in the place the ✕ would be.
						 *
						 * Swapped rather than shown beside it: a dot and a cross on a 22px tab is two
						 * marks fighting over four pixels, and pointing at the tab is what you do when
						 * you mean to close it — which is the moment the dot has to be a cross.
						 */}
						{unsaved ? (
							<span
								aria-label="未保存"
								className="mr-1 size-[5px] shrink-0 rounded-full bg-accent group-hover/tab:hidden"
							/>
						) : null}
						<button
							type="button"
							aria-label={`关闭 ${tab.name}`}
							onClick={() => useOpenFile.getState().closeTab(tab.path)}
							className={`rounded p-0.5 transition-opacity duration-[var(--ly-t-quick)] hover:bg-elevated ${
								current ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-60"
							} ${unsaved ? "hidden group-hover/tab:block" : ""}`}
						>
							<X size={11} strokeWidth={2.2} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
