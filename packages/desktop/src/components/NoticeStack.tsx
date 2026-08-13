import { X } from "lucide-react";
import { useEffect } from "react";
import { useApp } from "../store.ts";

const TONE: Record<string, string> = {
	info: "border-line bg-float text-ink-muted",
	warn: "border-accent/40 bg-accent/10 text-accent",
	error: "border-danger/40 bg-danger/10 text-danger",
};

export function NoticeStack() {
	const notices = useApp((s) => s.notices);
	const dismiss = useApp((s) => s.dismissNotice);

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
					className={`dw-enter pointer-events-auto flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12px] shadow-lg shadow-black/25 ${TONE[notice.level]}`}
				>
					<span className="min-w-0 flex-1 break-words">{notice.message}</span>
					<button type="button" onClick={() => dismiss(notice.id)} className="shrink-0 opacity-60 hover:opacity-100">
						<X size={12} strokeWidth={2} />
					</button>
				</div>
			))}
		</div>
	);
}
