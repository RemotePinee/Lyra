/**
 * Token estimation, kept free of any runtime the browser does not have.
 *
 * Its own module rather than part of `runtime/compaction.ts`, and reachable as
 * `@deepwise/core/tokens`, because both sides of the app need it: the runtime to decide when
 * to compact, and the renderer to show how full the context window is. Importing it from the
 * package root would drag in the whole kernel — the bash tool, settings, the plugin loader —
 * and the first thing that happens then is `process is not defined`, with a white window.
 */

import type { Message } from "./types.ts";

export function estimateTokens(messages: Message[]): number {
	let chars = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const c of message.content) {
				if (c.type === "text") chars += c.text.length;
				else if (c.type === "thinking") chars += c.thinking.length;
				else chars += (c.argumentsText ?? JSON.stringify(c.arguments)).length + c.name.length;
			}
		} else {
			for (const c of message.content) {
				// A base64 image is worth roughly 1500 tokens regardless of its byte length.
				chars += c.type === "text" ? c.text.length : 6000;
			}
		}
	}
	// ~3.5 characters per token averaged over code and prose.
	return Math.ceil(chars / 3.5);
}
