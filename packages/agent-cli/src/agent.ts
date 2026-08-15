/**
 * One headless turn, run by the same runtime the app runs.
 *
 * Not a second implementation of anything: this builds an `AgentSession` exactly as the desktop
 * app does, and the only differences are the ones CI demands — no window to ask permission in, no
 * shell to run commands with, and a wall clock that has to end the run whether it is finished
 * or not.
 *
 * The tool set is narrowed through `useToolRegistry`, which is the seam the kernel already has for
 * exactly this. An agent reading a pull request has no business writing files or running commands,
 * and taking the capability away is stronger than instructing it not to.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	DEFAULT_SETTINGS,
	SessionStore,
	globTool,
	grepTool,
	lsTool,
	readTool,
	useToolRegistry,
	type AgentEvent,
	type ModelConfig,
	type ProviderConfig,
	type Settings,
	type Tool,
} from "@deepwise/core";

/** Read, look, search. Nothing that writes, runs or reaches the network on its own. */
const READ_ONLY: Tool[] = [readTool, lsTool, globTool, grepTool] as unknown as Tool[];

export interface RunOptions {
	/** What the agent is being asked to do. */
	prompt: string;
	/** The workspace it may read. The checkout, in CI. */
	cwd: string;
	/** Hard stop. A run that has not finished by now is not going to. */
	timeoutMs?: number;
	/** Print events as they arrive, so the workflow log shows progress rather than a hang. */
	verbose?: boolean;
}

const DEFAULT_TIMEOUT_MS = 8 * 60_000;

export async function runOnce(options: RunOptions): Promise<string> {
	useToolRegistry({ all: () => READ_ONLY });

	// Sessions are written somewhere; in CI that somewhere is thrown away with the runner.
	const root = await mkdtemp(join(tmpdir(), "deepwise-ci-"));

	/*
	 * A home of its own, so this run loads nothing it was not given.
	 *
	 * Capabilities are discovered from `$DEEPWISE_HOME/plugins` as well as the workspace, and a
	 * plugin there can bring MCP servers with it — real processes, started on someone's laptop
	 * during a local run of this command. What the agent may reach has to be a property of the
	 * invocation, not of whoever's machine it happens to be running on.
	 */
	process.env.DEEPWISE_HOME = join(root, "home");
	const store = new SessionStore(join(root, "sessions"));
	const answers: string[] = [];

	const session = new AgentSession({
		cwd: options.cwd,
		settings: settingsFromEnv(),
		store,
		emit: (event) => collect(event, answers, options.verbose === true),
	});

	try {
		await session.initialize();
		await withTimeout(
			session.prompt([{ type: "text", text: options.prompt }]),
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			() => session.abort(),
		);
		return answers.join("\n\n").trim();
	} finally {
		await session.dispose();
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

/** The reply text, and nothing else. Tool chatter belongs in the log, not in a PR comment. */
function collect(event: AgentEvent, answers: string[], verbose: boolean): void {
	if (event.type === "message_end" && event.message.role === "assistant") {
		for (const part of event.message.content) {
			if (part.type === "text" && part.text.trim()) answers.push(part.text.trim());
		}
	}
	if (!verbose) return;
	if (event.type === "tool_start") console.log(`  → ${event.toolName}`);
	if (event.type === "notice") console.log(`  ! ${event.message}`);
}

/**
 * The model, from the environment.
 *
 * Everything is required rather than defaulted: a workflow that silently ran against the wrong
 * endpoint would produce a review nobody could account for.
 */
export function settingsFromEnv(): Settings {
	const baseUrl = need("DEEPWISE_BASE_URL");
	const apiKey = need("DEEPWISE_API_KEY");
	const modelId = process.env.DEEPWISE_MODEL ?? "deepseek-v4-flash";

	const model: ModelConfig = {
		id: `ci/${modelId}`,
		providerId: "ci",
		modelId,
		name: modelId,
		contextWindow: Number(process.env.DEEPWISE_CONTEXT ?? 128_000),
		maxOutputTokens: 8192,
		supportsThinking: true,
		supportsImages: false,
		supportsTools: true,
	};

	const provider: ProviderConfig = {
		id: "ci",
		name: "CI",
		baseUrl,
		api: (process.env.DEEPWISE_API_FORMAT as ProviderConfig["api"]) ?? "openai-responses",
		apiKey,
		enabled: true,
		models: [model],
	};

	return {
		...DEFAULT_SETTINGS,
		providers: [provider],
		defaultModelId: model.id,
		mcpServers: [],
		/*
		 * Nothing installed locally takes part.
		 *
		 * A plugin can bring MCP servers with it, which are real processes. What this agent can
		 * reach has to follow from the invocation, not from what is in the checkout or on the
		 * machine — otherwise the same command reviews the same diff differently depending on
		 * where it ran.
		 */
		disabledPlugins: ["*"],
		// Nothing can ask a person here. With only read tools loaded there is nothing to approve
		// either — this is what makes that explicit rather than incidental.
		permissionMode: "full",
	};
}

function need(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name} — set it as a repository secret`);
	return value;
}

async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const expiry = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			console.warn(`agent: stopped after ${Math.round(ms / 1000)}s`);
			onTimeout();
			resolve(undefined);
		}, ms);
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
