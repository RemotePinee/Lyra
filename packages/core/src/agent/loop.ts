/**
 * The agent loop.
 *
 * One turn = one assistant response plus every tool it asked for. The loop keeps turning
 * while the model emits tool calls, and drains a steering queue between turns so the user
 * can redirect a running agent without cancelling it.
 */

import { runTool } from "./tool-pipeline.ts";
import { RepetitionWatch } from "./repetition.ts";
import { errorResult, failTruncatedCalls, runTools } from "./tool-run.ts";
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
	reason: "done" | "aborted" | "error" | "max_turns" | "stalled";
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
	/** Watches for a turn that has stopped learning anything; see `repetition.ts`. */
	const repetition = new RepetitionWatch();

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
			/*
			 * An empty reply is not an answer.
			 *
			 * A turn that produced no tool call *and* no words has said nothing — it happens when a
			 * model spends its turn thinking and emits nothing after it. Read literally that is the
			 * end of the run, and a whole task once ended this way four messages in with an empty
			 * workspace and no explanation. There is no plan to consult in that case, because
			 * nothing has happened yet; the emptiness is the evidence.
			 */
			const saidNothing = assistant.content.every((part) => part.type !== "text" || !part.text.trim());
			const unfinished = readTodos(state).filter((todo) => todo.status !== "completed");
			if ((unfinished.length > 0 || saidNothing) && nudges < MAX_NUDGES) {
				nudges += 1;
				const nudge: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: saidNothing
								? "（自动继续）上一条回复是空的。请直接开始执行：说明你要做什么，并调用工具去做。"
								: `（自动继续）清单里还有 ${unfinished.length} 项没有完成。直接执行下一项，不要只描述计划。`,
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

		/*
		 * Same call, same arguments, same answer — again.
		 *
		 * Told once, most models change approach. Told and ignored, the turn ends: an agent
		 * repeating a probe that has already answered the same way six times is not going to
		 * discover anything on the seventh, and the hours it would spend doing so belong to
		 * whoever is waiting for it.
		 */
		repetition.observe(toolCalls, toolResults);
		if (repetition.exhausted()) {
			return finish("stalled");
		}
		const repeated = repetition.shouldWarn(toolCalls, toolResults);
		if (repeated) {
			const notice: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text:
							`（自动提示）你已经用同样的参数调用 \`${repeated}\` 多次，每次得到的结果都一样。` +
							`再问一次不会有新信息。换一个思路：换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`,
					},
				],
				timestamp: Date.now(),
				synthetic: true,
			};
			messages.push(notice);
			produced.push(notice);
			await emit({ type: "message_start", message: notice });
			await emit({ type: "message_end", message: notice });
		}
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
