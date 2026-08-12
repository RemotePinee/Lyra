import type { AppearanceSettings as Appearance } from "@deepwise/core";
import { useEffect, useState } from "react";
import { useApp } from "../../store.ts";
import { contrastingInk, parseHex } from "../../theme.ts";
import { Card, GhostButton, InlineSelect, Row, SectionTitle, Segmented, TextInput, Toggle } from "./controls.tsx";

/**
 * Mirrors `DEFAULT_APPEARANCE` in @deepwise/core.
 *
 * It is duplicated rather than imported because a value import from the core package would
 * pull its `node:` modules into the renderer bundle; only types may cross that boundary.
 */
const FACTORY_APPEARANCE: Appearance = {
	theme: "dark",
	accent: "#339CFF",
	lightBackground: "#FFFFFF",
	lightForeground: "#1A1C1F",
	darkBackground: "#171717",
	darkForeground: "#EDEDED",
	uiFont: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
	codeFont: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
	uiFontSize: 13,
	codeFontSize: 12,
	translucentSidebar: true,
	contrast: 60,
	pointerCursor: false,
	reduceMotion: "system",
	diffMarkers: "color",
	fontSmoothing: true,
};

const PRESETS: { id: string; label: string; patch: Partial<Appearance> }[] = [
	{ id: "deepwise", label: "DeepWise", patch: { accent: "#339CFF", darkBackground: "#171717", darkForeground: "#EDEDED" } },
	{ id: "graphite", label: "Graphite", patch: { accent: "#8E8E93", darkBackground: "#1C1C1E", darkForeground: "#F2F2F7" } },
	{ id: "moss", label: "Moss", patch: { accent: "#3ECF8E", darkBackground: "#121614", darkForeground: "#E6F2EC" } },
	{ id: "ember", label: "Ember", patch: { accent: "#FF8B3D", darkBackground: "#1A1412", darkForeground: "#F5E9E2" } },
];

export function AppearanceSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	if (!settings) return null;

	const appearance = settings.appearance;
	// One theme field now; this used to mirror it into a second, top-level one that nothing read.
	const patch = (next: Partial<Appearance>) =>
		void saveSettings({ ...settings, appearance: { ...appearance, ...next } });
	const isDark = appearance.theme === "dark" || (appearance.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

	return (
		<div className="pt-8">
			<h1 className="pb-6 text-[26px] leading-tight font-semibold tracking-tight text-ink">外观</h1>

			<SectionTitle>主题</SectionTitle>
			<div className="mb-8 grid grid-cols-3 gap-3">
				{(["system", "light", "dark"] as const).map((theme) => (
					<button
						key={theme}
						type="button"
						onClick={() => patch({ theme })}
						className={`rounded-[12px] border p-1.5 text-center transition-all duration-200 ${
							appearance.theme === theme
								? "border-ink ring-1 ring-ink"
								: "border-line hover:border-ink-faint"
						}`}
					>
						<ThemePreview variant={theme} accent={appearance.accent} />
						<span className="mt-2 mb-1 block text-[12.5px] text-ink">
							{{ system: "系统", light: "浅色", dark: "深色" }[theme]}
						</span>
					</button>
				))}
			</div>

			<SectionTitle>{isDark ? "深色主题" : "浅色主题"}</SectionTitle>
			<Card className="mb-8">
				<div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
					<span className="text-[12.5px] text-ink-muted">预设</span>
					<div className="flex gap-1.5">
						{PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								title={preset.label}
								onClick={() => patch(preset.patch)}
								className="h-6 w-6 rounded-full border border-line transition-transform duration-150 hover:scale-110"
								style={{ background: preset.patch.accent }}
							/>
						))}
					</div>
				</div>

				<ColorRow label="强调色" value={appearance.accent} onChange={(accent) => patch({ accent })} />
				<ColorRow
					label="背景"
					value={isDark ? appearance.darkBackground : appearance.lightBackground}
					onChange={(value) => patch(isDark ? { darkBackground: value } : { lightBackground: value })}
				/>
				<ColorRow
					label="前景"
					value={isDark ? appearance.darkForeground : appearance.lightForeground}
					onChange={(value) => patch(isDark ? { darkForeground: value } : { lightForeground: value })}
				/>

				<Row
					title="UI 字体"
					control={
						<TextInput
							value={appearance.uiFont}
							onChange={(uiFont) => patch({ uiFont })}
							className="w-[220px]"
						/>
					}
				/>
				<Row
					title="代码字体"
					control={
						<TextInput
							value={appearance.codeFont}
							onChange={(codeFont) => patch({ codeFont })}
							mono
							className="w-[220px]"
						/>
					}
				/>
				<Row
					title="半透明侧边栏"
					control={
						<Toggle
							checked={appearance.translucentSidebar}
							onChange={(translucentSidebar) => patch({ translucentSidebar })}
						/>
					}
				/>
				<Row
					title="对比度"
					control={
						<div className="flex items-center gap-3">
							<input
								type="range"
								min={0}
								max={100}
								value={appearance.contrast}
								onChange={(e) => patch({ contrast: Number(e.target.value) })}
								className="h-1 w-[180px] cursor-pointer appearance-none rounded-full bg-line accent-[var(--color-info)]"
								style={{ accentColor: appearance.accent }}
							/>
							<span className="w-6 text-right font-mono text-[12.5px] text-ink">{appearance.contrast}</span>
						</div>
					}
				/>
			</Card>

			<SectionTitle>偏好设置</SectionTitle>
			<Card>
				<Row
					title="使用指针光标"
					detail="悬停交互元素时切换为指针光标"
					control={
						<Toggle checked={appearance.pointerCursor} onChange={(pointerCursor) => patch({ pointerCursor })} />
					}
				/>
				<Row
					title="减少动态效果"
					detail="减少动画效果或匹配系统设置"
					control={
						<Segmented
							value={appearance.reduceMotion}
							onChange={(reduceMotion) => patch({ reduceMotion })}
							options={[
								{ value: "system", label: "系统" },
								{ value: "on", label: "开启" },
								{ value: "off", label: "关闭" },
							]}
						/>
					}
				/>
				<Row
					title="UI 字号"
					detail="调整 DeepWise 界面使用的基准字号"
					control={
						<NumberField
							value={appearance.uiFontSize}
							min={11}
							max={20}
							onChange={(uiFontSize) => patch({ uiFontSize })}
						/>
					}
				/>
				<Row
					title="代码字体大小"
					detail="调整聊天和差异视图中代码使用的基础字号"
					control={
						<NumberField
							value={appearance.codeFontSize}
							min={10}
							max={20}
							onChange={(codeFontSize) => patch({ codeFontSize })}
						/>
					}
				/>
				<Row
					title="差异标记"
					detail="使用颜色或 +/− 标记显示更改"
					control={
						<Segmented
							value={appearance.diffMarkers}
							onChange={(diffMarkers) => patch({ diffMarkers })}
							options={[
								{ value: "color", label: "颜色" },
								{ value: "symbols", label: "+/-" },
							]}
						/>
					}
				/>
				<Row
					title="字体平滑"
					detail="使用 macOS 原生字体抗锯齿"
					control={<Toggle checked={appearance.fontSmoothing} onChange={(fontSmoothing) => patch({ fontSmoothing })} />}
				/>
				<Row
					title="恢复默认"
					detail="把外观设置还原为出厂配置"
					control={
						<GhostButton onClick={() => patch(FACTORY_APPEARANCE)}>恢复</GhostButton>
					}
				/>
			</Card>
		</div>
	);
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
	const [draft, setDraft] = useState(value);
	const valid = parseHex(draft) !== null;

	// Switching theme swaps which colour this row edits. Without this the field kept showing
	// the dark value after switching to light, since useState only seeds on first render.
	// The case-insensitive compare keeps the user's own typing from being rewritten mid-edit.
	useEffect(() => {
		setDraft((current) => (current.toUpperCase() === value.toUpperCase() ? current : value));
	}, [value]);

	return (
		<div className="flex items-center justify-between border-b border-line-soft px-4 py-3 last:border-b-0">
			<span className="text-[13.5px] text-ink">{label}</span>
			<label
				className="flex h-[30px] cursor-pointer items-center gap-2 rounded-lg px-2.5 transition-colors"
				style={{ background: valid ? draft : "transparent", color: valid ? contrastingInk(draft) : undefined }}
			>
				<span className="h-3.5 w-3.5 rounded-full border border-current opacity-60" />
				<input
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						// Apply as soon as it parses, so dragging through values previews live.
						if (parseHex(e.target.value)) onChange(e.target.value.toUpperCase());
					}}
					onBlur={() => !valid && setDraft(value)}
					spellCheck={false}
					className={`w-[74px] bg-transparent font-mono text-[12.5px] tracking-wide ${valid ? "" : "text-danger"}`}
				/>
			</label>
		</div>
	);
}

function NumberField({
	value,
	min,
	max,
	onChange,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<input
				type="number"
				min={min}
				max={max}
				value={value}
				onChange={(e) => {
					const next = Number(e.target.value);
					if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
				}}
				className="h-[30px] w-[64px] rounded-lg border border-line bg-input px-2.5 text-center font-mono text-[12.5px] text-ink focus:border-ink-faint"
			/>
			<span className="text-[12px] text-ink-faint">px</span>
		</div>
	);
}

/** Miniature of the app shell, so each theme option is recognisable at a glance. */
function ThemePreview({ variant, accent }: { variant: "system" | "light" | "dark"; accent: string }) {
	const light = { shell: "#f5f5f5", card: "#ffffff", bar: "#e2e2e2", line: "#d6d6d6" };
	const dark = { shell: "#2b2b2b", card: "#1d1d1d", bar: "#3a3a3a", line: "#454545" };

	const Half = ({ c, clip }: { c: typeof light; clip?: string }) => (
		<g clipPath={clip}>
			<rect x="0" y="0" width="120" height="80" fill={c.shell} />
			<rect x="0" y="0" width="40" height="80" fill={c.bar} />
			<rect x="46" y="10" width="64" height="5" rx="2.5" fill={c.line} />
			<rect x="46" y="22" width="64" height="48" rx="5" fill={c.card} />
			<rect x="52" y="30" width="34" height="4" rx="2" fill={c.line} />
			<rect x="52" y="40" width="46" height="4" rx="2" fill={c.line} />
			<rect x="52" y="50" width="28" height="4" rx="2" fill={accent} opacity="0.85" />
		</g>
	);

	return (
		<svg viewBox="0 0 120 80" className="w-full rounded-[7px]" aria-hidden>
			<defs>
				<clipPath id={`dw-half-${variant}`}>
					<rect x="0" y="0" width="60" height="80" />
				</clipPath>
			</defs>
			{variant === "light" && <Half c={light} />}
			{variant === "dark" && <Half c={dark} />}
			{variant === "system" && (
				<>
					<Half c={dark} />
					<Half c={light} clip={`url(#dw-half-${variant})`} />
				</>
			)}
		</svg>
	);
}
