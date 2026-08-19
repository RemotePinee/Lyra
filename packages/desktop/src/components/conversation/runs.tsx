/**
 * Drawing the rows that `grouping.ts` decided on.
 *
 * The grouping itself is plain data and lives next door; what is left here is a card that
 * subscribes to its own tool run and a group that reads the totals across one.
 */

import { memo } from "react";
import type { AssistantContent, AssistantMessage } from "@lyra/core";
import { PreviewCard, type PreviewInfo } from "../PreviewCard.tsx";
import { ToolCard } from "../ToolCard.tsx";
import { describeRun } from "../ToolGroup.tsx";
import { ToolGroup } from "../ToolGroup.tsx";
import { useApp, type ToolRun as ToolRunState } from "../../store.ts";
import type { Call } from "./grouping.ts";

/**
 * How much of a long transcript is mounted at once, and how much each "show more" adds.
 *
 * Large enough that an ordinary conversation is never truncated, small enough that a session
 * with thousands of messages still scrolls like an empty one.
 */
export const WINDOW_STEP = 120;

export type Segment =
  | { kind: "block"; block: AssistantContent; index: number }
  | { kind: "tools"; blocks: Extract<AssistantContent, { type: "toolCall" }>[] };

/**
 * Split a reply into runs of tool calls and everything else.
 *
 * Text between two calls is a break in the run — the model stopping to explain is exactly the
 * boundary a reader uses, so folding across it would join two things it deliberately separated.
 */
export function segments(content: AssistantContent[]): Segment[] {
  const out: Segment[] = [];
  for (const [index, block] of content.entries()) {
    if (block.type === "toolCall") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.blocks.push(block);
      else out.push({ kind: "tools", blocks: [block] });
    } else {
      out.push({ kind: "block", block, index });
    }
  }
  return out;
}

/**
 * One card, subscribed to its own record and nothing else.
 *
 * Tool output streams: a long install or a test run emits `tool_update` many times a second, and
 * each one replaces the whole `toolRuns` map. Anything reading that map re-renders — so with the
 * map read at the top of the transcript, every chunk of output repainted every message in the
 * conversation. In a session with hundreds of messages that is what made scrolling stutter.
 *
 * Reading one entry means Object.is sees no change for the other cards and they stay put.
 */
export function LiveToolCard({
  block,
  stopReason,
}: {
  block: Extract<AssistantContent, { type: "toolCall" }>;
  stopReason: AssistantMessage["stopReason"];
}) {
  const run = useApp((s) => s.toolRuns[block.id]);
  /*
   * A preview replaces its own tool card.
   *
   * The card would say "预览已生成" above the thing itself, which is a caption nobody needs —
   * the page is right there, and it is the result.
   */
  const preview = (run?.result?.details as { preview?: PreviewInfo } | undefined)?.preview;
  if (preview) return <PreviewCard preview={preview} />;
  return (
    <ToolCard
      toolName={block.name}
      args={block.arguments}
      summary={run?.summary ?? block.name}
      /*
       * No record does not mean "still going".
       *
       * A card with no run used to default to running, so any call whose record was lost — an id
       * the provider never supplied, a session reloaded mid-command — sat there counting up
       * forever. If the turn that produced it has finished, the call is over too, whatever
       * became of its record.
       */
      status={run?.status ?? (stopReason === "pending" ? "running" : "error")}
      result={run?.result}
    />
  );
}

/** A call with no record is still going only while the message that made it is unfinished. */
function isLive(run: ToolRunState | undefined, stopReason: AssistantMessage["stopReason"]): boolean {
  return run?.status === "running" || (!run && stopReason === "pending");
}

/**
 * One run of tool work: always a line, never a row of cards.
 *
 * The threshold that used to decide between the two forms is gone. It was the source of the
 * unevenness — the same kind of work looked like two different things depending on how many
 * calls happened to fall together, and the boundary moved as the model chose to batch or not.
 */
const ToolRunGroup = function ToolRun({ calls, trailing }: { calls: Call[]; trailing?: boolean }) {
  /*
   * Primitives, not the map.
   *
   * A selector returning an object builds a new one every time and so always looks changed; a
   * number is compared by value, so this re-renders when what it shows changes and not when some
   * other card emits a line of output.
   */
  /*
   * `trailing` is the last run of a turn that has not finished.
   *
   * The glide used to depend on `liveCount` alone — whether a call in this group was executing
   * right now — and that is not the same question. Between two tool calls the model is thinking:
   * every call has returned, the count is zero, and the run is still very much going, so the line
   * stopped moving several times a turn while the spinner below it kept spinning. The run is what
   * is running, not the individual call, and this group keeps taking on the calls of the replies
   * that follow it.
   */
  const liveCount = useApp(
    (s) => calls.filter(({ block, stopReason }) => isLive(s.toolRuns[block.id], stopReason)).length,
  );
  /*
   * One sentence, growing — never a different sentence while it works.
   *
   * A running group used to say what the live call was doing, or "执行 N 个操作" when several
   * were going at once, and go back to describing itself when they finished. Now that a run
   * keeps taking on the calls of the replies that follow it, that line is the *same* line all
   * turn: it would read "读取文件 3 个", then "执行 npm install", then "执行 6 个操作", then
   * "读取文件 3 个、执行命令 2 个" — one row rewriting itself in two different languages while
   * you try to read it. Built from the calls alone, it only ever gains a clause. That the run is
   * still going is said by the highlight gliding along it, which is the one thing a count of
   * events nobody witnessed was standing in for.
   */
  const summary = describeRun(calls.map(({ block }) => ({ toolName: block.name, subject: subjectOf(block) })));
  // Totals across the run, so a fold does not hide how much changed.
  const added = useApp((s) => calls.reduce((n, { block }) => n + diffOf(s.toolRuns[block.id], "added"), 0));
  const removed = useApp((s) => calls.reduce((n, { block }) => n + diffOf(s.toolRuns[block.id], "removed"), 0));

  const cards = calls.map(({ block, stopReason }) => (
    <LiveToolCard key={block.id} block={block} stopReason={stopReason} />
  ));

  return (
    <ToolGroup summary={summary} added={added} removed={removed} running={liveCount > 0 || trailing}>
      {cards}
    </ToolGroup>
  );
}
/**
 * A settled group of tool calls never changes again.
 *
 * Compared by what the group is made of rather than by the array it arrives in: the array is
 * rebuilt on every render of the transcript, but the calls in it are the same objects with the
 * same ids, and a group whose calls are unchanged has nothing new to draw. The live group — the
 * one still running — fails this comparison on every event, which is exactly when it should.
 */
export const ToolRun = memo(ToolRunGroup, (before, after) => {
	if (before.calls.length !== after.calls.length) return false;
	return before.calls.every(
		(call, i) => call.block.id === after.calls[i].block.id && call.stopReason === after.calls[i].stopReason,
	);
});


/** The file a call is about, when it is about one — the part worth naming in a summary. */
function subjectOf(block: Extract<AssistantContent, { type: "toolCall" }>): string | undefined {
  const path = (block.arguments as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path.split("/").pop() : undefined;
}

function diffOf(run: ToolRunState | undefined, key: "added" | "removed"): number {
  const value = (run?.result?.details as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" ? value : 0;
}
