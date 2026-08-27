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
import type { SubAgentRegistry } from "./sub-agents.ts";

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
	/**
	 * Where this run registers itself, so it can be watched and steered while it happens.
	 *
	 * Optional: a host that only wants the answer — the CLI, a test — passes nothing and gets the
	 * old behaviour exactly. Delegation works the same either way; the registry only adds a window.
	 */
	registry?: SubAgentRegistry;
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
	/*
	 * Its own controller, chained to the parent's.
	 *
	 * Two things must be able to stop this run and they are not the same thing: the session going
	 * away, which stops everything, and someone deciding *this* sub-agent is wedged, which must
	 * leave the parent and its siblings alone. Chaining gives the first without conceding the
	 * second — aborting here is local, aborting upstream still reaches here.
	 */
	const controller = new AbortController();
	const stopWithParent = () => controller.abort();
	options.signal?.addEventListener("abort", stopWithParent, { once: true });
	const registry = options.registry;
	registry?.start({ id, agent: definition.name, description: input.description, abort: () => controller.abort() });
	/*
	 * What it was asked to do, as the first line of its transcript.
	 *
	 * The loop only announces messages it *produces*, and the dispatch prompt is one it was handed —
	 * so without this the pane opened onto the sub-agent's replies with nothing to say what it had
	 * been told, which is the one piece of context a reader has none of. It is also the thing worth
	 * checking first when a sub-agent goes the wrong way: usually the prompt sent it there.
	 */
	registry?.record(id, { role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now() });

	await options.emit({
		type: "subagent",
		id,
		agent: definition.name,
		description: input.description,
		prompt: input.prompt,
		tools: allowed.map((tool) => tool.name),
	});

	let result: Awaited<ReturnType<typeof runTurn>>;
	try {
		result = await runTurn(
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
				signal: controller.signal,
				state: new Map<string, unknown>([
					[SKILLS_KEY, options.skills],
					[AGENTS_KEY, options.agents],
				]),
				requestApproval: (request) => options.requestApproval(request),
				// Inherited, so a host that replaced the provider call replaced it for the whole
				// tree — a sub-agent quietly dialling out would defeat the point of overriding it.
				streamFn: options.streamFn,
				/*
				 * The same splice-between-turns the main session uses for a message typed mid-run.
				 *
				 * Which is the whole of what "talking to a sub-agent" is: it finishes the step it is
				 * on, reads what was said with its context intact, and carries on rather than
				 * starting over. Nothing here knows where the message came from — the registry
				 * queues it, the loop drains it, exactly as for the parent.
				 */
				drainSteering: registry ? () => registry.drainSteering(id) : undefined,
				maxTurns: 60,
			},
			(event) => {
				// Surfaced as a notice for the live view, kept as a step for the log.
				if (event.type === "tool_start") {
					steps.push(event.summary);
					registry?.activity(id, event.summary);
					void options.emit({
						type: "notice",
						level: "info",
						message: `[${definition.name}] ${event.summary}`,
					});
				}
				/*
				 * The transcript, as it is written.
				 *
				 * `message_end` rather than `message_start`: a message still streaming has nothing
				 * worth showing yet. These carry the sub-agent's own id and go nowhere near the
				 * session log — the parent's transcript is unchanged by watching one of these.
				 */
				if (event.type === "message_end") {
					registry?.record(id, event.message);
					void options.emit({ type: "subagent_message", id, message: event.message });
				}
			},
		);
	} catch (error) {
		/*
		 * A run that threw has to be marked, or it stays "running" for the life of the session.
		 *
		 * The throw is re-raised: `task` turns it into a tool error for the parent, which is how
		 * the model finds out. This only makes sure the record agrees with what happened.
		 */
		registry?.finish(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
		await options.emit({ type: "subagent_done", id, steps, answer: "" });
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", stopWithParent);
	}

	const last = [...result.messages].reverse().find((m) => m.role === "assistant");
	const answer =
		last?.role === "assistant"
			? last.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim()
			: "";

	/*
	 * Aborted is not failed.
	 *
	 * A sub-agent stopped on purpose has done exactly what was asked of it, and recording that as a
	 * failure would put an error in the parent's transcript for a button the user pressed.
	 */
	registry?.finish(id, controller.signal.aborted ? { status: "aborted" } : { status: "done", answer });
	await options.emit({ type: "subagent_done", id, steps, answer });
	return answer;
}
