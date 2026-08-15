/**
 * Delegating a piece of work to a nested agent.
 *
 * The point is context isolation: a search that reads forty files returns one paragraph to the
 * parent instead of forty file dumps. Which means the sub-agent gets its own message list and its
 * own state map — its file reads and its todo list must not leak upwards.
 *
 * What it did is not lost, though. The steps it took are collected and handed back so the caller
 * can write them to the session log; a delegated turn should be as readable afterwards as one done
 * in the open.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import { runTurn } from "../agent/runner.ts";
import type { Settings } from "../config/settings.ts";
import type { Skill } from "../skills/loader.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { AGENTS_KEY, BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import type { ApprovalDecision, ApprovalRequest, ModelConfig, ProviderConfig, Tool } from "../types.ts";

export interface SubAgentOptions {
	sessionId: string;
	cwd: string;
	settings: Settings;
	tools: Tool[];
	skills: Skill[];
	agents: AgentDefinition[];
	signal?: AbortSignal;
	streamFn?: AgentRunConfig["streamFn"];
	requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
	emit(event: AgentEvent): Promise<void>;
}

export async function runSubAgent(
	options: SubAgentOptions,
	input: { description: string; prompt: string; agentType?: string },
	provider: ProviderConfig,
	model: ModelConfig,
	parentSystemPrompt: string,
): Promise<string> {
	const definition = options.agents.find((a) => a.name === (input.agentType ?? "general")) ?? BUILTIN_AGENTS[0];
	const allowed =
		definition.tools === "*" ? options.tools : options.tools.filter((t) => (definition.tools as string[]).includes(t.name));

	// The sub-agent gets its own message list and its own state map, so its file reads and
	// todo list cannot leak into the parent's.
	const id = `${options.sessionId}:sub:${randomUUID().slice(0, 8)}`;
	const steps: string[] = [];
	await options.emit({
		type: "subagent",
		id,
		agent: definition.name,
		description: input.description,
		prompt: input.prompt,
		tools: allowed.map((tool) => tool.name),
	});

	const result = await runTurn(
		{
			sessionId: id,
			cwd: options.cwd,
			provider,
			model,
			systemPrompt: `${definition.systemPrompt}\n\n${parentSystemPrompt.split("# Environment")[1] ? `# Environment${parentSystemPrompt.split("# Environment")[1].split("\n\n#")[0]}` : ""}`,
			tools: allowed,
			messages: [{ role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now() }],
			thinking: options.settings.thinking,
				retryAttempts: options.settings.retryAttempts,
			signal: options.signal,
			state: new Map<string, unknown>([
				[SKILLS_KEY, options.skills],
				[AGENTS_KEY, options.agents],
			]),
			requestApproval: (request) => options.requestApproval(request),
			// Inherited, so a host that replaced the provider call replaced it for the whole
			// tree — a sub-agent quietly dialling out would defeat the point of overriding it.
			streamFn: options.streamFn,
			maxTurns: 60,
		},
		(event) => {
			// Surfaced as a notice for the live view, kept as a step for the log.
			if (event.type === "tool_start") {
				steps.push(event.summary);
				void options.emit({
					type: "notice",
					level: "info",
					message: `[${definition.name}] ${event.summary}`,
				});
			}
		},
	);

	const last = [...result.messages].reverse().find((m) => m.role === "assistant");
	const answer =
		last?.role === "assistant"
			? last.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim()
			: "";

	await options.emit({ type: "subagent_done", id, steps, answer });
	return answer;
}
