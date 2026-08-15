/**
 * Assembling one turn: everything the loop needs, in the order it has to be decided.
 *
 * Build the system prompt, let plugins amend the whole turn, then write down what came out. The
 * recording happens last on purpose — what belongs in the log is what the model was actually sent,
 * not what this file would have sent if nothing had intervened.
 *
 * Separate from the session because it is a function of its inputs and nothing else: given the same
 * workspace, capabilities and history it produces the same request. That is what makes a turn
 * something you can reason about after the fact rather than only watch happen.
 */

import { platform } from "node:os";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import { runTurn } from "../agent/runner.ts";
import type { streamAssistant } from "../ai/index.ts";
import type { Settings } from "../config/settings.ts";
import { buildSystemPrompt, loadProjectInstructions } from "../prompt/system.ts";
import { TODOS_KEY, type TodoItem } from "../tools/todo.ts";
import { continueWhileWorkRemains } from "./continuation.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	AssistantMessage,
	Message,
	ModelConfig,
	ProviderConfig,
	StreamEvent,
	ThinkingLevel,
} from "../types.ts";
import { makeAfterToolCall, makeBeforeToolCall } from "./hooks.ts";
import type { SessionCapabilities } from "./session-capabilities.ts";
import type { SessionLog } from "./session-log.ts";
import { prepareTurn } from "./turn.ts";
import { buildTurnConfig } from "./turn-config.ts";

export interface TurnInputs {
	cwd: string;
	settings: Settings;
	log: SessionLog;
	can: SessionCapabilities;
	provider: ProviderConfig;
	model: ModelConfig;
	signal: AbortSignal;
	thinking?: ThinkingLevel;
	streamFn?: AgentRunConfig["streamFn"];
	scratchDir: string;
	requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	emit: (event: AgentEvent) => Promise<void>;
	drainSteering: () => Message[];
}

/**
 * Run one prompt to a standstill: the turn itself, then as many more as the plan still needs.
 *
 * The continuation is here rather than at the call site because it is the same turn continuing —
 * a model that stops with items still unticked has not finished, and restarting it is not a second
 * request in any sense the log or the user would recognise.
 */
export async function driveTurn(input: TurnInputs): Promise<void> {
	const onEvent = (event: AgentEvent) => recordTurnEvent(input.log, event);
	const { config, systemPrompt } = await assembleTurn(input);

	const first = await runTurn(config, onEvent);
	await continueWhileWorkRemains(first, {
		run: (messages) => runTurn({ ...config, messages, systemPrompt }, onEvent),
		messages: () => input.log.messages,
		todos: () => (input.can.state.get(TODOS_KEY) as TodoItem[] | undefined) ?? [],
		aborted: () => input.signal.aborted,
		notify: (message) => input.emit({ type: "notice", level: "info", message }),
	});
}

/**
 * Every event on its way out of the loop, with the two things that must happen as it passes.
 *
 * `message_end` is the commit point: partial assistant messages are never persisted, so this is
 * the only place a reply enters the transcript.
 *
 * And a turn stopped for going in circles has to say so. Ending silently is indistinguishable from
 * finishing, and the difference matters: one means the work is done, the other means it is stuck
 * and waiting for a person to say something it has not thought of.
 */
export async function recordTurnEvent(log: SessionLog, event: AgentEvent): Promise<void> {
	if (event.type === "agent_end" && event.reason === "stalled") {
		await log.emit({
			type: "notice",
			level: "warn",
			message: "同一个调用反复得到相同结果，已停下。告诉它换个方向，或直接说明你想怎么处理。",
		});
	}
	if (event.type === "message_end") await log.commit(event.message);
	await log.emit(event);
}

export async function assembleTurn(input: TurnInputs): Promise<{ config: AgentRunConfig; systemPrompt: string }> {
	const { cwd, can, log, settings } = input;

	const turn = await prepareTurn({
		cwd,
		tools: can.tools,
		messages: log.messages,
		systemPrompt: await buildSystemPrompt({
			cwd,
			tools: can.tools,
			skills: can.skills,
			agents: can.agents,
			projectInstructions: await loadProjectInstructions(cwd),
			platform: platform(),
			modelName: input.model.name,
			isGitRepo: await pathExists(join(cwd, ".git")),
			today: new Date().toISOString().slice(0, 10),
			scratchDir: input.scratchDir,
		}),
	});

	const systemPrompt = await log.recordContext(
		turn.systemPrompt,
		turn.tools.map((tool) => tool.name),
		can.skills.map((skill) => skill.name),
	);

	const config = buildTurnConfig(
		{
			sessionId: log.meta.id,
			cwd,
			provider: input.provider,
			model: input.model,
			settings,
			state: can.state,
			tools: can.tools,
			skills: can.skills,
			agents: can.agents,
			signal: input.signal,
			streamFn: input.streamFn,
			requestApproval: input.requestApproval,
			emit: input.emit,
			summaryStream: (provider) => summaryStream(input.streamFn, provider, input.model),
			beforeToolCall: makeBeforeToolCall(settings.hooks, cwd, input.signal),
			afterToolCall: makeAfterToolCall(settings.hooks, cwd, input.signal),
			drainSteering: input.drainSteering,
		},
		turn,
		systemPrompt,
		input.thinking,
	);

	return { config, systemPrompt };
}

/**
 * The provider call compaction should make, in the shape it expects.
 *
 * The session's override answers a whole turn; compaction wants a stream. Adapting rather than
 * reaching for the real provider is the point: a host that replaced how requests are made — a test,
 * a recorded session, a gateway — must have replaced this one too. Undefined when nothing was
 * overridden, which leaves the real provider in place.
 */
function summaryStream(
	override: AgentRunConfig["streamFn"] | undefined,
	provider: ProviderConfig,
	model: ModelConfig,
): typeof streamAssistant | undefined {
	if (!override) return undefined;
	return (_provider, _model, context) => {
		const call = override;
		async function* once(): AsyncGenerator<StreamEvent, AssistantMessage> {
			return call({ ...context }, { provider, model } as AgentRunConfig);
		}
		return once();
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
