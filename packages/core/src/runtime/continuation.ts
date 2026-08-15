/**
 * Carrying on when a turn runs out of rounds.
 *
 * A turn is capped so that one runaway cannot spin forever, and a big piece of work legitimately
 * exceeds that cap — a full-stack project reaches it around the point the frontend starts. What
 * used to happen then was that the run stopped with half a plan and waited for someone to press
 * "continue", which is exactly the human intervention an unattended run exists to avoid.
 *
 * So it starts another turn while the plan says there is work left. Bounded, and safe to bound
 * loosely, because the two ways a run can be genuinely stuck are caught elsewhere: repetition ends
 * a turn with `stalled`, and a model that has stopped calling tools is nudged a few times and then
 * left alone.
 *
 * A policy, not a mechanism — hence a module of its own, and a set of questions it asks rather than
 * a session it reaches into.
 */

import type { AgentRunResult } from "../agent/loop.ts";
import type { TodoItem } from "../tools/todo.ts";
import type { Message } from "../types.ts";

/**
 * How many times a turn may run out of rounds and be restarted.
 *
 * Loose on purpose: a backstop against a bug in the conditions below, not a judgement about how
 * much work is reasonable. Ten is two thousand rounds — far past anything a real task needs, and
 * long before it the repetition watch would have called a genuine loop.
 */
export const MAX_CONTINUATIONS = 10;

export interface ContinuationDeps {
	/** Start another turn with the accumulated history. */
	run(messages: Message[]): Promise<AgentRunResult>;
	messages(): Message[];
	todos(): TodoItem[];
	aborted(): boolean;
	notify(message: string): Promise<void> | void;
}

export async function continueWhileWorkRemains(
	first: AgentRunResult,
	deps: ContinuationDeps,
): Promise<AgentRunResult> {
	let result = first;
	for (let extra = 0; extra < MAX_CONTINUATIONS; extra++) {
		if (result.reason !== "max_turns") break;
		if (deps.aborted()) break;

		const unfinished = deps.todos().filter((todo) => todo.status !== "completed");
		if (unfinished.length === 0) break;

		await deps.notify(`本轮步数用尽，清单里还有 ${unfinished.length} 项，继续执行。`);
		result = await deps.run(deps.messages());
	}
	return result;
}
