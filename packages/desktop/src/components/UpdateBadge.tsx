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

/**
 * `staged` is the update unpacked and waiting for a relaunch; `opened` is an installer handed to
 * the OS. They are different endings and the dialog has to say different things: one offers to
 * finish the job, the other has already done as much as it can.
 */
type Stage =
	| { at: "idle" }
	| { at: "downloading"; percent: number }
	| { at: "staged" }
	| { at: "opened" }
	| { at: "failed"; error: string };

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
			// `opened` provisionally: `install` upgrades it to `staged` if the update can be swapped
			// in, which is only known once the download call returns.
			setStage(done ? { at: "opened" } : { at: "downloading", percent: total > 0 ? received / total : 0 });
		});
	}, []);

	if (!info?.available || hidden === info.latest) return null;

	const install = async () => {
		setStage({ at: "downloading", percent: 0 });
		const result = await window.lyra.updates.download(info.latest);
		if (!result.ok) {
			setStage({ at: "failed", error: result.error ?? "下载失败" });
			return;
		}
		// The progress listener already moved this to `opened` on the last chunk; correct it when
		// what actually happened was a staged update waiting to be swapped in.
		if (result.relaunch) setStage({ at: "staged" });
	};

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				data-ly-tip={`有新版本 ${info.latest}`}
				data-ly-tip-side="bottom"
				aria-label={`有新版本 ${info.latest}`}
				/*
				 * Says what it is, rather than being a 24px icon among the window controls.
				 *
				 * It used to match the toolbar buttons beside it exactly — same size, same shape, no
				 * text — on the reasoning that it should read as one of them. It did, and that was
				 * the problem: a new version sat there for a whole release cycle and was reported as
				 * "there is no update", because nothing about a grey glyph next to the traffic lights
				 * suggests it is an announcement rather than another control.
				 *
				 * A pill with the version in it, in the accent colour. Still small, still out of the
				 * way, but now it is legible as news.
				 */
				className="ly-update-dot flex h-[24px] shrink-0 items-center gap-1 rounded-full px-2 text-detail font-medium whitespace-nowrap transition-opacity duration-[var(--ly-t-quick)]"
			>
				<ArrowDownToLine size={12} strokeWidth={2.2} />
				新版本 {info.latest}
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
						{stage.at === "staged" && (
							<p className="mb-3 text-detail text-ok">已下载完成。重启 Lyra 即可用上新版本，正在进行的对话会中断。</p>
						)}
						{stage.at === "opened" && (
							<p className="mb-3 text-detail text-ok">已下载完成，安装器已经打开，按它的提示装完即可。</p>
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
									onClick={() => void (stage.at === "staged" ? window.lyra.updates.relaunch() : install())}
									className="h-[32px] rounded-lg bg-ink px-3.5 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-50"
								>
									{stage.at === "staged"
										? "立即重启"
										: stage.at === "opened"
											? "重新打开安装器"
											: stage.at === "failed"
												? "重试"
												: "下载安装"}
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
