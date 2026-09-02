/**
 * Making a transcript safe to hand to a different model than the one that wrote it.
 *
 * A reasoning block carries an opaque handle from whichever provider produced it: an Anthropic
 * thinking signature, a Responses reasoning item id, an encrypted payload replayed verbatim. Our
 * `ThinkingContent` keeps all of them in one `signature`/`encrypted` pair, because from the outside
 * they play the same role — and that is exactly what makes them dangerous to replay after a switch.
 * The encoders each check that a handle is *present*; none of them can tell whose it is. So an
 * Anthropic signature handed to the Responses API goes out as `id: "ErUBCkYIBRgCKkA..."`, and the
 * request is rejected outright rather than degraded.
 *
 * Dropping the handle leaves the reasoning text in place. The transcript still reads the same on
 * screen and the model still sees what was thought; what is lost is the provider's ability to
 * resume its own chain of thought, which was never portable in the first place.
 */

import type { Message } from "../types.ts";

/**
 * The transcript with pre-switch provider handles removed.
 *
 * Returns the original array when there is nothing to do, so the ordinary case — a session whose
 * model never changed — costs one comparison and allocates nothing.
 */
export function stripStaleHandles(messages: Message[], switchedAt: number | undefined): Message[] {
	if (!switchedAt || switchedAt <= 0) return messages;

	let changed = false;
	const out = messages.map((message, index) => {
		if (index >= switchedAt || message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}
		let touched = false;
		const content = message.content.map((block) => {
			if (block.type !== "thinking") return block;
			if (block.signature === undefined && block.encrypted === undefined) return block;
			touched = true;
			/*
			 * `redacted` goes too. It means "the text was filtered out but the payload is still
			 * replayable" — and once the payload is gone it is a block with nothing in it at all,
			 * which the Anthropic encoder would drop anyway and the others would send empty.
			 */
			const { signature: _signature, encrypted: _encrypted, redacted: _redacted, ...rest } = block;
			return rest;
		});
		if (!touched) return message;
		changed = true;
		return { ...message, content };
	});

	return changed ? out : messages;
}
