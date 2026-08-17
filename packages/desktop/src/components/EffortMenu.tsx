import type { ThinkingLevel } from "@lyra/core";
import { CircleHelp } from "lucide-react";
import { useState } from "react";
import { Popover, type Anchor } from "./Popover.tsx";
import { RollingText } from "./RollingText.tsx";
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
		/*
		 * The ordinary menu width, not a bespoke one.
		 *
		 * It was 232 — picked because it has to sit inside the conversation column, 458px wide at
		 * the default window with the side panel open. Every size below that satisfies the same
		 * constraint, so the constraint does not need its own number; `group` because this is a
		 * slider and a paragraph, and nothing on it is a thing to pick.
		 */
		<Popover anchor={anchor} onClose={onClose} placement="top" align="center" width="default" role="group" label="推理强度">
			<div className="px-3 py-2.5">
				<div className="flex items-center gap-1.5">
					<span className="text-label text-ink-muted">推理强度</span>
					{/*
					 * The colour turns violet at the top level along with the track — the name and the
					 * bar are saying the same thing, and only one of them changing looked like a bug.
					 * The roll itself is `RollingText`, the same one every other changing label uses.
					 */}
					<span className="text-label font-medium" style={{ color: atMax ? "var(--color-violet)" : "var(--color-info)" }}>
						<RollingText>{current.label}</RollingText>
					</span>
					<div className="flex-1" />
					<button
						type="button"
						data-ly-tip="各档位说明"
						onClick={() => setShowHelp((v) => !v)}
						className={`transition-colors ${showHelp ? "text-ink" : "text-ink-faint hover:text-ink"}`}
					>
						<CircleHelp size={13} strokeWidth={1.8} />
					</button>
				</div>

				<div className="mt-2 mb-1.5 flex items-center justify-between text-detail text-ink-faint">
					<span>更快</span>
					<span>更聪明</span>
				</div>

				<DotSlider value={index} max={EFFORT_LEVELS.length - 1} disabled={!supported} atMax={atMax} onChange={set} />

				{/*
				 * Fixed height, so a one-line description replacing a two-line one does not resize the
				 * popover mid-drag — the control you are dragging would move out from under the pointer.
				 */}
				<p className="mt-2 h-[34px] text-detail leading-relaxed text-ink-faint">
					<RollingText rollKey={supported ? current.value : "unsupported"} className="block">
						{supported ? current.detail : "当前模型不支持推理，这项设置不会生效。"}
					</RollingText>
				</p>

				{/*
				 * Kept mounted and unfolded, so it closes the same way it opens. Rendered
				 * conditionally it could only ever animate in — closing was a cut, which on a panel
				 * that changes height reads as the popover having been redrawn.
				 */}
				<div className="ly-reveal" data-open={showHelp} aria-hidden={!showHelp}>
					<div>
						<div className="mt-2.5 space-y-1 border-t border-line-soft pt-2.5 text-caption leading-relaxed text-ink-faint">
							{EFFORT_LEVELS.map((entry) => (
								<div key={entry.value} className="flex gap-2">
									<span className={`w-7 shrink-0 transition-colors ${entry.value === level ? "text-ink" : ""}`}>
										{entry.label}
									</span>
									<span className="flex-1">{entry.detail}</span>
								</div>
							))}
							<p className="pt-1">供应商对中间档位的处理不一，有的只区分开与关；「关闭」始终显式要求不要推理。</p>
						</div>
					</div>
				</div>
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
									className={`h-[3px] w-[3px] rounded-[0.5px] transition-[background-color,opacity] ${
										lit && atMax ? "ly-thrust" : ""
									}`}
									style={{
										background: lit ? (atMax ? "var(--color-violet)" : "var(--color-info)") : "var(--color-ink-faint)",
										opacity: lit ? intensity : 0.3,
										transitionDuration: "var(--ly-t-base)",
										transitionTimingFunction: "var(--ly-e-out)",
										/*
										 * Delayed by distance from the handle, so the pulse starts there and runs
										 * backwards. Left to right it read as the bar filling up — a progress bar,
										 * which is the opposite of what this is.
										 */
										animationDelay: lit && atMax ? `${(COLUMNS - 1 - column) * 34 + row * 60}ms` : undefined,
										["--ly-matrix-low" as string]: lit ? String(intensity) : undefined,
									}}
								/>
							))}
						</div>
					);
				})}
			</div>

			{/* Handle sits on the boundary between lit and unlit columns. */}
			<div
				className="ly-knob pointer-events-none absolute top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 rounded-[5px] border"
				style={{
					left: `calc(8px + ${ratio} * (100% - 16px))`,
					transition: "left var(--ly-t-base) var(--ly-e-out)",
				}}
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
