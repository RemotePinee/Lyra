import type { ModelConfig, ProviderConfig } from "@deepwise/core";
import { ScrollText } from "./ScrollText.tsx";
import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { MenuBody, MenuItem, MenuLabel, MenuSeparator, Popover, type Anchor } from "./Popover.tsx";
import { useApp } from "../store.ts";

export function formatWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return String(tokens);
}

/** How many models the top level shows before the rest move behind "更多模型". */
const SHORTLIST = 4;

export function ModelMenu({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
	const settings = useApp((s) => s.settings);
	const meta = useApp((s) => s.meta);
	const setModel = useApp((s) => s.setModel);
	const saveSettings = useApp((s) => s.saveSettings);
	const setView = useApp((s) => s.setView);
	const setSection = useApp((s) => s.setSettingsSection);
	const [showAll, setShowAll] = useState(false);

	const current = meta?.modelId ?? settings?.defaultModelId ?? null;
	const enabled = (settings?.providers ?? []).filter((p) => p.enabled);
	const flat = enabled.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
	const shortlist = flat.slice(0, SHORTLIST);
	const rest = flat.slice(SHORTLIST);
	const fastMode = settings?.thinking === "off";

	const choose = (modelId: string) => {
		void setModel(modelId);
		onClose();
	};

	// Number keys pick from the shortlist, matching the digits shown on each row.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const index = Number(event.key) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= shortlist.length) return;
			event.preventDefault();
			choose(shortlist[index].model.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<Popover anchor={anchor} onClose={onClose} placement="top" align="start" width={272}>
			<MenuBody>
				<MenuLabel>模型</MenuLabel>

				{flat.length === 0 && (
					<MenuItem
						onClick={() => {
							setView("settings");
							setSection("models");
							onClose();
						}}
					>
						还没有可用模型，去添加供应商
					</MenuItem>
				)}

				{(showAll ? flat : shortlist).map((entry, index) => (
					<MenuItem
						key={entry.model.id}
						selected={current === entry.model.id}
						title={entry.provider.name}
						hint={formatWindow(entry.model.contextWindow)}
						trailing={
							current === entry.model.id ? (
								<Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" />
							) : (
								// Reserves the checkmark's width so rows do not shift as the choice moves.
								<span className="w-[13px] shrink-0 text-right font-mono text-[11px] text-ink-faint">
									{!showAll && index < SHORTLIST ? index + 1 : ""}
								</span>
							)
						}
						onClick={() => choose(entry.model.id)}
					>
						{entry.model.name}
					</MenuItem>
				))}

				{rest.length > 0 && (
					<>
						<MenuSeparator />
						<MenuItem
							onClick={() => setShowAll((v) => !v)}
							trailing={
								<ChevronRight
									size={13}
									strokeWidth={2}
									className="shrink-0 text-ink-faint transition-transform duration-200"
									style={showAll ? { transform: "rotate(90deg)" } : undefined}
								/>
							}
						>
							{showAll ? "收起" : "更多模型"}
						</MenuItem>
					</>
				)}

				<MenuSeparator />
				<MenuLabel>快速模式</MenuLabel>
				<MenuItem
					detail="跳过推理直接作答，明显更快"
					trailing={
						/*
						 * Indicator, not a control: the whole row is the switch. A real Toggle here
						 * would be a button inside a button — invalid markup, and the click would
						 * fire both handlers and cancel itself out.
						 */
						<span
							aria-hidden
							className={`mt-[3px] relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-200 ${
								fastMode ? "bg-info" : "bg-line"
							}`}
						>
							<span
								className="absolute top-[3px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-[left] duration-200"
								style={{ left: fastMode ? 17 : 3 }}
							/>
						</span>
					}
					onClick={() => {
						if (!settings) return;
						// Remember the previous level so turning fast mode off restores it.
						void saveSettings({
							...settings,
							thinking: fastMode ? (settings.lastThinking ?? "medium") : "off",
						});
					}}
				>
					关闭思考
				</MenuItem>
			</MenuBody>
		</Popover>
	);
}
