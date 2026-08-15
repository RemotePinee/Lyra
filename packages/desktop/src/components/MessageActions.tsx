import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Text } from "./Text.tsx";

/**
 * The row under a message: when it was written, and what you can do with it.
 *
 * One component for both sides of the transcript. What you want from a message you sent and
 * from a reply you received is the same thing in the same place, and two implementations of
 * that would drift — which is exactly what happened when the reply side was built separately
 * and came out as a bordered pill with relative times against the sent side's plain row.
 *
 * Whoever renders this owns the `group/msg` that reveals it, because the hover target is the
 * whole message, not this row. Height is held whether or not it is showing, so the transcript
 * does not reflow as the pointer travels down it.
 */
export function MessageActions({
	timestamp,
	text,
	className = "",
	children,
}: {
	timestamp: number;
	/** What the copy button puts on the clipboard. */
	text: string;
	className?: string;
	/** Anything this side of the transcript offers beyond copying — editing, on a sent message. */
	children?: React.ReactNode;
}) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<div
			className={`flex h-[18px] items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100 ${className}`}
		>
			<Text size="caption" tone="faint" numeric>
				{formatSentAt(timestamp)}
			</Text>
			<button
				type="button"
				data-dw-tip="复制"
				aria-label="复制这条消息"
				onClick={() => {
					void navigator.clipboard.writeText(text).then(() => setCopied(true));
				}}
				className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-card-hover hover:text-ink"
			>
				{copied ? <Check size={12.5} strokeWidth={2.2} className="dw-pop text-ok" /> : <Copy size={12.5} strokeWidth={1.8} />}
			</button>
			{children}
		</div>
	);
}

/** Same shape as the reference: month, day, time — the year only once it stops being obvious. */
export function formatSentAt(timestamp: number): string {
	const sent = new Date(timestamp);
	const sameYear = sent.getFullYear() === new Date().getFullYear();
	return sent.toLocaleString("zh-CN", {
		...(sameYear ? {} : { year: "numeric" }),
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
