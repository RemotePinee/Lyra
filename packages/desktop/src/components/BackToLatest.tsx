/**
 * The way back down, offered only while there is a way back down.
 *
 * A transcript you have scrolled up in has no other route to the newest message than dragging all
 * the way — and while a turn is streaming, "all the way" keeps moving. So a button, floating just
 * above the composer where the last message would be.
 *
 * It is mounted whether or not it is shown, and animates on the two properties that read as
 * arriving from below: a small rise and a fade. Mounting it on demand would have it appear at full
 * opacity in its final position, which is the same picture as a layout glitch.
 *
 * `pointer-events` follow visibility — an invisible button that still swallows clicks over the
 * transcript is worse than no button.
 */

import { ArrowDown } from "lucide-react";

export function BackToLatest({ show, unread, onClick }: { show: boolean; unread: boolean; onClick: () => void }) {
	return (
		<div
			className={`pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center transition-[opacity,transform] duration-[var(--ly-t-base)] ease-out ${
				show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
			}`}
		>
			<button
				type="button"
				tabIndex={show ? 0 : -1}
				aria-hidden={!show}
				onClick={onClick}
				className={`ly-composer flex h-8 items-center gap-1.5 rounded-full border border-line-soft bg-float px-3.5 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink ${
					show ? "pointer-events-auto" : ""
				}`}
			>
				{/*
				 * Says "new" only when something actually arrived while you were up here. Otherwise
				 * this is navigation, not a notification, and a dot on it would be crying wolf.
				 */}
				{unread && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />}
				<ArrowDown size={13} strokeWidth={2} />
				{unread ? "有新内容" : "回到最新"}
			</button>
		</div>
	);
}
