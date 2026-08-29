/**
 * OpenAI Chat Completions API adapter (`POST /v1/chat/completions`).
 */

import { toChatCompletionsMessages, toChatCompletionsTools } from "./openai-chat-completions-request.ts";
import type {
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
	ThinkingLevel,
	ToolCallContent,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { computeCost } from "../utils/pricing.ts";
import { fetchWithRetry, isRetryableError, retryStream, toolCallId } from "./retry.ts";
import { parseToolArguments, readSse } from "../utils/sse.ts";
import { describeFetchError, joinUrl, truncate } from "./anthropic-messages.ts";

const REASONING_EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	max: "high",
};

export const openaiChatCompletionsProvider: Provider = {
	api: "openai-chat-completions",
	stream: streamChatCompletions,
};

async function* streamChatCompletions(
	provider: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions,
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const startTime = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-chat-completions",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: startTime,
	};

	const thinkingEnabled = model.supportsThinking && options.thinking && options.thinking !== "off";

	const body: Record<string, unknown> = {
		model: model.modelId,
		messages: toChatCompletionsMessages(context.systemPrompt ?? "", context.messages),
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: options.maxTokens ?? model.maxOutputTokens,
		...(context.tools.length > 0 ? { tools: toChatCompletionsTools(context.tools), tool_choice: "auto" } : {}),
		...(model.supportsThinking && thinkingEnabled
			? {
					reasoning_effort: REASONING_EFFORT[options.thinking as Exclude<ThinkingLevel, "off">],
				}
			: {}),
		...(options.temperature !== undefined && !thinkingEnabled ? { temperature: options.temperature } : {}),
		...model.samplingParams,
		...options.samplingParams,
	};

	options.onPayload?.(body);

	const doFetch = options.fetch ?? globalThis.fetch;
	const inventedIds = new Map<number, string>();
	let refused = false;

	try {
		yield* retryStream(
			async function* attempt() {
				const response = await fetchWithRetry(
					doFetch,
					joinUrl(provider.baseUrl, "/chat/completions"),
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${provider.apiKey}`,
							...provider.headers,
						},
						body: JSON.stringify(body),
						signal: options.signal,
					},
					{
						attempts: options.retryAttempts,
						signal: options.signal,
						onRetry: options.onRetry,
					},
				);

				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					throw new Error(`HTTP ${response.status}: ${truncate(detail, 800)}`);
				}

				yield { type: "start", partial: { ...partial } } as StreamEvent;

				let currentTextIndex = -1;
				let currentThinkingIndex = -1;

				for await (const frame of readSse(response, options.signal)) {
					if (frame.data === "[DONE]") break;
					let event: Record<string, any>;
					try {
						event = JSON.parse(frame.data);
					} catch {
						continue;
					}

					if (event.usage) {
						partial.usage.input = event.usage.prompt_tokens ?? 0;
						partial.usage.output = event.usage.completion_tokens ?? 0;
						partial.usage.cacheRead = event.usage.prompt_tokens_details?.cached_tokens ?? 0;
						partial.usage.cacheWrite = 0;
						partial.usage.total = partial.usage.input + partial.usage.output;
						partial.usage = computeCost(partial.usage, model);
					}

					const choice = event.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta;
					if (delta) {
						// Handle reasoning_content if emitted (e.g. DeepSeek/Ollama/relay APIs)
						if (delta.reasoning_content) {
							if (currentThinkingIndex === -1) {
								currentThinkingIndex = partial.content.length;
								partial.content.push({ type: "thinking", thinking: "" });
								yield { type: "thinking_start", index: currentThinkingIndex };
							}
							const thinkingBlock = partial.content[currentThinkingIndex];
							if (thinkingBlock && thinkingBlock.type === "thinking") {
								thinkingBlock.thinking += delta.reasoning_content;
								yield {
									type: "thinking_delta",
									index: currentThinkingIndex,
									delta: delta.reasoning_content,
									partial: { ...partial },
								};
							}
						}

						if (delta.content) {
							if (currentThinkingIndex !== -1) {
								yield { type: "thinking_end", index: currentThinkingIndex };
								currentThinkingIndex = -1;
							}
							if (currentTextIndex === -1) {
								currentTextIndex = partial.content.length;
								partial.content.push({ type: "text", text: "" });
								yield { type: "text_start", index: currentTextIndex };
							}
							const textBlock = partial.content[currentTextIndex];
							if (textBlock && textBlock.type === "text") {
								textBlock.text += delta.content;
								yield {
									type: "text_delta",
									index: currentTextIndex,
									delta: delta.content,
									partial: { ...partial },
								};
							}
						}

						if (delta.tool_calls) {
							if (currentThinkingIndex !== -1) {
								yield { type: "thinking_end", index: currentThinkingIndex };
								currentThinkingIndex = -1;
							}
							if (currentTextIndex !== -1) {
								yield { type: "text_end", index: currentTextIndex };
								currentTextIndex = -1;
							}

							for (const tc of delta.tool_calls) {
								const tcIndex = tc.index ?? 0;
								let block = partial.content.find(
									(c): c is ToolCallContent => c.type === "toolCall" && (c as any)._tcIndex === tcIndex,
								);

								if (!block) {
									const id = toolCallId(tc.id, tcIndex, inventedIds);
									const name = tc.function?.name || "";
									const toolCallIndex = partial.content.length;
									const newBlock: ToolCallContent = {
										type: "toolCall",
										id,
										name,
										arguments: {},
										argumentsText: "",
										...({ _tcIndex: tcIndex } as any),
									};
									partial.content.push(newBlock);
									block = newBlock;
									yield { type: "toolcall_start", index: toolCallIndex, id, name };
								}

								if (tc.function?.name && !block.name) {
									block.name = tc.function.name;
								}

								if (tc.function?.arguments) {
									block.argumentsText = (block.argumentsText || "") + tc.function.arguments;
									const blockIndex = partial.content.indexOf(block);
									yield {
										type: "toolcall_delta",
										index: blockIndex >= 0 ? blockIndex : tcIndex,
										delta: tc.function.arguments,
										partial: { ...partial },
									};
								}
							}
						}
					}

					if (choice.finish_reason) {
						if (choice.finish_reason === "stop") {
							partial.stopReason = "stop";
						} else if (choice.finish_reason === "tool_calls") {
							partial.stopReason = "toolUse";
						} else if (choice.finish_reason === "length") {
							partial.stopReason = "length";
						}
					}
				}

				if (currentThinkingIndex !== -1) {
					yield { type: "thinking_end", index: currentThinkingIndex };
				}
				if (currentTextIndex !== -1) {
					yield { type: "text_end", index: currentTextIndex };
				}

				// Parse JSON args for all tool calls
				for (let i = 0; i < partial.content.length; i++) {
					const c = partial.content[i];
					if (c.type === "toolCall") {
						c.arguments = parseToolArguments(c.argumentsText || "{}") ?? {};
						delete (c as any)._tcIndex;
						yield { type: "toolcall_end", index: i, partial: { ...partial } };
					}
				}
			},
			{
				attempts: options.retryAttempts,
				signal: options.signal,
				onRetry: options.onRetry,
				reset: () => {
					partial.content = [];
					partial.usage = emptyUsage();
					inventedIds.clear();
				},
			},
		);
		if (refused) return partial;
	} catch (error) {
		const aborted = options.signal?.aborted;
		partial.stopReason = aborted ? "aborted" : "error";
		partial.errorMessage = aborted ? "Aborted by user" : describeFetchError(error, options.signal);
		partial.errorRetryable = !aborted && isRetryableError(error);
		partial.usage = computeCost(partial.usage, model);
		partial.durationMs = Math.max(1, Date.now() - startTime);
		yield {
			type: "error",
			error: partial.errorMessage,
			message: { ...partial },
		};
		return partial;
	}

	partial.durationMs = Math.max(1, Date.now() - startTime);
	if (partial.stopReason === "pending") {
		const hasToolCalls = partial.content.some((c) => c.type === "toolCall");
		partial.stopReason = hasToolCalls ? "toolUse" : "stop";
	}

	yield { type: "done", message: partial };
	return partial;
}
