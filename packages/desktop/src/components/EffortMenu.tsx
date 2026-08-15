import type { ThinkingLevel } from "@deepwise/core";
import { CircleHelp } from "lucide-react";
import { useState } from "react";
import { Popover, type Anchor } from "./Popover.tsx";
import { useApp } from "../store.ts";

/** Ordered low to high; the slider index maps straight onto this. */
const EFFORT_LEVELS: { value: ThinkingLevel; label: string; detail: string }[] = [
	{ value: "off", label: "关闭", detail: "不推理，直接作答。最快。" },
	{ value: "minimal", label: "极简", detail: "只做最低限度的思考。" },
	{ value: "low", label: "低", detail: "简单任务够用。" },
	{ value: "medium", label: "中", detail: "日常编码的默认档。" },
	{ value: "high", label: "高", detail: "复杂重构、疑难排查。" },
	{ value: "max", label: "最高", detail: "把预算拉满，最慢也最稳。" },
];

export function effortLabel(level: ThinkingLevel): string {
	return EFFORT_LEVELS.find((l) => l.value === level)?.label ?? "中";
}

export function EffortMenu({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const meta = useApp((s) => s.meta);
	const [showHelp, setShowHelp] = useState(false);

	const level = settings?.thinking ?? "medium";
	const index = Math.max(0, EFFORT_LEVELS.findIndex((l) => l.value === level));
	const current = EFFORT_LEVELS[index];
	const atMax = index === EFFORT_LEVELS.length - 1;

	const model = settings?.providers
		.flatMap((p) => p.models)
		.find((m) => m.id === (meta?.modelId ?? settings.defaultModelId));
	const supported = model?.supportsThinking !== false;

	const set = (nextIndex: number) => {
		if (!settings) return;
		const next = EFFORT_LEVELS[Math.min(EFFORT_LEVELS.length - 1, Math.max(0, nextIndex))].value;
		void saveSettings({
			...settings,
			thinking: next,
			// Keep the last non-off level so fast mode can put it back.
			...(next !== "off" ? { lastThinking: next } : {}),
		});
	};

	return (
		// 232, down from 288: it has to sit inside the conversation column, which is 458px wide
		// at the default window with the side panel open.
		<Popover anchor={anchor} onClose={onClose} placement="top" align="center" width={232}>
			<div className="px-3 py-2.5">
				<div className="flex items-center gap-1.5">
					<span className="text-[12.5px] text-ink-muted">推理强度</span>
					<span className="text-[12.5px] font-medium" style={{ color: "var(--color-info)" }}>
						{current.label}
					</span>
					<div className="flex-1" />
					<button
						type="button"
						data-dw-tip="各档位说明"
						onClick={() => setShowHelp((v) => !v)}
						className={`transition-colors ${showHelp ? "text-ink" : "text-ink-faint hover:text-ink"}`}
					>
						<CircleHelp size={13} strokeWidth={1.8} />
					</button>
				</div>

				<div className="mt-2 mb-1.5 flex items-center justify-between text-[11.5px] text-ink-faint">
					<span>更快</span>
					<span>更聪明</span>
				</div>

				<DotSlider value={index} max={EFFORT_LEVELS.length - 1} disabled={!supported} atMax={atMax} onChange={set} />

				<p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
					{supported ? current.detail : "当前模型不支持推理，这项设置不会生效。"}
				</p>

				{showHelp && (
					<div className="dw-enter mt-2.5 space-y-1 border-t border-line-soft pt-2.5 text-[11px] leading-relaxed text-ink-faint">
						{EFFORT_LEVELS.map((entry) => (
							<div key={entry.value} className="flex gap-2">
								<span className={`w-7 shrink-0 ${entry.value === level ? "text-ink" : ""}`}>{entry.label}</span>
								<span className="flex-1">{entry.detail}</span>
							</div>
						))}
						<p className="pt-1">供应商对中间档位的处理不一，有的只区分开与关；「关闭」始终显式要求不要推理。</p>
					</div>
				)}
			</div>
		</Popover>
	);
}

const COLUMNS = 19;
const ROWS = 3;

/**
 * A stepped slider drawn as a dot matrix.
 *
 * Each column is one pixel-ish tick of effort; columns left of the handle light up, and their
 * opacity ramps left-to-right so the track reads as intensity rather than a progress bar. At
 * the top level the lit columns breathe, which is the only state where the extra cost is
 * worth signalling.
 */
function DotSlider({
	value,
	max,
	disabled,
	atMax,
	onChange,
}: {
	value: number;
	max: number;
	disabled?: boolean;
	atMax?: boolean;
	onChange: (value: number) => void;
}) {
	const ratio = max === 0 ? 0 : value / max;
	const litColumns = Math.round(ratio * COLUMNS);

	return (
		<div className={`relative h-[24px] ${disabled ? "opacity-40" : ""}`}>
			<div className="absolute inset-0 flex items-center gap-px overflow-hidden rounded-[7px] bg-card px-[6px]">
				{Array.from({ length: COLUMNS }, (_, column) => {
					const lit = column < litColumns;
					// Ramp so the right-hand end of the lit run is brightest.
					const intensity = 0.32 + (column / (COLUMNS - 1)) * 0.68;
					return (
						<div key={column} className="flex flex-1 flex-col items-center gap-[3px]">
							{Array.from({ length: ROWS }, (_, row) => (
								<span
									key={row}
									className={`h-[3px] w-[3px] rounded-[0.5px] transition-[background-color,opacity] duration-200 ${
										lit && atMax ? "dw-matrix" : ""
									}`}
									style={{
										background: lit ? "var(--color-info)" : "var(--color-ink-faint)",
										opacity: lit ? intensity : 0.3,
										animationDelay: lit && atMax ? `${column * 30 + row * 90}ms` : undefined,
									}}
								/>
							))}
						</div>
					);
				})}
			</div>

			{/* Handle sits on the boundary between lit and unlit columns. */}
			<div
				className="dw-knob pointer-events-none absolute top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 rounded-[5px] border transition-[left] duration-200"
				style={{ left: `calc(8px + ${ratio} * (100% - 16px))` }}
			/>

			<input
				type="range"
				min={0}
				max={max}
				step={1}
				value={value}
				disabled={disabled}
				aria-label="推理强度"
				onChange={(e) => onChange(Number(e.target.value))}
				className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
			/>
		</div>
	);
}
