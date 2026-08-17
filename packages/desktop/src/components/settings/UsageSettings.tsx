import { useEffect, useMemo, useState } from "react";
import type { SessionMeta } from "@lyra/core";
import { useApp } from "../../store.ts";
import { Card, EmptyHint, SectionTitle } from "./controls.tsx";
import { type DayUsage, heatLevel, heatmapWeeks, monthLabels } from "./usage-heatmap.ts";

/**
 * A year.
 *
 * Half a year left most of the card empty — 26 columns of 14px is 364px in a pane nearly four times
 * that. A calendar that occupies a third of its own container reads as something that failed to
 * load. A year fills it, and a year is also the span over which a rhythm is actually visible.
 */
const WEEKS = 52;

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

  const grid = useMemo(() => heatmapWeeks(sessions, new Date(), WEEKS), [sessions]);
  const busiestDay = useMemo(
    () => Math.max(0, ...grid.flat().map((d) => d.input + d.output)),
    [grid],
  );
  const active = useMemo(() => grid.flat().filter((d) => d.sessions > 0).length, [grid]);

  return (
    <div className="pt-8">
      <h1 className="text-display leading-tight font-semibold tracking-tight text-ink">
        使用统计
      </h1>
      <p className="mt-2 pb-7 text-label text-ink-muted">
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

      <SectionTitle>使用节奏</SectionTitle>
      <Card>
        {active === 0 ? (
          <EmptyHint>还没有使用记录。</EmptyHint>
        ) : (
          <div className="px-4 py-4">
            <Heatmap grid={grid} busiest={busiestDay} />
          </div>
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
      <div className="truncate text-detail text-ink-muted">{label}</div>
      {/*
       * Smaller until there is room to be bigger.
       *
       * 43,913 set at 22px is wider than a tile that has half a narrow pane to live in, so it
       * used to hang out over the border. The number matters more than its size.
       */}
      <div className="mt-1 truncate text-heading leading-tight font-semibold tracking-tight text-ink @xs:text-heading">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-detail text-ink-faint">{sub}</div>}
    </div>
  );
}

/**
 * Half a year of days, one column per week.
 *
 * Scrolls rather than shrinks: squares below about 9pt stop being distinguishable from their gaps,
 * and a calendar you cannot read is worse than one you have to push sideways. It starts scrolled to
 * the right, because the useful end of a history of usage is the recent end.
 */
function Heatmap({ grid, busiest }: { grid: DayUsage[][]; busiest: number }) {
  const labels = monthLabels(grid);

  return (
    <div className="overflow-x-auto" dir="rtl">
      {/* Centred: a calendar that fills two thirds of its card and leaves the rest blank looks
          like something that failed to load, while the same calendar with equal margins looks
          placed. */}
      <div dir="ltr" className="mx-auto inline-block">
        <div className="relative mb-1 h-[14px]">
          {labels.map((label) => (
            <span
              key={label.column}
              className="absolute top-0 text-detail text-ink-faint"
              style={{ left: label.column * 14 }}
            >
              {label.text}
            </span>
          ))}
        </div>

        <div className="flex gap-[3px]">
          {grid.map((week) => (
            <div key={week[0]?.key} className="flex flex-col gap-[3px]">
              {week.map((day) => {
                const tokens = day.input + day.output;
                const future = day.date.getTime() > Date.now();
                return (
                  <span
                    key={day.key}
                    data-ly-tip={future ? undefined : tipFor(day, tokens)}
                    data-ly-tip-side="top"
                    /*
                     * No ring on today.
                     *
                     * It marked the one square that needs no marking — you know what day it is — and
                     * it did so with a hard outline in a grid whose whole language is fill. One cell
                     * drawn in a different idiom is the cell the eye goes to, which is exactly the
                     * wrong one.
                     */
                    className={`h-[11px] w-[11px] rounded-[3px] transition-colors duration-[var(--ly-t-quick)] ${
                      future ? "opacity-40" : ""
                    } ${SHADES[heatLevel(tokens, busiest)]}`}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* The key, in the corner where a key goes. */}
        <div className="mt-2.5 flex items-center justify-end gap-1 text-detail text-ink-faint">
          <span className="mr-1">少</span>
          {SHADES.map((shade, i) => (
            <span key={shade} className={`h-[11px] w-[11px] rounded-[3px] ${shade}`} aria-label={`第 ${i} 档`} />
          ))}
          <span className="ml-1">多</span>
        </div>
      </div>
    </div>
  );
}

/** Five steps of one hue, so the scale reads as one scale. */
const SHADES = [
  "bg-ink/[0.06]",
  "bg-info/25",
  "bg-info/45",
  "bg-info/70",
  "bg-info",
] as const;

/**
 * What a day says when you point at it.
 *
 * Only the parts that have a value: a day with no cost recorded says nothing about cost rather than
 * saying "$0.0000", and an empty day is just its date.
 */
function tipFor(day: DayUsage, tokens: number): string {
  const date = `${day.date.getMonth() + 1}月${day.date.getDate()}日`;
  if (day.sessions === 0) return `${date} · 没有使用`;
  const parts = [`${day.sessions} 个会话`, `${tokens.toLocaleString()} token`];
  if (day.cost > 0) parts.push(`$${day.cost.toFixed(4)}`);
  return `${date} · ${parts.join(" · ")}`;
}
