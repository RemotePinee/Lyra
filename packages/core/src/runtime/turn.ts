/**
 * What goes into a turn, and who gets to change it.
 *
 * Between "the session decided to run a turn" and "the request went out" there is one place where
 * everything the model will see exists as a value: the prompt, the messages, the tools. This is
 * that place, made explicit so a plugin can add to it — the current branch, a house style guide, a
 * warning that production credentials are loaded — without editing the session.
 *
 * Middleware, not a list of hooks: each one calls `next` and may inspect what came back, so a
 * plugin can also decide not to delegate and own the turn outright. First registered is outermost,
 * matching the kernel's `waterfall`, so the order reads the same wherever you meet it.
 */

import type { Message, Tool } from "../types.ts";

export interface TurnContext {
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
	cwd: string;
}

export type TurnMiddleware = (
	turn: TurnContext,
	next: (turn: TurnContext) => Promise<TurnContext>,
) => Promise<TurnContext>;

let pipeline: TurnMiddleware[] = [];

export function useTurnPipeline(middleware: TurnMiddleware[] | null): void {
	pipeline = middleware ?? [];
}

/**
 * Run the turn through whatever is registered.
 *
 * With nothing registered this returns its argument, which is the case that has to stay free: most
 * turns pass through untouched and paying for an empty chain on every one of them would be a tax
 * on the common path.
 */
export async function prepareTurn(turn: TurnContext): Promise<TurnContext> {
	if (pipeline.length === 0) return turn;

	let next = async (final: TurnContext) => final;
	for (let i = pipeline.length - 1; i >= 0; i--) {
		const middleware = pipeline[i];
		const downstream = next;
		next = (current: TurnContext) => middleware(current, downstream);
	}
	return next(turn);
}
