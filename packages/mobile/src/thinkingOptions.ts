export interface ThinkingOption {
	id: string;
	label: string;
	detail?: string;
	isDefault?: boolean;
}

export interface ModelLike {
	id?: string;
	modelId?: string;
	name?: string;
	supportsThinking?: boolean;
	thinkingOptions?: ThinkingOption[];
}

export const STANDARD_3_LEVEL_OPTIONS: ThinkingOption[] = [
	{ id: "off", label: "关闭", detail: "不推理，直接作答。最快。" },
	{ id: "low", label: "低", detail: "简单任务够用。" },
	{ id: "medium", label: "中", detail: "日常编码的默认档。", isDefault: true },
	{ id: "high", label: "高", detail: "复杂重构、疑难排查。" },
];

export const STANDARD_5_LEVEL_OPTIONS: ThinkingOption[] = [
	{ id: "off", label: "关闭", detail: "不推理，直接作答。最快。" },
	{ id: "low", label: "低", detail: "简单任务够用。" },
	{ id: "medium", label: "中", detail: "日常编码的默认档。", isDefault: true },
	{ id: "high", label: "高", detail: "复杂重构、疑难排查。" },
	{ id: "xhigh", label: "超高", detail: "超深度推演，处理高难度任务。" },
];

export const GPT_5_6_STANDARD_OPTIONS: ThinkingOption[] = [
	{ id: "off", label: "关闭", detail: "不推理，直接作答。最快。" },
	{ id: "minimal", label: "极简", detail: "只做最低限度的思考。" },
	{ id: "low", label: "低", detail: "简单任务够用。" },
	{ id: "medium", label: "中", detail: "日常编码的默认档。", isDefault: true },
	{ id: "high", label: "高", detail: "复杂重构、疑难排查。" },
	{ id: "xhigh", label: "超高", detail: "更深层次的逻辑推演。" },
	{ id: "max", label: "最高", detail: "把预算拉满，最慢也最稳。" },
];

export const GPT_5_6_SOL_OPTIONS: ThinkingOption[] = [
	{ id: "off", label: "关闭", detail: "不推理，直接作答。最快。" },
	{ id: "minimal", label: "极简", detail: "轻量预检与快速分析。" },
	{ id: "low", label: "低", detail: "常规单测与基础修改。" },
	{ id: "medium", label: "中", detail: "日常编码的默认档。", isDefault: true },
	{ id: "high", label: "高", detail: "跨模块重构与排障。" },
	{ id: "xhigh", label: "超高", detail: "深层次推演与复杂架构推导。" },
	{ id: "max", label: "最高", detail: "算力拉满，极深推演。" },
	{ id: "ultra", label: "极致", detail: "极致推理模式，算力全开。" },
];

export const FAST_3_LEVEL_OPTIONS: ThinkingOption[] = [
	{ id: "off", label: "关闭", detail: "不推理，直接作答。最快。" },
	{ id: "low", label: "低", detail: "快速推理。" },
	{ id: "high", label: "高", detail: "深度推理。", isDefault: true },
];

export function resolveModelThinkingOptions(model?: ModelLike | null): ThinkingOption[] {
	if (!model || model.supportsThinking === false) {
		return [];
	}

	if (model.thinkingOptions && model.thinkingOptions.length > 0) {
		return model.thinkingOptions;
	}

	const id = (model.modelId || model.id || "").toLowerCase();

	if (id.includes("gemini") || id.includes("gemma")) {
		return STANDARD_3_LEVEL_OPTIONS;
	}

	if (id.includes("5.6-sol") || id.includes("5.6-terra") || (id.includes("gpt-") && id.includes("ultra"))) {
		return GPT_5_6_SOL_OPTIONS;
	}

	if (id.includes("gpt-5.6") || id.includes("gpt5.6")) {
		return GPT_5_6_STANDARD_OPTIONS;
	}

	if (id.includes("gpt-5.5") || id.includes("gpt-5.4") || id.includes("gpt-5.3")) {
		if (id.includes("mini")) {
			return STANDARD_3_LEVEL_OPTIONS;
		}
		return STANDARD_5_LEVEL_OPTIONS;
	}

	if (id.includes("gpt-4.1") || id.includes("o3") || id.includes("o4-mini")) {
		return FAST_3_LEVEL_OPTIONS;
	}

	return STANDARD_3_LEVEL_OPTIONS;
}
