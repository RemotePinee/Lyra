/**
 * What a new version is and what to do about it — a view of the download, not its owner.
 *
 * Every phase it draws comes from the main process, and every button it offers is a message sent
 * there. That is the whole design, and it is what makes the dialog closable while a download runs:
 * closing it stops nothing, because it was never holding anything. The previous version had the
 * download living inside this component's state, which forced two things that both read as bugs —
 * 以后再说 disabled mid-download, and the close gesture ignored — because leaving would have
 * orphaned a fetch nobody could then find or stop.
 *
 * The three controls are deliberately not the same three in every phase. A dialog that shows
 * 暂停, 继续 and 取消 at once, greying out two of them, is a control panel for a state machine;
 * what belongs on screen is the one or two things that make sense to do right now.
 */

import { Pause, Play, X } from "lucide-react";

import { confirmLabel, controlsFor, fractionOf, mb, type Phase } from "../../update/view.ts";
import { Overlay } from "./Overlay.tsx";
import { Scroller } from "../Scroller.tsx";

type Info = Awaited<ReturnType<typeof window.lyra.updates.check>>;

export function UpdateDialog({
	info,
	phase,
	onClose,
	onDismiss,
}: {
	info: Info;
	phase: Phase;
	onClose: () => void;
	/** 以后再说: hide the announcement for this version, in this window. */
	onDismiss: () => void;
}) {
	const fraction = fractionOf(phase);
	// Which of the four controls belong in this phase — the rules, and their tests, are in `view.ts`.
	const controls = controlsFor(phase);

	const confirm = () => {
		if (phase.at === "ready") return void window.lyra.updates.relaunch();
		void window.lyra.updates.download(info.latest);
	};

	return (
		/*
		 * Closable in every phase, including mid-download.
		 *
		 * This is the change the whole rewrite was for. The download does not belong to this window,
		 * so leaving does not interrupt it — the badge keeps its ring going, and coming back finds it
		 * where it was.
		 */
		<Overlay onClose={onClose} width={480}>
			<div className="px-5 pt-5 pb-3">
				<h2 className="text-label font-semibold text-ink">有新版本可以更新</h2>
				<p className="mt-1 text-detail text-ink-muted">
					{info.current} → <span className="font-medium text-ink">{info.latest}</span>
					{/* Only when the release said so — no date is better than a wrong one. */}
					{info.publishedAt && (
						<span className="pl-2 text-ink-faint">{new Date(info.publishedAt).toLocaleDateString("zh-CN")}</span>
					)}
					{info.asset && <span className="pl-2 text-ink-faint tabular-nums">{mb(info.asset.size)}</span>}
				</p>
			</div>

			{/*
			 * The release notes as written, scrolled rather than truncated.
			 *
			 * Shown as text and not rendered as Markdown: this is someone else's prose arriving over
			 * the network, and the dialog's job is to let it be read, not to give it a licence to lay
			 * itself out inside the app.
			 */}
			{info.notes && (
				<Scroller className="max-h-[240px] border-t border-line-soft" contentClassName="px-5 py-4">
					<p className="whitespace-pre-wrap text-label leading-relaxed text-ink-muted">{info.notes}</p>
				</Scroller>
			)}

			<div className="border-t border-line px-5 py-3">
				{fraction !== null && phase.at !== "ready" && (
					<div className="mb-3">
						<div className="mb-1.5 flex items-baseline justify-between text-detail">
							<span className="text-ink-muted">
								{phase.at === "downloading" && "正在下载"}
								{phase.at === "paused" && "已暂停"}
								{phase.at === "preparing" && "正在准备…"}
							</span>
							{(phase.at === "downloading" || phase.at === "paused") && (
								<span className="tabular-nums text-ink-faint">
									<span className="text-ink">{Math.round(fraction * 100)}%</span>
									<span className="pl-2">
										{mb(phase.received)} / {mb(phase.total)}
									</span>
								</span>
							)}
						</div>
						<div className="h-1 overflow-hidden rounded-full bg-ink/10">
							<div
								/*
								 * Paused is drawn in a quieter colour rather than by stopping the bar, because a
								 * bar that merely stops moving is indistinguishable from a stalled download —
								 * which is the other thing it could be, and the one that needs a different
								 * response from the person watching.
								 */
								className={`h-full rounded-full transition-[width,background-color] duration-200 ease-out ${
									phase.at === "paused" ? "bg-ink-faint" : "bg-info"
								}`}
								style={{ width: `${Math.max(2, fraction * 100)}%` }}
							/>
						</div>
					</div>
				)}

				{phase.at === "ready" && (
					<p className="mb-3 text-detail text-ok">
						已下载完成。重启 Lyra 即可用上新版本，正在进行的对话会中断。
					</p>
				)}
				{phase.at === "failed" && (
					<p className="mb-3 text-detail text-danger">
						{phase.error}
						{/* Said out loud, because "retry" otherwise reads as "start the 130MB again". */}
						{phase.received > 0 && (
							<span className="pl-1 text-ink-faint tabular-nums">（已下 {mb(phase.received)}）</span>
						)}
					</p>
				)}

				<div className="flex items-center gap-2">
					{/*
					 * 取消 sits on the left, apart from the pair on the right, because it is the only one
					 * that destroys something — the partial file goes with it. Only offered when there is
					 * something to cancel; on an untouched update it would be a second 以后再说.
					 */}
					{controls.cancel && (
						<button
							type="button"
							onClick={() => void window.lyra.updates.cancel()}
							className="flex h-[32px] items-center gap-1.5 rounded-lg px-2.5 text-label text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
						>
							<X size={13} strokeWidth={2} />
							取消下载
						</button>
					)}

					<div className="flex-1" />

					{controls.pause ? (
						<button
							type="button"
							onClick={() => void window.lyra.updates.pause()}
							className="flex h-[32px] items-center gap-1.5 rounded-lg border border-line px-3 text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:border-ink-faint hover:text-ink"
						>
							<Pause size={12} strokeWidth={2.2} fill="currentColor" />
							暂停
						</button>
					) : (
						<button
							type="button"
							onClick={onDismiss}
							className="h-[32px] rounded-lg border border-line px-3 text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:border-ink-faint hover:text-ink"
						>
							以后再说
						</button>
					)}

					{/*
					 * Falls back to the release page only when this platform has no installer in the
					 * release — better to hand over a link than to offer a button that cannot work.
					 */}
					{info.asset ? (
						<button
							type="button"
							// Only while it is genuinely working. Paused and failed are both actionable, and
							// disabling them was the old dialog's way of saying "wait", which it then never
							// stopped saying if the download had quietly died.
							disabled={controls.confirmDisabled}
							onClick={confirm}
							className="flex h-[32px] items-center gap-1.5 rounded-lg bg-ink px-3.5 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-50"
						>
							{phase.at === "paused" && <Play size={12} strokeWidth={2.2} fill="currentColor" />}
							{confirmLabel(phase)}
						</button>
					) : (
						<button
							type="button"
							onClick={() => {
								void window.lyra.updates.open(info.url);
								onClose();
							}}
							className="h-[32px] rounded-lg bg-ink px-3.5 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90"
						>
							查看发布页
						</button>
					)}
				</div>
			</div>
		</Overlay>
	);
}
