/**
 * Turning a message list into rows the transcript can render.
 *
 * The transcript is not the message list. Consecutive tool calls become one card, a streaming reply
 * is kept out of that grouping until it settles, and a compaction marker interrupts the sequence.
 * All of that is decided here, on plain data, so the rendering has nothing left to decide.
 */

import { memo } from "react";
import type { AssistantContent, AssistantMessage, Message } from "@lyra/core";
import { PreviewCard, type PreviewInfo } from "../PreviewCard.tsx";
import { ToolCard } from "../ToolCard.tsx";
import { describeRun } from "../ToolGroup.tsx";
import { ToolGroup } from "../ToolGroup.tsx";
import { useApp, type ToolRun as ToolRunState } from "../../store.ts";

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

/**
 * A message that has something to show, or a run of tool calls with nothing between them.
 *
 * Assistant messages that are nothing but tool calls are plumbing — the model handing off and
 * coming back. Several in a row are one stretch of work, and reading them as one is closer to
 * what happened than reading them as four separate replies.
 */
export type Run =
  | { kind: "compaction" }
  | { kind: "message"; message: Message; index: number }
  | { kind: "tools"; calls: { block: Extract<AssistantContent, { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[] };

/** The runtime's "carry on" message, recognised by what it says as well as by its flag. */
export function isNudge(message: Message | undefined): boolean {
  if (message?.role !== "user") return false;
  return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
}

export function runs(messages: Message[], compactions: { at: number }[] = []): Run[] {
  const out: Run[] = [];
  // Sorted so the marks can be consumed in order as the transcript is walked.
  const marks = [...compactions].map((c) => c.at).sort((a, b) => a - b);
  let nextMark = 0;
  for (const [index, message] of messages.entries()) {
    while (nextMark < marks.length && marks[nextMark] === index) {
      out.push({ kind: "compaction" });
      nextMark++;
    }
    /*
     * Tool results are not entries in the transcript; they are the contents of a card.
     *
     * This is what kept the runs from ever forming. Every call is answered by a `toolResult`
     * message, and treating those as ordinary messages put one between every pair of calls — so
     * a run of seven arrived as seven runs of one, and nothing ever reached the threshold to
     * fold. They render nothing on their own, so passing over them changes only the grouping.
     */
    if (message.role === "toolResult") continue;
    /*
     * What breaks a run is the model saying something, not the model thinking.
     *
     * This asked for messages that were *only* tool calls, which almost none are: a call usually
     * arrives alongside the reasoning that produced it, and reasoning is folded away anyway. So
     * the runs never formed and the transcript stayed a column of cards. A message with actual
     * text is a different matter — that is the model addressing you, and a group should not
     * swallow it or straddle it.
     */
    /*
     * A message still streaming never joins the run before it.
     *
     * Its shape changes as it arrives — text first, then a call, or the reverse — so its grouping
     * would flip with it, and every run below would be rebuilt and re-measured on the way. That
     * is what made the transcript jump while the agent worked. It joins when it is finished and
     * its shape has settled; until then it stands alone and only its own height moves.
     */
    const settling = message.role === "assistant" && message.stopReason === "pending";
    const toolOnly =
      message.role === "assistant" &&
      !settling &&
      message.content.some((block) => block.type === "toolCall") &&
      !message.content.some((block) => block.type === "text" && block.text.trim());

    if (!toolOnly) {
      out.push({ kind: "message", message, index });
      continue;
    }
    const calls = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => ({ block, stopReason: message.stopReason }));
    const last = out[out.length - 1];
    if (last?.kind === "tools") last.calls.push(...calls);
    else out.push({ kind: "tools", calls });
  }
  // A compaction recorded after the last message still belongs at the end.
  while (nextMark < marks.length) {
    out.push({ kind: "compaction" });
    nextMark++;
  }
  return out;
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
const ToolRunGroup = function ToolRun({ calls }: { calls: { block: Extract<AssistantContent, { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[] }) {
  /*
   * Primitives, not the map.
   *
   * A selector returning an object builds a new one every time and so always looks changed; a
   * number and a string are compared by value, so this re-renders when what it shows changes and
   * not when some other card emits a line of output.
   */
  const liveCount = useApp(
    (s) => calls.filter(({ block, stopReason }) => isLive(s.toolRuns[block.id], stopReason)).length,
  );
  const runningLabel = useApp((s) => {
    const live = calls.filter(({ block, stopReason }) => isLive(s.toolRuns[block.id], stopReason));
    return live.length === 1 ? (s.toolRuns[live[0].block.id]?.summary ?? "") : "";
  });
  const summary = useApp((_s) =>
    describeRun(calls.map(({ block }) => ({ toolName: block.name, subject: subjectOf(block) }))),
  );
  // Totals across the run, so a fold does not hide how much changed.
  const added = useApp((s) => calls.reduce((n, { block }) => n + diffOf(s.toolRuns[block.id], "added"), 0));
  const removed = useApp((s) => calls.reduce((n, { block }) => n + diffOf(s.toolRuns[block.id], "removed"), 0));

  const cards = calls.map(({ block, stopReason }) => (
    <LiveToolCard key={block.id} block={block} stopReason={stopReason} />
  ));

  return (
    <ToolGroup
      summary={liveCount > 0 ? runningLabel || `执行 ${calls.length} 个操作` : summary}
      added={added}
      removed={removed}
      running={liveCount > 0}
    >
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
