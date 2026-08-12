import type {
	ApiFormat,
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
} from "../types.ts";
import { anthropicMessagesProvider } from "./anthropic-messages.ts";
import { openaiResponsesProvider } from "./openai-responses.ts";

const PROVIDERS: Record<ApiFormat, Provider> = {
	"anthropic-messages": anthropicMessagesProvider,
	"openai-responses": openaiResponsesProvider,
};

export const API_FORMATS: { value: ApiFormat; label: string; hint: string }[] = [
	{ value: "openai-responses", label: "Responses (/responses)", hint: "OpenAI Responses API" },
	{ value: "anthropic-messages", label: "Messages (/messages)", hint: "Anthropic Messages API" },
];

export function getProvider(api: ApiFormat): Provider {
	const provider = PROVIDERS[api];
	if (!provider) throw new Error(`Unsupported API format: ${api}`);
	return provider;
}

/** Stream one assistant turn. Yields incremental events and returns the final message. */
export function streamAssistant(
	providerConfig: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions = {},
): AsyncGenerator<StreamEvent, AssistantMessage> {
	return getProvider(providerConfig.api).stream(providerConfig, model, context, options);
}

export { anthropicMessagesProvider, toAnthropicMessages } from "./anthropic-messages.ts";
export { openaiResponsesProvider, toResponsesInput } from "./openai-responses.ts";
