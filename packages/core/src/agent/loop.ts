/**
 * The agent loop.
 *
 * One turn = one assistant response plus every tool it asked for. The loop keeps turning
 * while the model emits tool calls, and drains a steering queue between turns so the user
 * can redirect a running agent without cancelling it.
 */

import { runTool } from "./tool-pipeline.ts";
import { streamAssistant } from "../ai/index.ts";
import { readTodos } from "../tools/todo.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	AssistantMessage,
	LlmContext,
	Message,
	ModelConfig,
	ProviderConfig,
	SubAgentInput,
	ThinkingLevel,
	Tool,
	ToolContext,
	ToolResult,
	ToolResultMessage,
	UserContent,
} from "../types.ts";
import type { AgentEvent, AgentEventSink } from "./events.ts";

export interface AgentRunConfig {
	sessionId: string;
	cwd: string;
	provider: ProviderConfig;
	model: ModelConfig;
	systemPrompt: string;
	tools: Tool[];
	messages: Message[];
	thinking?: ThinkingLevel;
	/** Attempts per request, including the first; see `Settings.retryAttempts`. */
	retryAttempts?: number;
	maxTokens?: number;
	temperature?: number;
	maxTurns?: number;
	signal?: AbortSignal;
	/** Session-scoped scratch space shared by every tool. */
	state?: Map<string, unknown>;
	requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Passed through to the tools; see `ToolContext.writePreview`. */
	writePreview?: ToolContext["writePreview"];
	spawnSubAgent?: (input: SubAgentInput) => Promise<string>;
	/** Messages the user typed while the agent was mid-turn. Drained between turns. */
	drainSteering?: () => Message[];
	/**
	 * Called before each request. Return a replacement message list to compact history
	 * when it approaches the context window.
	 */
	compact?: (messages: Message[], model: ModelConfig) => Promise<Message[] | null>;
	/**
	 * Replaces the provider call. Tests script turns through this so loop behaviour can be
	 * checked without a network round trip.
	 */
	streamFn?: (context: LlmContext, config: AgentRunConfig) => Promise<AssistantMessage>;
	/**
	 * Runs before a tool executes. Returning `block` turns the call into an error result the
	 * model can react to, without ending the turn.
	 */
	beforeToolCall?: (call: {
		toolName: string;
		args: Record<string, unknown>;
	}) => Promise<{ block?: boolean; reason?: string } | void>;
	/** Runs after a tool executes; may replace the result the model sees. */
	afterToolCall?: (call: {
		toolName: string;
		args: Record<string, unknown>;
		result: ToolResult;
	}) => Promise<{ result?: ToolResult } | void>;
}

export interface AgentRunResult {
	messages: Message[];
	reason: "done" | "aborted" | "error" | "max_turns";
	error?: string;
}

const DEFAULT_MAX_TURNS = 200;
/**
 * How many times in a row the agent may be told to get on with it.
 *
 * Enough to carry a plan over a couple of pauses, few enough that a model which has genuinely
 * finished — but left an item it decided against — is not argued with indefinitely.
 */
const MAX_NUDGES = 3;

export async function runAgent(config: AgentRunConfig, emit: AgentEventSink): Promise<AgentRunResult> {
	const messages = [...config.messages];
	/** Messages produced by this run, so the caller can append them to the persisted session. */
	const produced: Message[] = [];
	const state = config.state ?? new Map<string, unknown>();
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	/** Consecutive turns that talked about the plan without touching it. */
	let nudges = 0;

	await emit({ type: "agent_start", sessionId: config.sessionId });

	let turn = 0;
	/**
	 * Steering messages drained at the end of a turn, waiting to be injected at the start of
	 * the next one. `drainSteering` empties the queue, so whatever it returns must be held
	 * here — reading only its length would discard the user's message and leave the loop
	 * prompting the model with no new input.
	 */
	let carried: Message[] = [];

	while (true) {
		if (config.signal?.aborted) return finish("aborted");
		if (turn >= maxTurns) return finish("max_turns");
		turn += 1;
		await emit({ type: "turn_start", turn });

		const steering = [...carried, ...(config.drainSteering?.() ?? [])];
		carried = [];
		for (const steered of steering) {
			messages.push(steered);
			produced.push(steered);
			await emit({ type: "message_start", message: steered });
			await emit({ type: "message_end", message: steered });
		}

		if (config.compact) {
			const before = messages.length;
			const compacted = await config.compact(messages, config.model);
			if (compacted) {
				messages.length = 0;
				messages.push(...compacted);
				await emit({ type: "compacted", before, after: compacted.length });
			}
		}

		const context: LlmContext = {
			systemPrompt: config.systemPrompt,
			messages,
			tools: config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		};

		const assistant = await streamTurn(config, context, emit);
		messages.push(assistant);
		produced.push(assistant);

		if (assistant.stopReason === "aborted") return finish("aborted");
		if (assistant.stopReason === "error") return finish("error", assistant.errorMessage);

		const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) {
			await emit({ type: "turn_end", message: assistant, toolResults: [] });
			// A steering message that arrived during the final stream still deserves an answer.
			carried = config.drainSteering?.() ?? [];
			if (carried.length > 0) continue;

			/*
			 * Saying what comes next is not the same as stopping.
			 *
			 * On long work a model regularly ends a turn with a sentence like "backend done, now
			 * the SSR pages" and no tool call at all — it narrated the next step instead of taking
			 * it. Read literally that is the end of the run, and eight-step plans were being
			 * abandoned three steps in with nothing wrong and nothing said.
			 *
			 * Its own task list is the evidence. If items remain unfinished, the work is not over
			 * and it is asked to carry on. Bounded, and reset by any turn that actually uses a
			 * tool, so a model that has genuinely stopped is nudged a few times and then left
			 * alone rather than talked at forever.
			 */
			const unfinished = readTodos(state).filter((todo) => todo.status !== "completed");
			if (unfinished.length > 0 && nudges < MAX_NUDGES) {
				nudges += 1;
				const nudge: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `（自动继续）清单里还有 ${unfinished.length} 项没有完成。直接执行下一项，不要只描述计划。`,
						},
					],
					timestamp: Date.now(),
					/*
					 * The runtime is speaking, not the person.
					 *
					 * It has to be a user message because that is the only role the model will take
					 * an instruction in — but the window must not draw it as one. Rendered in the
					 * human's own bubble it reads as something they typed, and the transcript then
					 * shows them asking for things they never asked for.
					 */
					synthetic: true,
				};
				messages.push(nudge);
				produced.push(nudge);
				await emit({ type: "message_start", message: nudge });
				await emit({ type: "message_end", message: nudge });
				continue;
			}
			return finish("done");
		}
		// It did something, so whatever made it pause before is no longer the pattern.
		nudges = 0;

		const toolResults =
			assistant.stopReason === "length"
				? await failTruncatedCalls(toolCalls, emit)
				: await runTools(toolCalls, config, state, emit);

		for (const result of toolResults) {
			messages.push(result);
			produced.push(result);
		}

		await emit({ type: "turn_end", message: assistant, toolResults });
	}

	async function finish(reason: AgentRunResult["reason"], error?: string): Promise<AgentRunResult> {
		await emit({ type: "agent_end", reason, error });
		return { messages: produced, reason, error };
	}
}

// ---------------------------------------------------------------------------
// Streaming one assistant turn
// ---------------------------------------------------------------------------

async function streamTurn(
	config: AgentRunConfig,
	context: LlmContext,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	if (config.streamFn) {
		const message = await config.streamFn(context, config);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		return message;
	}

	const stream = streamAssistant(config.provider, config.model, context, {
		signal: config.signal,
		thinking: config.thinking,
		maxTokens: config.maxTokens,
		temperature: config.temperature,
		retryAttempts: config.retryAttempts,
		/*
		 * Said out loud, because the alternative is a turn that appears to hang.
		 *
		 * A retry costs seconds of silence at a moment when the user is already waiting, and
		 * silence is indistinguishable from a stall. One line naming the cause turns it into
		 * something that is visibly being handled.
		 */
		onRetry: ({ attempt, delayMs, reason }) => {
			void emit({ type: "retry", attempt, delayMs, reason });
		},
	});

	let started = false;

	while (true) {
		const next = await stream.next();
		if (next.done) return next.value;
		const event = next.value;

		switch (event.type) {
			case "start":
				started = true;
				await emit({ type: "message_start", message: event.partial });
				break;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
			case "toolcall_end":
				await emit({ type: "message_update", message: event.partial, delta: event });
				break;
			case "done":
			case "error": {
				const message = event.message;
				if (!started) await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				// Drain the generator so its `return` value is the authoritative final message.
				const tail = await stream.next();
				return tail.done ? tail.value : message;
			}
			default:
				break;
		}
	}
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

async function runTools(
	toolCalls: ToolCall[],
	config: AgentRunConfig,
	state: Map<string, unknown>,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const byName = new Map(config.tools.map((t) => [t.name, t]));
	const forceSequential = toolCalls.some((call) => byName.get(call.name)?.executionMode === "sequential");

	const execute = async (call: ToolCall): Promise<ToolResultMessage> => {
		const tool = byName.get(call.name);
		await emit({
			type: "tool_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
			summary: tool?.summarize?.(call.arguments) ?? call.name,
		});

		const result = await executeOne(tool, call, config, state, emit);
		await emit({
			type: "tool_end",
			toolCallId: call.id,
			toolName: call.name,
			result,
			isError: result.isError === true,
		});

		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			details: result.details,
			isError: result.isError === true,
			timestamp: Date.now(),
		};
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		return message;
	};

	if (forceSequential) {
		const results: ToolResultMessage[] = [];
		for (const call of toolCalls) {
			results.push(await execute(call));
			if (config.signal?.aborted) break;
		}
		return results;
	}
	return Promise.all(toolCalls.map(execute));
}

async function executeOne(
	tool: Tool | undefined,
	call: ToolCall,
	config: AgentRunConfig,
	state: Map<string, unknown>,
	emit: AgentEventSink,
): Promise<ToolResult> {
	if (!tool) return errorResult(`Tool "${call.name}" is not available in this session.`);

	// A tool call whose JSON never parsed would silently run with no arguments.
	if (call.argumentsText && Object.keys(call.arguments).length === 0 && call.argumentsText.trim() !== "{}") {
		return errorResult(
			`Arguments for "${call.name}" were not valid JSON, so the call was not executed. Re-issue it with complete arguments.`,
		);
	}

	const ctx: ToolContext = {
		cwd: config.cwd,
		sessionId: config.sessionId,
		signal: config.signal,
		state,
		requestApproval: config.requestApproval,
		writePreview: config.writePreview,
		spawnSubAgent: config.spawnSubAgent,
		onProgress: (partial) => void emit({ type: "tool_update", toolCallId: call.id, partial }),
	};

	if (config.beforeToolCall) {
		try {
			const decision = await config.beforeToolCall({ toolName: call.name, args: call.arguments });
			if (decision?.block) {
				return errorResult(decision.reason || `A hook blocked "${call.name}".`);
			}
		} catch (error) {
			// A broken hook must not take the tool down with it.
			void emit({
				type: "notice",
				level: "warn",
				message: `before-tool hook failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	let result: ToolResult;
	try {
		result = await runTool({ tool, args: call.arguments, ctx });
	} catch (error) {
		if (config.signal?.aborted) return errorResult("Tool execution was cancelled.");
		return errorResult(error instanceof Error ? error.message : String(error));
	}

	if (config.afterToolCall) {
		try {
			const patched = await config.afterToolCall({ toolName: call.name, args: call.arguments, result });
			if (patched?.result) result = patched.result;
		} catch (error) {
			void emit({
				type: "notice",
				level: "warn",
				message: `after-tool hook failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	return result;
}

/**
 * When the model hits its output limit mid-call, streamed arguments may parse yet still be
 * missing fields. Executing them is worse than failing them, so every call in the message is
 * rejected with an explanation the model can act on.
 */
async function failTruncatedCalls(toolCalls: ToolCall[], emit: AgentEventSink): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const call of toolCalls) {
		const result = errorResult(
			`"${call.name}" was not executed: the response hit the output token limit, so its arguments may be incomplete. Re-issue the call.`,
		);
		await emit({ type: "tool_start", toolCallId: call.id, toolName: call.name, args: call.arguments, summary: call.name });
		await emit({ type: "tool_end", toolCallId: call.id, toolName: call.name, result, isError: true });
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			isError: true,
			timestamp: Date.now(),
		};
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		results.push(message);
	}
	return results;
}

export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

export function textResult(text: string, details?: unknown): ToolResult {
	const content: UserContent[] = [{ type: "text", text }];
	return { content, details };
}

export type { AgentEvent };
