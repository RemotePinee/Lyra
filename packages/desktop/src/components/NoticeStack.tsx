import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../store.ts";

/** Matches `.dw-leave` in the stylesheet; the row is removed once it has played. */
const LEAVE_MS = 160;

const TONE: Record<string, string> = {
	info: "border-line bg-float text-ink-muted",
	warn: "border-accent/40 bg-accent/10 text-accent",
	error: "border-danger/40 bg-danger/10 text-danger",
};

export function NoticeStack() {
	const notices = useApp((s) => s.notices);
	const remove = useApp((s) => s.dismissNotice);
	/*
	 * Held on screen for the length of the exit animation.
	 *
	 * The store drops a notice the moment it is dismissed, and a row that has left the array
	 * cannot animate — React has already unmounted it. Marking it first, removing it after, is
	 * what gives the animation something to play on.
	 */
	const [leaving, setLeaving] = useState<string[]>([]);

	const dismiss = useCallback(
		(id: string) => {
			setLeaving((current) => (current.includes(id) ? current : [...current, id]));
			setTimeout(() => {
				remove(id);
				setLeaving((current) => current.filter((each) => each !== id));
			}, LEAVE_MS);
		},
		[remove],
	);

	// Info notices are progress chatter from sub-agents; they should not pile up.
	useEffect(() => {
		const timers = notices
			.filter((n) => n.level === "info")
			.map((n) => setTimeout(() => dismiss(n.id), 6000));
		return () => timers.forEach(clearTimeout);
	}, [notices, dismiss]);

	if (notices.length === 0) return null;

	return (
		// Capped, not fixed: 360px is wider than the whole window at its minimum size.
		<div className="pointer-events-none absolute right-5 bottom-[132px] flex w-[min(360px,calc(100%-2.5rem))] flex-col gap-1.5">
			{notices.slice(-4).map((notice) => (
				<div
					key={notice.id}
					className={`pointer-events-auto flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12px] shadow-lg shadow-black/25 ${
						leaving.includes(notice.id) ? "dw-leave" : "dw-enter"
					} ${TONE[notice.level]}`}
				>
					<span className="min-w-0 flex-1 leading-[18px] break-words">{notice.message}</span>
					{/*
					 * Centred on the first line, not on the message.
					 *
					 * `items-start` puts the row's children at the top, and a 12px glyph at the top of an
					 * 18px line sits visibly above the text it belongs to. Giving the button the line's
					 * own height centres it there — and keeps it on the first line when the message wraps,
					 * which is where a dismiss control belongs.
					 */}
					<button
						type="button"
						onClick={() => dismiss(notice.id)}
						className="flex h-[18px] shrink-0 items-center opacity-60 transition-opacity hover:opacity-100"
						data-dw-tip="关闭"
						aria-label="关闭"
					>
						<X size={12} strokeWidth={2} />
					</button>
				</div>
			))}
		</div>
	);
}
