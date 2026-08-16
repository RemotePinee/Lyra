import { useEffect, useState } from "react";
import { moodFor, phraseFor } from "./thinking-words.ts";
import { useApp } from "../store.ts";

/**
 * What the agent is spending while it works: elapsed time and tokens so far.
 *
 * A long turn is otherwise mostly silence — tool cards scroll past with no sense of whether
 * this has been going for ten seconds or ten minutes, or what it has cost. Three dots said
 * "something is happening"; this says what.
 */
export function RunningIndicator() {
	const startedAt = useApp((s) => s.turnStartedAt);
	const tokens = useApp((s) => s.turnTokens);
	const messages = useApp((s) => s.messages);
	const retrying = useApp((s) => s.retrying);
	const [now, setNow] = useState(() => Date.now());
	/*
	 * The phrase advances on its own clock, slower than the seconds.
	 *
	 * Tied to the timer it would change four times a second and read as noise; changed only when
	 * the work changes it would sit still through a long install. Every few seconds is fast
	 * enough to look alive and slow enough to be read.
	 */
	const [tick, setTick] = useState(0);
	/** What the agent is doing right now, from the newest call that has not finished. */
	const doing = useApp((s) => {
		const runs = Object.values(s.toolRuns).filter((run) => run.status === "running");
		const newest = runs.sort((a, b) => b.startedAt - a.startedAt)[0];
		return newest ? `${newest.toolName}\u0000${newest.summary}` : "";
	});

	useEffect(() => {
		if (!startedAt) return;
		// Quarter-second so the seconds digit never appears to skip one.
		const timer = setInterval(() => setNow(Date.now()), 250);
		const words = setInterval(() => setTick((n) => n + 1), 4200);
		return () => {
			clearInterval(timer);
			clearInterval(words);
		};
	}, [startedAt]);

	// The reply still streaming has usage of its own; counting it keeps the number moving
	// between finished messages rather than jumping in steps.
	const last = messages[messages.length - 1];
	const live = last?.role === "assistant" && last.stopReason === "pending" ? last.usage.total : 0;
	const total = tokens + live;

	const [toolName, summary] = doing.split("\u0000");
	const elapsed = startedAt ? now - startedAt : 0;
	const phrase = phraseFor(moodFor(toolName || undefined, summary), tick, elapsed);

	return (
		<div className="ly-enter mb-2.5 flex items-center gap-2 text-detail text-ink-muted">
			<Spinner />
			{/* Keyed on the words so one fades in as the other goes, rather than swapping in place. */}
			<span key={phrase} className="ly-fade-in">
				{phrase}…
			</span>
			<span className="text-ink-faint">·</span>
			{startedAt && <span className="tabular-nums">{formatElapsed(now - startedAt)}</span>}
			{total > 0 && (
				<>
					<span className="text-ink-faint">·</span>
					<span className="tabular-nums">{formatTokens(total)} tokens</span>
				</>
			)}
			{/*
			 * Why the wait is longer than it should be, on the line that is already counting it.
			 *
			 * A dropped connection is not an event of its own to be announced elsewhere — it is
			 * the reason this particular turn is taking so long, and it stops being true the
			 * moment the turn does.
			 */}
			{retrying && (
				<>
					<span className="text-ink-faint">·</span>
					<span className="text-ink-faint">
						连接中断，{Math.round(retrying.delayMs / 1000)} 秒后重试（第 {retrying.attempt} 次）
					</span>
				</>
			)}
		</div>
	);
}

/**
 * The working mark: one hairline arc, sweeping.
 *
 * Deliberately monochrome. This sits beside a running count of seconds and tokens, and a
 * coloured mark there competes with the transcript for attention every time the agent works —
 * which is most of the time. Inheriting the text colour also means it reads as part of the line
 * it belongs to rather than as a badge stuck on the front of it.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
	/*
	 * Both numbers were picked at 14px, which is the only size that matters — it is what sits
	 * beside the running clock. A 2.2 stroke measured about 1.3 device-independent pixels once
	 * the viewBox scaled down, and the arc simply vanished into the track; 3.4 is the weight
	 * where the two are still legibly different at that size. The arc covers a bit under a
	 * third, enough to read as a segment sweeping rather than as a dot going round.
	 */
	const circumference = 2 * Math.PI * 9;
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={`ly-spin shrink-0 ${className}`}>
			<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3.4" className="text-ink-faint/25" />
			<circle
				cx="12"
				cy="12"
				r="9"
				fill="none"
				stroke="currentColor"
				strokeWidth="3.4"
				strokeLinecap="round"
				strokeDasharray={`${circumference * 0.3} ${circumference}`}
				className="text-ink-muted"
			/>
		</svg>
	);
}

function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${minutes % 60}m`;
	}
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}
