/**
 * Painting a streamed reply at the screen's pace, not the network's.
 *
 * A reply arrives as a `message_update` per token — several hundred a second on a fast model. Each
 * one used to be a store write and therefore a render of the whole transcript, so the app spent all
 * of its time redrawing four hundred rows to show one more word. Nobody can read at that rate: the
 * screen refreshes sixty times a second, and every update between two frames is work whose result
 * is overwritten before it is seen.
 *
 * So updates are held and applied once per frame. What lands on screen is identical — the same
 * final text, arriving at the same moment — because only the newest update matters and it is the
 * one that gets applied.
 *
 * Everything else flushes first. An update that has not landed yet, followed by the `message_end`
 * that settles it or a `tool_start` that comes after it, would otherwise be applied out of order —
 * and out-of-order is how a transcript ends up showing a card above the sentence introducing it.
 */

type Flush = () => void;

let pending: Flush | null = null;
let frame: number | null = null;

/**
 * Do this on the next frame, replacing anything else that was waiting.
 *
 * Replacing rather than queueing is the point: two updates to the same message are not two things
 * to do, they are one thing whose newer version won.
 */
export function coalesce(work: Flush): void {
	pending = work;
	if (frame !== null) return;
	frame = requestAnimationFrame(() => {
		frame = null;
		const run = pending;
		pending = null;
		run?.();
	});
}

/** Apply whatever is waiting, now. Call before anything that must land after it. */
export function flushCoalesced(): void {
	if (frame !== null) {
		cancelAnimationFrame(frame);
		frame = null;
	}
	const run = pending;
	pending = null;
	run?.();
}
