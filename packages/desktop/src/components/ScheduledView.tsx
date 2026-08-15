import type { ScheduledTask } from "@deepwise/core";
/*
 * From the sub-entry, not from the package root.
 *
 * Importing a *value* from "@deepwise/core" pulls the whole index into the renderer, and the whole
 * index reaches `node:fs`, `node:child_process` and the rest — the bundle loads, throws on the
 * first Node builtin, and the window renders nothing at all. Types are erased at compile time and
 * cost nothing; values have to come from an entry that is browser-safe on its own.
 */
import { nextRunAt } from "@deepwise/core/schedule";
import { Clock, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Scroller } from "./Scroller.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";
import { Toggle } from "./settings/controls.tsx";

export function ScheduledView() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const workspace = useApp((s) => s.workspace);
	const openSession = useApp((s) => s.openSession);
	const sessions = useApp((s) => s.sessions);
	const { compact } = useLayout();
	if (!settings) return null;

	const tasks = settings.scheduledTasks;
	const update = (id: string, patch: Partial<ScheduledTask>) =>
		void saveSettings({
			...settings,
			scheduledTasks: tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
		});
	const remove = (id: string) =>
		void saveSettings({ ...settings, scheduledTasks: tasks.filter((t) => t.id !== id) });
	const add = () =>
		void saveSettings({
			...settings,
			scheduledTasks: [
				...tasks,
				{
					id: `task-${Date.now().toString(36)}`,
					name: "新任务",
					cwd: workspace?.path ?? "",
					prompt: "检查一下未提交的改动，指出其中的问题。",
					schedule: { kind: "daily", time: "09:00" },
					enabled: false,
				},
			],
		});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Scroller className="flex-1" contentClassName={`mx-auto w-full max-w-[880px] py-6 ${compact ? "px-4" : "px-8"}`}>
				<header className="flex flex-wrap items-start justify-between gap-3 pb-6">
					<div>
						<h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink">已安排</h1>
						<p className="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-muted">
							到点自动开一个新会话并发送提示。每次都是全新会话 —— 反复累积的历史会让任务逐渐跑偏，最后撑爆上下文。
						</p>
					</div>
					<button
						type="button"
						onClick={add}
						className="flex h-7 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
					>
						<Plus size={12} strokeWidth={2} />
						新建
					</button>
				</header>

				{tasks.length === 0 && (
					<p className="py-16 text-center text-[13px] leading-relaxed text-ink-faint">
						还没有安排任务。
						<br />
						常见用途：每天早上审一遍未提交改动、每小时跑一次测试并报告失败。
					</p>
				)}

				<div className="space-y-3">
					{tasks.map((task) => (
						<TaskCard
							key={task.id}
							task={task}
							lastSessionTitle={sessions.find((s) => s.id === task.lastSessionId)?.title}
							onChange={(patch) => update(task.id, patch)}
							onRemove={() => remove(task.id)}
							onOpenLast={() => {
								const meta = sessions.find((s) => s.id === task.lastSessionId);
								if (meta) void openSession(meta);
							}}
						/>
					))}
				</div>
			</Scroller>
		</div>
	);
}

/** When it fires next, in words. Disabled tasks say so rather than showing a date they will ignore. */
function describeNext(task: ScheduledTask): string {
	if (!task.enabled) return "已停用";
	const at = nextRunAt(task);
	return at === null ? "—" : new Date(at).toLocaleString("zh-CN");
}

function TaskCard({
	task,
	lastSessionTitle,
	onChange,
	onRemove,
	onOpenLast,
}: {
	task: ScheduledTask;
	lastSessionTitle?: string;
	onChange: (patch: Partial<ScheduledTask>) => void;
	onRemove: () => void;
	onOpenLast: () => void;
}) {
	const [prompt, setPrompt] = useState(task.prompt);
	const [name, setName] = useState(task.name);
	const [running, setRunning] = useState(false);

	return (
		<div className="dw-enter overflow-hidden rounded-[10px] border border-line bg-card/40">
			<div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-2.5">
				<Clock size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					onBlur={() => name !== task.name && onChange({ name })}
					className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink focus:outline-none"
				/>
				<button
					type="button"
					data-dw-tip="立即运行一次"
					disabled={running}
					onClick={async () => {
						setRunning(true);
						try {
							await window.deepwise.scheduler.runNow(task.id);
						} finally {
							setTimeout(() => setRunning(false), 1500);
						}
					}}
					className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-40"
				>
					<Play size={12} strokeWidth={2} />
				</button>
				<Toggle checked={task.enabled} onChange={(enabled) => onChange({ enabled })} />
				<button
					type="button"
					data-dw-tip="删除"
					onClick={onRemove}
					className="text-ink-faint transition-colors hover:text-danger"
				>
					<Trash2 size={13} strokeWidth={1.8} />
				</button>
			</div>

			<div className="space-y-3 px-4 py-3">
				<label className="block">
					<span className="mb-1.5 block text-[12px] text-ink-muted">提示</span>
					<textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onBlur={() => prompt !== task.prompt && onChange({ prompt })}
						rows={2}
						className="w-full resize-none rounded-[10px] border border-line bg-input px-3 py-2 text-[12.5px] leading-relaxed text-ink focus:border-ink-faint"
					/>
				</label>

				<div className="flex flex-wrap items-center gap-3">
					<div className="flex gap-0.5 rounded-lg bg-card p-0.5">
						{(["daily", "interval"] as const).map((kind) => (
							<button
								key={kind}
								type="button"
								onClick={() =>
									onChange({
										schedule: kind === "daily" ? { kind: "daily", time: "09:00" } : { kind: "interval", minutes: 60 },
									})
								}
								className={`h-[26px] rounded-md px-3 text-[12px] transition-colors ${
									task.schedule.kind === kind ? "bg-elevated text-ink" : "text-ink-muted hover:text-ink"
								}`}
							>
								{kind === "daily" ? "每天" : "每隔"}
							</button>
						))}
					</div>

					{task.schedule.kind === "daily" ? (
						<input
							type="time"
							value={task.schedule.time}
							onChange={(e) => onChange({ schedule: { kind: "daily", time: e.target.value } })}
							className="h-[30px] rounded-lg border border-line bg-input px-2.5 font-mono text-[12.5px] text-ink focus:border-ink-faint"
						/>
					) : (
						<div className="flex items-center gap-1.5">
							<input
								type="number"
								min={1}
								value={task.schedule.minutes}
								onChange={(e) => {
									const minutes = Number(e.target.value);
									if (minutes >= 1) onChange({ schedule: { kind: "interval", minutes } });
								}}
								className="h-[30px] w-[70px] rounded-lg border border-line bg-input px-2.5 text-center font-mono text-[12.5px] text-ink focus:border-ink-faint"
							/>
							<span className="text-[12px] text-ink-faint">分钟</span>
						</div>
					)}

					<div className="flex-1" />
					<span className="font-mono text-[11.5px] text-ink-faint">{task.cwd || "（未设置工作区）"}</span>
				</div>

				<div className="flex flex-wrap items-center gap-x-3 text-[11.5px] text-ink-faint">
					<span>上次运行：{task.lastRunAt ? new Date(task.lastRunAt).toLocaleString("zh-CN") : "从未"}</span>
					{/*
					 * Computed from the same rules the scheduler runs on, not from a second copy of
					 * them: `nextRunAt` lives in core precisely so the badge and the run cannot
					 * disagree about when 09:00 is.
					 */}
					<span>下次运行：{describeNext(task)}</span>
					{task.lastSessionId && lastSessionTitle && (
						<button type="button" onClick={onOpenLast} className="text-ink-muted transition-colors hover:text-ink">
							打开上次会话
						</button>
					)}
					{task.lastError && <span className="text-danger">{task.lastError}</span>}
				</div>
			</div>
		</div>
	);
}
