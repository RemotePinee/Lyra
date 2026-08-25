import { useEffect, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { describeRetry } from "./retry-line.ts";
import { useCountUp } from "./useCountUp.ts";
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
	// Travelled to, not jumped to: usage lands per message, so this moves in steps of thousands.
	const counted = useCountUp(total);

	const [toolName, summary] = doing.split("\u0000");
	const elapsed = startedAt ? now - startedAt : 0;
	/*
	 * One reading of what is happening, drawn twice.
	 *
	 * The orb and the phrase are the same answer — see `thinking-words`. Deciding them separately
	 * was the obvious first shape and it is wrong: the two would disagree for a frame every time a
	 * tool started, which is exactly the moment anybody is looking at them.
	 */
	const mood = moodFor(toolName || undefined, summary, Boolean(retrying));
	const phrase = phraseFor(mood, tick, elapsed);

	return (
		/*
		 * Marked, because "is the turn still going" is a question asked from outside this file.
		 *
		 * The tests used to answer it by looking for the loader's own class — `.ly-flow`, the three
		 * dots — which tied every one of them to which loader this happens to draw. Swapping the
		 * loader is exactly the change that should not break them.
		 */
		<div data-ly-running className="ly-enter mb-2.5 flex items-center gap-2 text-detail text-ink-muted">
			{/*
			 * Decorative, so `aria-hidden`: the phrase beside it already says what this is, and a
			 * reader announcing the orb's own label before "Hunting…" is the same fact twice.
			 *
			 * `20` rather than a scaled-down 64 — the two sizes are separate designs in that
			 * library, each with its own dot count and speed, and this one is drawn to sit in a
			 * line of text. Theme stays on `auto`, which reads the `dark`/`light` class this app
			 * already puts on `<html>` and follows it live.
			 */}
			<ThinkingOrb aria-hidden state={mood} size={20} className="shrink-0" />
			{/*
			 * Keyed on the words so one fades in as the other goes, rather than swapping in place.
			 *
			 * The phrase is the line's subject and reads at full strength; the meter after it —
			 * elapsed, tokens, why the wait is long — is reference, and sits a step back. They were
			 * the same weight before, which made a row of five things with no order to read them in.
			 */}
			<span key={phrase} className="ly-fade-in">
				{phrase}…
			</span>
			<span className="text-ink-faint">·</span>
			{startedAt && <span className="text-ink-faint tabular-nums">{formatElapsed(now - startedAt)}</span>}
			{total > 0 && (
				<>
					<span className="text-ink-faint">·</span>
					{/* `tabular-nums` matters more while it is moving: without it the glyph widths
					    change every frame and the whole line shuffles sideways as the number climbs. */}
					<span className="text-ink-faint tabular-nums">{formatTokens(Math.round(counted))} tokens</span>
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
					<span className="text-ink-faint tabular-nums">{describeRetry(retrying, now)}</span>
				</>
			)}
		</div>
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
