import { useEffect, useState } from "react";
import { ScrollText } from "../ScrollText.tsx";
import type { SessionMeta } from "@deepwise/core";
import { useApp } from "../../store.ts";
import { Card, EmptyHint, SectionTitle } from "./controls.tsx";

export function UsageSettings() {
	const sessionsFromStore = useApp((s) => s.sessions);
	const [sessions, setSessions] = useState<SessionMeta[]>(sessionsFromStore);

	useEffect(() => {
		void window.deepwise.sessions.list().then(setSessions);
	}, []);

	const totals = sessions.reduce(
		(acc, session) => ({
			input: acc.input + session.usage.input,
			output: acc.output + session.usage.output,
			cacheRead: acc.cacheRead + session.usage.cacheRead,
			cost: acc.cost + session.usage.cost.total,
			messages: acc.messages + session.messageCount,
		}),
		{ input: 0, output: 0, cacheRead: 0, cost: 0, messages: 0 },
	);

	const busiest = [...sessions].sort((a, b) => b.usage.total - a.usage.total).slice(0, 12);

	return (
		<div className="pt-8">
			<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">使用统计</h1>
			<p className="mt-2 pb-7 text-[13px] text-ink-muted">按会话记录的 token 与花费，全部来自本地会话日志。</p>

			<div className="mb-8 grid grid-cols-4 gap-3">
				<Stat label="会话" value={sessions.length.toLocaleString()} />
				<Stat label="消息" value={totals.messages.toLocaleString()} />
				<Stat label="输入 token" value={totals.input.toLocaleString()} sub={`缓存命中 ${totals.cacheRead.toLocaleString()}`} />
				<Stat label="输出 token" value={totals.output.toLocaleString()} sub={totals.cost > 0 ? `$${totals.cost.toFixed(4)}` : undefined} />
			</div>

			<SectionTitle>消耗最高的会话</SectionTitle>
			<Card>
				{busiest.length === 0 ? (
					<EmptyHint>还没有使用记录。</EmptyHint>
				) : (
					busiest.map((session) => (
						<div key={session.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
							<ScrollText text={session.title} className="min-w-0 flex-1 text-[13px] text-ink" />
							<span className="shrink-0 text-[12px] text-ink-faint">{session.projectName}</span>
							<span className="w-[130px] shrink-0 text-right font-mono text-[12px] text-ink-muted">
								{session.usage.input.toLocaleString()} / {session.usage.output.toLocaleString()}
							</span>
							<span className="w-[70px] shrink-0 text-right font-mono text-[12px] text-ink-muted">
								{session.usage.cost.total > 0 ? `$${session.usage.cost.total.toFixed(4)}` : "—"}
							</span>
						</div>
					))
				)}
			</Card>
		</div>
	);
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="rounded-[12px] border border-line bg-card/40 px-4 py-3.5">
			<div className="text-[12px] text-ink-muted">{label}</div>
			<div className="mt-1 text-[22px] leading-tight font-semibold tracking-tight text-ink">{value}</div>
			{sub && <div className="mt-0.5 text-[11.5px] text-ink-faint">{sub}</div>}
		</div>
	);
}
