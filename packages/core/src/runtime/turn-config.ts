/**
 * What one turn is handed.
 *
 * Assembling this used to be fifty lines in the middle of the method that runs the turn, which
 * made a short piece of orchestration look long and buried the two decisions in it that are
 * actually interesting: where previews are written, and what a sub-agent inherits.
 *
 * Everything it needs arrives as a parameter. That is not ceremony — it is the list of things a
 * turn depends on, which is worth being able to read in one place.
 */

import type { AgentEvent } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import type { streamAssistant } from "../ai/index.ts";
import type { Settings } from "../config/settings.ts";
import type { Skill } from "../skills/loader.ts";
import type { AgentDefinition } from "../tools/task.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ModelConfig,
	ProviderConfig,
	ThinkingLevel,
	Tool,
} from "../types.ts";
import { lyraHome } from "../session/store.ts";
import { compactWith } from "./compaction.ts";
import { writePreview } from "./previews.ts";
import { runSubAgent } from "./sub-agent.ts";
import type { TurnContext } from "./turn.ts";

export interface TurnConfigDeps {
	sessionId: string;
	cwd: string;
	provider: ProviderConfig;
	model: ModelConfig;
	settings: Settings;
	state: Map<string, unknown>;
	tools: Tool[];
	skills: Skill[];
	agents: AgentDefinition[];
	signal?: AbortSignal;
	streamFn?: AgentRunConfig["streamFn"];
	requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
	emit(event: AgentEvent): Promise<void>;
	/** The session's stream override, in the shape compaction expects. */
	summaryStream(provider: ProviderConfig): typeof streamAssistant | undefined;
	beforeToolCall: AgentRunConfig["beforeToolCall"];
	afterToolCall: AgentRunConfig["afterToolCall"];
	drainSteering: AgentRunConfig["drainSteering"];
}

export function buildTurnConfig(
	deps: TurnConfigDeps,
	turn: TurnContext,
	systemPrompt: string,
	thinking?: ThinkingLevel,
): AgentRunConfig {
	return {

			sessionId: deps.sessionId,
			cwd: deps.cwd,
			provider: deps.provider,
			model: deps.model,
			systemPrompt,
			tools: turn.tools,
			messages: turn.messages,
			thinking: thinking ?? deps.settings.thinking,
			retryAttempts: deps.settings.retryAttempts,
			signal: deps.signal,
			state: deps.state,
			/*
			 * Previews are written under the app's directory, keyed by this session.
			 *
			 * The workspace is the user's project; a page produced to demonstrate an idea
			 * is not part of it and should never turn up in `git status`. Keyed by session
			 * so it can be thrown away with the conversation that produced it.
			 */
			writePreview: (input) =>
				writePreview(lyraHome(), { ...input, sessionId: deps.sessionId }),
			requestApproval: (request) => deps.requestApproval(request),
			spawnSubAgent: (input) =>
				runSubAgent(
					{
						sessionId: deps.sessionId,
						cwd: deps.cwd,
						settings: deps.settings,
						tools: deps.tools,
						skills: deps.skills,
						agents: deps.agents,
						signal: deps.signal,
						streamFn: deps.streamFn,
						requestApproval: (request) => deps.requestApproval(request),
						emit: (event) => deps.emit(event),
					},
					input,
					deps.provider,
					deps.model,
					systemPrompt,
				),
			drainSteering: deps.drainSteering,
			beforeToolCall: deps.beforeToolCall,
			afterToolCall: deps.afterToolCall,
			// The session's own stream override applies here too; summarising is a model call.
			compact: (messages, model) =>
				compactWith(messages, model, deps.provider, deps.summaryStream(deps.provider)),
			streamFn: deps.streamFn,
	};
}
