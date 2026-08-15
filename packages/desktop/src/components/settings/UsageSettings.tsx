import { useEffect, useState } from "react";
import { ScrollText } from "../ScrollText.tsx";
import type { SessionMeta } from "@lyra/core";
import { useApp } from "../../store.ts";
import { Card, EmptyHint, SectionTitle } from "./controls.tsx";

export function UsageSettings() {
  const sessionsFromStore = useApp((s) => s.sessions);
  const [sessions, setSessions] = useState<SessionMeta[]>(sessionsFromStore);

  useEffect(() => {
    void window.lyra.sessions.list().then(setSessions);
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

  const busiest = [...sessions]
    .sort((a, b) => b.usage.total - a.usage.total)
    .slice(0, 12);

  return (
    <div className="pt-8">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">
        使用统计
      </h1>
      <p className="mt-2 pb-7 text-[13px] text-ink-muted">
        按会话记录的 token 与花费，全部来自本地会话日志。
      </p>

      {/*
       * Four across only when four fit.
       *
       * A fixed four-column grid gave each tile 88px in a narrow window, which is not
       * enough for a label and a six-figure number — they stacked into two lines of
       * fragments. Two columns, then four, measured against this pane rather than the
       * window.
       */}
      <div className="@container mb-8">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <Stat label="会话" value={sessions.length.toLocaleString()} />
          <Stat label="消息" value={totals.messages.toLocaleString()} />
          <Stat
            label="输入 token"
            value={totals.input.toLocaleString()}
            sub={`缓存命中 ${totals.cacheRead.toLocaleString()}`}
          />
          <Stat
            label="输出 token"
            value={totals.output.toLocaleString()}
            sub={totals.cost > 0 ? `$${totals.cost.toFixed(4)}` : undefined}
          />
        </div>
      </div>

      <SectionTitle>消耗最高的会话</SectionTitle>
      <Card>
        {busiest.length === 0 ? (
          <EmptyHint>还没有使用记录。</EmptyHint>
        ) : (
          busiest.map((session) => (
            /*
             * One line when the columns fit, two when they do not.
             *
             * Two fixed-width number columns plus the project name took 270px whatever the pane
             * was, so in a narrow window the title — the only part that identifies the row —
             * was squeezed to two characters. Below the breakpoint the numbers move under the
             * title instead, where they have the full width to themselves.
             */
            <div
              key={session.id}
              className="@container border-b border-line-soft px-4 py-3 last:border-b-0"
            >
              <div className="flex flex-col gap-1 @lg:flex-row @lg:items-center @lg:gap-3">
                <ScrollText
                  text={session.title}
                  className="min-w-0 flex-1 text-[13px] text-ink"
                />
                <div className="flex min-w-0 items-center gap-3 @lg:contents">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint @lg:flex-none @lg:shrink-0">
                    {session.projectName}
                  </span>
                  <span className="shrink-0 text-right font-mono text-[12px] text-ink-muted @lg:w-[130px]">
                    {session.usage.input.toLocaleString()} /{" "}
                    {session.usage.output.toLocaleString()}
                  </span>
                  <span className="shrink-0 text-right font-mono text-[12px] text-ink-muted @lg:w-[70px]">
                    {session.usage.cost.total > 0
                      ? `$${session.usage.cost.total.toFixed(4)}`
                      : "—"}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="@container rounded-[12px] border border-line bg-card/40 px-4 py-3.5">
      <div className="truncate text-[12px] text-ink-muted">{label}</div>
      {/*
       * Smaller until there is room to be bigger.
       *
       * 43,913 set at 22px is wider than a tile that has half a narrow pane to live in, so it
       * used to hang out over the border. The number matters more than its size.
       */}
      <div className="mt-1 truncate text-[18px] leading-tight font-semibold tracking-tight text-ink @xs:text-[22px]">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-faint">{sub}</div>}
    </div>
  );
}
