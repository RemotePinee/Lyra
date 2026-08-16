import type { AppearanceSettings as Appearance } from "@lyra/core";
import { useApp } from "../../store.ts";
import { Card, GhostButton, Row, SectionTitle, Segmented, TextInput, Toggle } from "./controls.tsx";

/**
 * Mirrors `DEFAULT_APPEARANCE` in @lyra/core.
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
	uiFont: '"Inter Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
	codeFont: '"JetBrains Mono Variable", ui-monospace, "SF Mono", SFMono-Regular, Menlo, "PingFang SC", monospace',
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
	{ id: "lyra", label: "Lyra", patch: { accent: "#339CFF", darkBackground: "#171717", darkForeground: "#EDEDED" } },
	{ id: "graphite", label: "Graphite", patch: { accent: "#8E8E93", darkBackground: "#1C1C1E", darkForeground: "#F2F2F7" } },
	{ id: "moss", label: "Moss", patch: { accent: "#3ECF8E", darkBackground: "#121614", darkForeground: "#E6F2EC" } },
	{ id: "ember", label: "Ember", patch: { accent: "#FF8B3D", darkBackground: "#1A1412", darkForeground: "#F5E9E2" } },
];

import { ColorRow, NumberField, ThemePreview } from "./appearance-controls.tsx";

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
			<h1 className="pb-6 text-display leading-tight font-semibold tracking-tight text-ink">外观</h1>

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
						<span className="mt-2 mb-1 block text-label text-ink">
							{{ system: "系统", light: "浅色", dark: "深色" }[theme]}
						</span>
					</button>
				))}
			</div>

			<SectionTitle>{isDark ? "深色主题" : "浅色主题"}</SectionTitle>
			<Card className="mb-8">
				<div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
					<span className="text-label text-ink-muted">预设</span>
					<div className="flex gap-1.5">
						{PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								data-ly-tip={preset.label}
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
					detail="侧边栏透出窗口背后的内容（仅 macOS）。效果取决于背后是什么。"
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
							<span className="w-6 text-right font-mono text-label text-ink">{appearance.contrast}</span>
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
					detail="调整 Lyra 界面使用的基准字号"
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
