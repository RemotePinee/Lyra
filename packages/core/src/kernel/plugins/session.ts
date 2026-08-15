import type { TurnContext, TurnMiddleware } from "../../runtime/turn.ts";
import type { Context, Plugin } from "../context.ts";
import { EVENTS, SESSION, type TurnPipeline } from "../services.ts";

/**
 * The turn pipeline, backed by the kernel's own event bus.
 *
 * `use` is a thin front door onto `onWaterfall`: a step registered here is a listener on
 * `agent/prepare`, and the ordering rule is the bus's rather than a second one invented next to it
 * — first registered is outermost, it sees the turn first and the result last.
 *
 * Going through the bus is the point. A plugin that never imports this registry can still take part
 * by listening to the event, and one that does can be disposed by the context along with everything
 * else it installed. Two mechanisms for the same job would mean two places to look when a turn
 * comes out different from what the code in front of you says it should.
 */
class Pipeline implements TurnPipeline {
	private readonly ctx: Context;
	private readonly disposers: (() => void)[] = [];

	constructor(ctx: Context) {
		this.ctx = ctx;
	}

	use(step: TurnMiddleware): () => void {
		const off = this.ctx.onWaterfall<[TurnContext], TurnContext>(EVENTS.turnPrepare, (turn, next) =>
			step(turn, next as (turn: TurnContext) => Promise<TurnContext>),
		);
		this.disposers.push(off);
		return () => {
			off();
			const at = this.disposers.indexOf(off);
			if (at >= 0) this.disposers.splice(at, 1);
		};
	}

	/**
	 * One middleware that dispatches to the bus.
	 *
	 * Always one, never a snapshot of the listeners: the host binds this once at boot, and a list
	 * captured then would be missing every plugin that loaded afterwards. With no listeners the
	 * waterfall calls its base directly, so the cost of the indirection is a promise per turn.
	 */
	all(): TurnMiddleware[] {
		return [
			(turn, next) =>
				this.ctx.waterfall<TurnContext>(EVENTS.turnPrepare, [turn], (final) => next((final as TurnContext) ?? turn)),
		];
	}
}

/**
 * The conversation, as something plugins can take part in.
 *
 * Empty by default: an ordinary turn is the session's own prompt and the messages so far, and
 * anything added here is added to every request the user pays for. The registry exists so that a
 * plugin with something genuinely per-turn to say has a way to say it.
 */
export const sessionPlugin: Plugin = {
	name: "session",
	apply(ctx: Context) {
		return ctx.provide<TurnPipeline>(SESSION, new Pipeline(ctx));
	},
};
