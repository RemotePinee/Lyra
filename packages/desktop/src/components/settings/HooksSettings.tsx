import type { HookConfig } from "@deepwise/core";
import { ScrollText } from "../ScrollText.tsx";
import { Anchor, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useApp } from "../../store.ts";
import { Badge, Card, EmptyHint, Field, GhostButton, SectionTitle, Select, TextInput, Toggle } from "./controls.tsx";

const PRESETS: { label: string; hook: Omit<HookConfig, "id"> }[] = [
	{
		label: "记录所有命令",
		hook: {
			command: 'echo "$(date -u +%FT%TZ) $DW_TOOL $DW_ARGS" >> .deepwise/tool-audit.log',
			tools: ["bash"],
			event: "after-tool",
			enabled: true,
			blocking: false,
		},
	},
	{
		label: "禁止改动 lockfile",
		hook: {
			command: 'case "$DW_ARGS" in *lock*) echo "lockfile 受保护" >&2; exit 1 ;; esac',
			tools: ["edit", "write"],
			event: "before-tool",
			enabled: true,
			blocking: true,
		},
	},
	{
		label: "写入后跑格式化",
		hook: {
			command: "command -v prettier >/dev/null && prettier --write . >/dev/null 2>&1 || true",
			tools: ["write", "edit"],
			event: "after-tool",
			enabled: false,
			blocking: false,
		},
	},
];

export function HooksSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	if (!settings) return null;

	const hooks = settings.hooks;
	const update = (id: string, patch: Partial<HookConfig>) =>
		void saveSettings({ ...settings, hooks: hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
	const add = (hook: Omit<HookConfig, "id">) =>
		void saveSettings({ ...settings, hooks: [...hooks, { ...hook, id: `hook-${Date.now().toString(36)}` }] });
	const remove = (id: string) => void saveSettings({ ...settings, hooks: hooks.filter((h) => h.id !== id) });

	return (
		<div className="pt-8">
			<header className="flex items-start justify-between pb-7">
				<div>
					<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">钩子</h1>
					<p className="mt-2 max-w-[580px] text-[13px] leading-relaxed text-ink-muted">
						在工具调用前后运行一段命令。工具名和参数通过环境变量{" "}
						<code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">$DW_TOOL</code>、
						<code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">$DW_ARGS</code> 传入，
						同时也会以 JSON 写到 stdin。
					</p>
				</div>
				<div className="shrink-0 pt-1">
					<GhostButton
						onClick={() =>
							add({ command: "echo $DW_TOOL", tools: [], event: "before-tool", enabled: true, blocking: false })
						}
					>
						<span className="flex items-center gap-1.5">
							<Plus size={12} strokeWidth={2} />
							新建
						</span>
					</GhostButton>
				</div>
			</header>

			<SectionTitle>快速添加</SectionTitle>
			<Card className="mb-7">
				{PRESETS.map((preset) => (
					<div key={preset.label} className="flex items-center gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
						<Anchor size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
						<div className="min-w-0 flex-1">
							<div className="text-[13px] text-ink">{preset.label}</div>
							<div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-faint">{preset.hook.command}</div>
						</div>
						<Badge tone="muted">{preset.hook.event === "before-tool" ? "调用前" : "调用后"}</Badge>
						{preset.hook.blocking && <Badge tone="accent">可阻断</Badge>}
						<GhostButton onClick={() => add(preset.hook)}>添加</GhostButton>
					</div>
				))}
			</Card>

			<SectionTitle>已配置（{hooks.length}）</SectionTitle>
			{hooks.length === 0 ? (
				<Card>
					<EmptyHint>
						还没有钩子。
						<br />
						常见用途：审计所有命令、阻止改动受保护的文件、写入后自动格式化。
					</EmptyHint>
				</Card>
			) : (
				<div className="space-y-3">
					{hooks.map((hook) => (
						<HookCard
							key={hook.id}
							hook={hook}
							onChange={(patch) => update(hook.id, patch)}
							onRemove={() => remove(hook.id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function HookCard({
	hook,
	onChange,
	onRemove,
}: {
	hook: HookConfig;
	onChange: (patch: Partial<HookConfig>) => void;
	onRemove: () => void;
}) {
	const [command, setCommand] = useState(hook.command);

	return (
		<Card>
			<div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
				<Anchor size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
				<Badge tone="muted">{hook.event === "before-tool" ? "调用前" : "调用后"}</Badge>
				{hook.blocking && <Badge tone="accent">可阻断</Badge>}
				<ScrollText text={hook.command} className="min-w-0 flex-1 font-mono text-[12px] text-ink-muted" />
				<Toggle checked={hook.enabled} onChange={(enabled) => onChange({ enabled })} />
				<button
					type="button"
					title="删除"
					onClick={onRemove}
					className="text-ink-faint transition-colors hover:text-danger"
				>
					<Trash2 size={14} strokeWidth={1.8} />
				</button>
			</div>

			<div className="space-y-3 px-4 py-3.5">
				<Field label="命令" hint="在工作区目录下用你的默认 shell 执行">
					<TextInput
						value={command}
						onChange={setCommand}
						onBlur={() => command !== hook.command && onChange({ command })}
						mono
					/>
				</Field>

				<div className="grid grid-cols-2 gap-3">
					<Field label="时机">
						<Select
							value={hook.event}
							onChange={(event) => onChange({ event })}
							options={[
								{ value: "before-tool", label: "工具调用前" },
								{ value: "after-tool", label: "工具调用后" },
							]}
						/>
					</Field>
					<Field label="限定工具" hint="逗号分隔，留空表示全部">
						<TextInput
							value={hook.tools.join(", ")}
							onChange={(value) =>
								onChange({ tools: value.split(",").map((t) => t.trim()).filter(Boolean) })
							}
							mono
							placeholder="bash, write, edit"
						/>
					</Field>
				</div>

				{hook.event === "before-tool" && (
					<label className="flex items-center justify-between rounded-[10px] border border-line px-3.5 py-2.5">
						<span className="min-w-0 flex-1">
							<span className="block text-[13px] text-ink">非零退出时阻断调用</span>
							<span className="block text-[12px] text-ink-muted">
								退出码不为 0 时，这次工具调用会变成一条错误结果交给模型，而不是直接执行
							</span>
						</span>
						<Toggle checked={hook.blocking} onChange={(blocking) => onChange({ blocking })} />
					</label>
				)}
			</div>
		</Card>
	);
}
