/**
 * DeepWise core type model.
 *
 * One neutral message shape flows through the whole system. Provider adapters translate
 * it into their wire format on the way out and back on the way in, so the agent loop,
 * the session store, the desktop UI and the mobile app never see provider-specific JSON.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
	/** Opaque provider handle (Responses item id, etc.) needed to replay this block. */
	signature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** Opaque provider handle: Anthropic thinking signature or Responses reasoning item id. */
	signature?: string;
	/** Provider-encrypted reasoning payload, replayed verbatim on the next turn. */
	encrypted?: string;
	/** Safety filters removed the visible text but the encrypted payload is still replayable. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	/** base64, no data: prefix */
	data: string;
	mimeType: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Raw argument text as streamed; kept for salvage when JSON is truncated. */
	argumentsText?: string;
	/** Provider item id (Responses `item.id`), distinct from the `call_id` in `id`. */
	signature?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
export type UserContent = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Usage & stop reasons
// ---------------------------------------------------------------------------

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	total: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
		total: a.total + b.total,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
	role: "user";
	content: UserContent[];
	timestamp: number;
	/** Set when the message was injected by the runtime rather than typed by a human. */
	synthetic?: boolean;
	/**
	 * Who sent this, when it was not the person looking at the transcript.
	 *
	 * A task dispatched from the side chat lands in the main conversation as an ordinary user
	 * message. Without this you would scroll back and find an instruction you have no memory
	 * of writing, in your own voice, with no way to tell where it came from.
	 */
	origin?: "side-chat";
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	api: ApiFormat;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	/** Provider response id, used for Responses-API conversation chaining. */
	responseId?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: UserContent[];
	/** Structured payload for rich UI rendering; never sent to the model. */
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema subset accepted by every provider we target. */
export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema | JsonSchema[];
	required?: string[];
	enum?: unknown[];
	description?: string;
	default?: unknown;
	additionalProperties?: boolean | JsonSchema;
	[key: string]: unknown;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export interface ToolResult {
	/** What the model sees. */
	content: UserContent[];
	/** What the UI renders. Never serialized into the provider payload. */
	details?: unknown;
	isError?: boolean;
	/** End the agent turn after this tool, even if the model wanted to keep going. */
	terminate?: boolean;
}

export interface ToolContext {
	/** Absolute working directory for this session. */
	cwd: string;
	sessionId: string;
	signal?: AbortSignal;
	/** Push an in-progress result so the UI can stream long-running tools. */
	onProgress?: (partial: ToolResult) => void;
	/** Ask the user to approve a side-effecting operation. */
	requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Run a nested agent (used by the `task` tool). */
	spawnSubAgent?: (input: SubAgentInput) => Promise<string>;
	/** Shared per-session scratch space (todo list, file read cache, ...). */
	state: Map<string, unknown>;
	/**
	 * Store a web preview and return where it went.
	 *
	 * Provided by the host, because where these files live is the host's business — they are
	 * conversation artifacts kept under the app's own directory, never in the user's project.
	 */
	writePreview?: (input: {
		id: string;
		title: string;
		files: { path: string; content: string }[];
		entry?: string;
	}) => Promise<{ id: string; sessionId: string; title: string; entry: string; dir: string }>;
	logger?: Logger;
}

export interface ApprovalRequest {
	kind: "bash" | "write" | "edit" | "mcp" | "network";
	title: string;
	detail: string;
	/** Command / path the approval applies to, used for "always allow" rules. */
	subject: string;
}

export type ApprovalDecision = "once" | "always" | "reject";

export interface SubAgentInput {
	description: string;
	prompt: string;
	agentType?: string;
	model?: string;
}

export interface Tool<TArgs = Record<string, unknown>> extends ToolSpec {
	/**
	 * One line for the system prompt's tool list. The full `description` goes to the provider's
	 * tool schema; this is what the model reads when scanning what it has available.
	 */
	snippet: string;
	/**
	 * Behavioural rules this tool contributes to the prompt's Guidelines section. Keeping them
	 * next to the tool means a tool that is not loaded cannot leave stale advice behind.
	 */
	guidelines?: string[];
	/** "sequential" forces the loop to run this tool alone, in call order. */
	executionMode?: "parallel" | "sequential";
	/** Tools that mutate the workspace go through the approval flow. */
	mutating?: boolean;
	execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
	/** One-line summary shown in the UI while the tool runs. */
	summarize?(args: TArgs): string;
}

export interface Logger {
	debug(msg: string, meta?: unknown): void;
	info(msg: string, meta?: unknown): void;
	warn(msg: string, meta?: unknown): void;
	error(msg: string, meta?: unknown): void;
}

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------

/**
 * Wire formats DeepWise speaks. Chat Completions is deliberately excluded: the product
 * targets Responses and Anthropic Messages only.
 */
export type ApiFormat = "openai-responses" | "anthropic-messages";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "max";

export interface ModelPricing {
	/** USD per million tokens. */
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelConfig {
	/** Stable local id, unique across providers: `${providerId}/${modelId}`. */
	id: string;
	providerId: string;
	/** Id sent to the provider. */
	modelId: string;
	/** Label shown in the UI. */
	name: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsThinking: boolean;
	supportsImages: boolean;
	supportsTools: boolean;
	pricing?: ModelPricing;
	/** Extra sampling parameters merged verbatim into the request body. */
	samplingParams?: Record<string, unknown>;
}

export interface ProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	api: ApiFormat;
	apiKey: string;
	enabled: boolean;
	/** Extra headers merged into every request. */
	headers?: Record<string, string>;
	models: ModelConfig[];
}

export interface RequestOptions {
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	thinking?: ThinkingLevel;
	/** Merged over `ModelConfig.samplingParams`. */
	samplingParams?: Record<string, unknown>;
	fetch?: typeof globalThis.fetch;
	/** Inspect or rewrite the outgoing body — used by the request inspector in the UI. */
	onPayload?: (payload: unknown) => void;
	/**
	 * How many times to attempt the request, including the first.
	 *
	 * Only the connection is retried, never a stream already in flight. 1 disables it.
	 */
	retryAttempts?: number;
	/** Told about each wait, so the UI can say why a turn is taking longer than usual. */
	onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export interface LlmContext {
	systemPrompt: string;
	messages: Message[];
	tools: ToolSpec[];
}

// ---------------------------------------------------------------------------
// Streaming events emitted by provider adapters
// ---------------------------------------------------------------------------

export type StreamEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; index: number }
	| { type: "text_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; index: number }
	| { type: "thinking_start"; index: number }
	| { type: "thinking_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; index: number }
	| { type: "toolcall_start"; index: number; id: string; name: string }
	| { type: "toolcall_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; index: number; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: string; message: AssistantMessage };

export interface Provider {
	readonly api: ApiFormat;
	stream(
		provider: ProviderConfig,
		model: ModelConfig,
		context: LlmContext,
		options: RequestOptions,
	): AsyncGenerator<StreamEvent, AssistantMessage>;
}
