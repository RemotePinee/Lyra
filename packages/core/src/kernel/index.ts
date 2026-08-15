import { Context } from "./context.ts";
import { approvalPlugin } from "./plugins/approval.ts";
import { compactionPlugin } from "./plugins/compaction.ts";
import { llmPlugin } from "./plugins/llm.ts";
import { sandboxPlugin } from "./plugins/sandbox.ts";
import { skillsPlugin } from "./plugins/skills.ts";
import { toolsPlugin } from "./plugins/tools.ts";

export { Context, type Disposer, type Plugin } from "./context.ts";
export { EventBus, type Dispatch, type Middleware, type Observer, type Responder } from "./events.ts";
export {
	APPROVAL,
	COMPACTION,
	EVENTS,
	LLM,
	SANDBOX,
	SKILLS,
	STORAGE,
	TOOLS,
	type ApprovalPolicy,
	type ApprovalVerdict,
	type CompactionStrategy,
	type LlmRegistry,
	type Sandbox,
	type SandboxProcess,
	type SkillRegistry,
	type ToolRegistry,
} from "./services.ts";
export { approvalPlugin } from "./plugins/approval.ts";
export { compactionPlugin } from "./plugins/compaction.ts";
export { llmPlugin } from "./plugins/llm.ts";
export { sandboxPlugin } from "./plugins/sandbox.ts";
export { skillsPlugin } from "./plugins/skills.ts";
export { AGENT_TOOLS, FILE_TOOLS, SHELL_TOOLS, WEB_TOOLS, toolsPlugin } from "./plugins/tools.ts";

/**
 * The set that makes an ordinary DeepWise.
 *
 * Listed rather than discovered, because the default configuration should be something you can
 * read. A host that wants a different shape — no shell, a remote sandbox, another model API —
 * builds its own list instead of passing flags to this one.
 */
export const DEFAULT_PLUGINS = [llmPlugin, toolsPlugin, approvalPlugin, sandboxPlugin, compactionPlugin, skillsPlugin];

/**
 * Build a context with a given set of plugins.
 *
 * Order in the array does not matter: a plugin that names its dependencies waits for them, so a
 * configuration is a set of choices rather than a boot sequence.
 */
export async function createContext(plugins = DEFAULT_PLUGINS): Promise<Context> {
	const ctx = new Context();
	for (const plugin of plugins) await ctx.use(plugin);
	return ctx;
}
