import type { ModelConfig, Usage } from "../types.ts";

/** Fill in the cost breakdown from raw token counts and the model's per-million pricing. */
export function computeCost(usage: Usage, model: ModelConfig): Usage {
	const p = model.pricing;
	if (!p) return usage;
	const per = (tokens: number, rate: number | undefined) => (tokens * (rate ?? 0)) / 1_000_000;
	const input = per(usage.input, p.input);
	const output = per(usage.output, p.output);
	const cacheRead = per(usage.cacheRead, p.cacheRead ?? p.input * 0.1);
	const cacheWrite = per(usage.cacheWrite, p.cacheWrite ?? p.input * 1.25);
	return {
		...usage,
		cost: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
	};
}
