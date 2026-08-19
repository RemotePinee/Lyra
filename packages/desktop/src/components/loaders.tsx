/**
 * The two things that say "working", and where each belongs.
 *
 * They are different shapes because they answer different questions. In the sidebar a row is one
 * mark among many and the question is *which* conversation is busy — so the mark stays inside the
 * space of a character and has to survive being 11px. In the transcript there is only ever one,
 * at the head of a line of text, and the question is whether the turn is still going — so three
 * dots, which read as a sentence that has not finished.
 *
 * Both come from SpinKit (tobiasahlin). Its numbers are worth copying rather than reinventing:
 * every animation there is on a sine curve, and the good ones layer two periods that do not divide
 * into each other, which is what stops a loop from looking like one. An earlier attempt at these
 * was written from scratch with `linear` and evenly spaced geometry, and read as mechanical for
 * precisely that reason.
 *
 * The motion is in `styles.css` — see the Loading section. The dots take their colour from
 * `currentColor` and so belong to whatever they are placed in; the breathing one walks the palette
 * itself, because the colour is carrying meaning there rather than matching a surround.
 */

/**
 * A pulse leaving a still centre, walking through the palette as it goes.
 *
 * For the sidebar. Nothing rotates and nothing travels, which is what makes it bearable at the
 * edge of vision — there may be several rows working at once, and a column of spinners all coming
 * round at their own rates is a column that will not let you read anything else.
 *
 * The colour walk (accent → info → violet, 2.4s) is what says how long it has been going: a glance
 * says alive, a second look says *still* alive, without anything speeding up or getting louder.
 */
export function BreatheLoader({ size = 14, className = "" }: { size?: number; className?: string }) {
	return (
		<span aria-hidden className={`ly-breathe shrink-0 ${className}`} style={{ width: size, height: size }}>
			{/* Two rings half a period apart, so one is always on its way out; `b` is the core. */}
			<i />
			<i />
			<b />
		</span>
	);
}

/**
 * Three dots with a wave passing through them.
 *
 * For the running indicator. Wider than it is tall, which is the point: it sits in a row of text
 * and a circle there would read as a bullet.
 */
export function FlowLoader({ size = 14, className = "" }: { size?: number; className?: string }) {
	return (
		<span
			aria-hidden
			className={`ly-flow shrink-0 ${className}`}
			/*
			 * Three dots need room to be three dots.
			 *
			 * At a square 14px each dot is under 4px with almost nothing between them, and the group
			 * reads as a smudge. Given the width of the arc it replaces plus half again, the dots are
			 * the same weight as the surrounding text and the gaps are legible.
			 */
			style={{ width: size * 1.5, height: size }}
		>
			<span />
			<span />
			<span />
		</span>
	);
}
