import type { ThinkingLevel } from "../types.ts";

export interface SubAgentProfile {
	/** Stable local id includes the provider, even when upstream model names are identical. */
	modelId?: string;
	thinking?: ThinkingLevel;
}

/** Shared by disk normalization and browser model selection without importing either consumer. */
export function normalizeSubAgentProfiles(value: unknown): Record<string, SubAgentProfile> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries: [string, SubAgentProfile][] = [];
	for (const [name, profile] of Object.entries(value)) {
		if (!name.trim() || !profile || typeof profile !== "object" || Array.isArray(profile)) continue;
		const modelId = "modelId" in profile && typeof profile.modelId === "string" ? profile.modelId.trim() : "";
		const thinking = "thinking" in profile && typeof profile.thinking === "string" ? profile.thinking.trim() : "";
		if (modelId || thinking) entries.push([name, { ...(modelId ? { modelId } : {}), ...(thinking ? { thinking } : {}) }]);
	}
	return Object.fromEntries(entries);
}
