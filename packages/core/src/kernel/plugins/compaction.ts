import { streamAssistant } from "../../ai/index.ts";
import { compactIfNeeded } from "../../runtime/compaction.ts";
import type { Message, ModelConfig, ProviderConfig } from "../../types.ts";
import type { Context, Plugin } from "../context.ts";
import { COMPACTION, type CompactionStrategy } from "../services.ts";

/**
 * Summarise the middle, keep the ends.
 *
 * The built-in answer to a full window: the oldest turns become a summary, the most recent ones
 * survive verbatim. It reads well afterwards and it is cheap, which is most of why it is the
 * default — but it is a policy, and a long-running agent with a different shape of work may want
 * a different one.
 */
class SummaryCompaction implements CompactionStrategy {
	compact(
		messages: Message[],
		model: ModelConfig,
		provider: ProviderConfig,
		streamFn?: typeof streamAssistant,
	): Promise<Message[] | null> {
		return compactIfNeeded(messages, model, provider, streamFn ?? streamAssistant);
	}
}

export const compactionPlugin: Plugin = {
	name: "compaction",
	apply(ctx: Context) {
		return ctx.provide<CompactionStrategy>(COMPACTION, new SummaryCompaction());
	},
};
