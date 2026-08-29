import type { CodeThemeSpec } from "../code-themes.ts";

export function CodeAppearancePreview({
	lightTheme,
	darkTheme,
	fontFamily,
}: {
	lightTheme: CodeThemeSpec;
	darkTheme: CodeThemeSpec;
	fontFamily?: string;
}) {
	return (
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
			<CodeSnippetBox theme={lightTheme} fontFamily={fontFamily} label="浅色预览" />
			<CodeSnippetBox theme={darkTheme} fontFamily={fontFamily} label="深色预览" />
		</div>
	);
}

function CodeSnippetBox({
	theme,
	fontFamily,
	label,
}: {
	theme: CodeThemeSpec;
	fontFamily?: string;
	label: string;
}) {
	const t = theme.tokens;

	return (
		<div
			className="overflow-hidden rounded-xl border border-line-soft transition-all duration-[var(--ly-t-base)]"
			style={{
				backgroundColor: theme.background,
				color: theme.foreground,
				fontFamily: fontFamily || "var(--ly-code-font)",
			}}
		>
			<div className="flex items-center justify-between border-b border-black/5 px-3 py-1.5 text-caption opacity-60 dark:border-white/5">
				<span className="font-sans text-[11px] font-medium tracking-wide">{label}</span>
				<span className="text-[11px]">{theme.label}</span>
			</div>
			<div className="py-2 text-[12px] leading-[1.65]">
				{/* Line 1 */}
				<div className="flex px-3">
					<span className="w-5 shrink-0 opacity-40 select-none text-right pr-2">1</span>
					<div className="min-w-0">
						<span style={{ color: t.keyword }}>function </span>
						<span style={{ color: t.function }}>greet</span>
						<span style={{ color: t.punctuation }}>(</span>
						<span style={{ color: t.variable }}>name</span>
						<span style={{ color: t.punctuation }}>: </span>
						<span style={{ color: t.type }}>string</span>
						<span style={{ color: t.punctuation }}>) &#123;</span>
					</div>
				</div>

				{/* Line 2 (Diff Removed) */}
				<div className="flex px-3" style={{ backgroundColor: theme.removedBg }}>
					<span className="w-5 shrink-0 select-none text-right pr-2 text-danger font-medium opacity-80">2 -</span>
					<div className="min-w-0">
						<span style={{ color: t.keyword }}>&nbsp;&nbsp;return </span>
						<span style={{ color: t.string }}>"Hello, " </span>
						<span style={{ color: t.operator }}>+ </span>
						<span style={{ color: t.variable }}>name</span>
						<span style={{ color: t.punctuation }}>;</span>
					</div>
				</div>

				{/* Line 3 (Diff Added) */}
				<div className="flex px-3" style={{ backgroundColor: theme.addedBg }}>
					<span className="w-5 shrink-0 select-none text-right pr-2 text-ok font-medium opacity-80">2 +</span>
					<div className="min-w-0">
						<span style={{ color: t.keyword }}>&nbsp;&nbsp;return </span>
						<span style={{ color: t.string }}>`Hello, $&#123;</span>
						<span style={{ color: t.variable }}>name</span>
						<span style={{ color: t.string }}>&#125;!`</span>
						<span style={{ color: t.punctuation }}>;</span>
					</div>
				</div>

				{/* Line 4 */}
				<div className="flex px-3">
					<span className="w-5 shrink-0 opacity-40 select-none text-right pr-2">3</span>
					<div className="min-w-0">
						<span style={{ color: t.punctuation }}>&#125;</span>
					</div>
				</div>
			</div>
		</div>
	);
}
