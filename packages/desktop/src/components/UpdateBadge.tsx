/**
 * The one piece of the window that says a newer version exists.
 *
 * It is an icon button the size of the ones beside it, in a pale blue, and it carries no text. A
 * chip with the version number in it took the toolbar's attention for something that is not urgent
 * and is not about the document — the news is only "there is something", and the version, the date
 * and what changed all belong in the dialog, where there is room for them.
 *
 * Pressing it fetches the installer for *this* machine and opens it. Sending someone to a release
 * page to choose between four files is not an update mechanism: the page cannot know whether they
 * are on Apple silicon, and this can. What it deliberately does not do is replace the app itself —
 * this build is unsigned, so the last step is the platform's own installer, where the user is the
 * one who decides to trust it.
 */

import { ArrowDownToLine } from "lucide-react";
import { useEffect, useState } from "react";

import { Overlay } from "./modals/Overlay.tsx";
import { Scroller } from "./Scroller.tsx";

type Info = Awaited<ReturnType<typeof window.lyra.updates.check>>;

/** Rechecked this often while the window stays open; the main process caches under it. */
const EVERY_MS = 6 * 60 * 60 * 1000;

type Stage = { at: "idle" } | { at: "downloading"; percent: number } | { at: "opened" } | { at: "failed"; error: string };

export function UpdateBadge() {
	const [info, setInfo] = useState<Info | null>(null);
	const [open, setOpen] = useState(false);
	const [stage, setStage] = useState<Stage>({ at: "idle" });
	/** Dismissed for this version, in this window. Reappears for the next one. */
	const [hidden, setHidden] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		const check = () => {
			void window.lyra.updates
				.check()
				.then((next) => {
					if (alive) setInfo(next);
				})
				// The check is the app's business; its failure is not the user's.
				.catch(() => {});
		};
		check();
		const timer = window.setInterval(check, EVERY_MS);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, []);

	// Progress arrives from the main process, which is the only place that can see the stream.
	useEffect(() => {
		return window.lyra.updates.onProgress(({ received, total, done }) => {
			setStage(done ? { at: "opened" } : { at: "downloading", percent: total > 0 ? received / total : 0 });
		});
	}, []);

	if (!info?.available || hidden === info.latest) return null;

	const install = async () => {
		setStage({ at: "downloading", percent: 0 });
		const result = await window.lyra.updates.download(info.latest);
		if (!result.ok) setStage({ at: "failed", error: result.error ?? "下载失败" });
	};

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				data-ly-tip={`有新版本 ${info.latest}`}
				data-ly-tip-side="bottom"
				aria-label={`有新版本 ${info.latest}`}
				// The same 24×24 as the toolbar buttons it stands next to, so it reads as one of them.
				className="ly-update-dot flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[7px] transition-colors duration-[var(--ly-t-quick)]"
			>
				<ArrowDownToLine size={13} strokeWidth={2} />
			</button>

			{open && (
				<Overlay
					onClose={() => {
						// Not while it is fetching: closing would leave the download running with nothing
						// to report to.
						if (stage.at !== "downloading") setOpen(false);
					}}
					width={480}
				>
					<div className="px-5 pt-5 pb-3">
						<h2 className="text-label font-semibold text-ink">有新版本可以更新</h2>
						<p className="mt-1 text-detail text-ink-muted">
							{info.current} → <span className="font-medium text-ink">{info.latest}</span>
							{/* Only when the release said so — no date is better than a wrong one. */}
							{info.publishedAt && (
								<span className="pl-2 text-ink-faint">
									{new Date(info.publishedAt).toLocaleDateString("zh-CN")}
								</span>
							)}
						</p>
					</div>

					{/*
					 * The release notes as written, scrolled rather than truncated.
					 *
					 * Shown as text and not rendered as Markdown: this is someone else's prose arriving
					 * over the network, and the dialog's job is to let it be read, not to give it a
					 * licence to lay itself out inside the app.
					 */}
					{info.notes && (
						<Scroller className="max-h-[260px] border-t border-line-soft" contentClassName="px-5 py-4">
							<p className="whitespace-pre-wrap text-label leading-relaxed text-ink-muted">{info.notes}</p>
						</Scroller>
					)}

					<div className="border-t border-line px-5 py-3">
						{stage.at === "downloading" && (
							<div className="mb-3">
								<div className="mb-1.5 flex items-baseline justify-between text-detail">
									<span className="text-ink-muted">正在下载</span>
									<span className="text-ink tabular-nums">{Math.round(stage.percent * 100)}%</span>
								</div>
								<div className="h-1 overflow-hidden rounded-full bg-ink/10">
									<div
										className="h-full rounded-full bg-info transition-[width] duration-200 ease-out"
										style={{ width: `${Math.max(2, stage.percent * 100)}%` }}
									/>
								</div>
							</div>
						)}
						{stage.at === "opened" && (
							<p className="mb-3 text-detail text-ok">已下载完成，安装器已经打开。把 Lyra 拖进「应用程序」即可。</p>
						)}
						{stage.at === "failed" && <p className="mb-3 text-detail text-danger">{stage.error}</p>}

						<div className="flex items-center justify-end gap-2">
							<button
								type="button"
								disabled={stage.at === "downloading"}
								onClick={() => {
									setHidden(info.latest);
									setOpen(false);
								}}
								className="h-[32px] rounded-lg border border-line px-3 text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:border-ink-faint hover:text-ink disabled:opacity-40"
							>
								以后再说
							</button>
							{/*
							 * Falls back to the release page only when this platform has no installer in
							 * the release — better to hand over a link than to offer a button that cannot
							 * work.
							 */}
							{info.asset ? (
								<button
									type="button"
									disabled={stage.at === "downloading"}
									onClick={() => void install()}
									className="h-[32px] rounded-lg bg-ink px-3.5 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-50"
								>
									{stage.at === "opened" ? "重新打开安装器" : stage.at === "failed" ? "重试" : "下载安装"}
								</button>
							) : (
								<button
									type="button"
									onClick={() => {
										void window.lyra.updates.open(info.url);
										setOpen(false);
									}}
									className="h-[32px] rounded-lg bg-ink px-3.5 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90"
								>
									查看发布页
								</button>
							)}
						</div>
					</div>
				</Overlay>
			)}
		</>
	);
}
