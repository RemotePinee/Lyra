import type { TurnMiddleware } from "../../runtime/turn.ts";
import type { Context, Plugin } from "../context.ts";
import { SESSION, type TurnPipeline } from "../services.ts";

class Pipeline implements TurnPipeline {
	private readonly middleware: TurnMiddleware[] = [];

	use(step: TurnMiddleware): () => void {
		this.middleware.push(step);
		return () => {
			const at = this.middleware.indexOf(step);
			if (at >= 0) this.middleware.splice(at, 1);
		};
	}

	all(): TurnMiddleware[] {
		return [...this.middleware];
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
		return ctx.provide<TurnPipeline>(SESSION, new Pipeline());
	},
};
