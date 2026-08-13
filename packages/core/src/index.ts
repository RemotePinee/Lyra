export { API_FORMATS, getProvider, streamAssistant } from "./ai/index.ts";
export type { AgentEvent, AgentEventSink, QueuedTask } from "./agent/events.ts";
export { errorResult, runAgent, textResult, type AgentRunConfig, type AgentRunResult } from "./agent/loop.ts";
export {
	availableModels,
	DEFAULT_APPEARANCE,
	DEFAULT_SETTINGS,
	loadSettings,
	resolveModel,
	saveSettings,
	settingsPath,
	type AppearanceSettings,
	type HookConfig,
	type PermissionMode,
	type ScheduledTask,
	type ProjectEntry,
	type Settings,
} from "./config/settings.ts";
export {
	McpManager,
	type McpHttpServer,
	type McpServerConfig,
	type McpServerStatus,
	type McpStdioServer,
} from "./mcp/client.ts";
export {
	fetchRegistry,
	installEntry,
	uninstallEntry,
	type Registry,
	type RegistryEntry,
} from "./plugins/registry.ts";
export {
	loadPlugins,
	pluginSummary,
	type Plugin,
	type PluginDiagnostic,
	type PluginInterface,
	type PluginManifest,
} from "./plugins/loader.ts";
export {
	buildIndex,
	indexStats,
	loadIndex,
	saveIndex,
	searchIndex,
	type SymbolEntry,
	type SymbolIndex,
} from "./index/symbols.ts";
export { buildSystemPrompt, loadProjectInstructions } from "./prompt/system.ts";
export { compactIfNeeded } from "./runtime/compaction.ts";
export type { ContextBreakdown, ContextSegment, ContextSegmentKey } from "./runtime/context.ts";
export { estimateTokens } from "./tokens.ts";
export { hooksFor, makeAfterToolCall, makeBeforeToolCall, runHook } from "./runtime/hooks.ts";
export { AgentSession, type AgentSessionOptions, type SessionStatus } from "./runtime/session.ts";
export { SideChat, type SideChatOptions, type SideChatState } from "./runtime/sidechat.ts";
export {
	deepwiseHome,
	projectIdFor,
	SessionStore,
	type SessionMeta,
	type SessionRecord,
} from "./session/store.ts";
export {
	formatSkillCatalogue,
	formatSkillInvocation,
	loadSkills,
	parseFrontmatter,
	SKILLS_KEY,
	skillTool,
	type Skill,
	type SkillDiagnostic,
} from "./skills/index.ts";
export * from "./tools/index.ts";
export { builtinTools } from "./tools/index.ts";
export * from "./types.ts";
export {
	listPreviews,
	pruneSessionArtifacts,
	prunePreviews,
	previewsHome,
	readPreview,
	removePreviews,
	removeSessionArtifacts,
	scratchHome,
	writePreview,
	type PreviewFile,
	type PreviewRecord,
} from "./runtime/previews.ts";
