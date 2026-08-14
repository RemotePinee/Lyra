import type { AssistantContent, AssistantMessage, Message } from "@deepwise/core";
import { RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { Composer } from "./Composer.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { PreviewCard, type PreviewInfo } from "./PreviewCard.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { ResumeRow } from "./ResumeRow.tsx";
import { RunningIndicator } from "./RunningIndicator.tsx";
import { TaskList } from "./TaskList.tsx";
import { Scroller } from "./Scroller.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { ToolGroup, describeRun } from "./ToolGroup.tsx";
import { Text } from "./Text.tsx";
import { UserMessage } from "./UserMessage.tsx";
import { useLayout } from "../layout.tsx";
import { useApp, type ToolRun } from "../store.ts";

export function Conversation() {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const compactions = useApp((s) => s.compactions);
  const toolRunCount = useApp((s) => Object.keys(s.toolRuns).length);
  const activeSessionId = useApp((s) => s.activeSessionId);
  /** How many messages are mounted. Grows when asked, resets with the conversation. */
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  useEffect(() => setWindowSize(WINDOW_STEP), [activeSessionId]);
  const { compact } = useLayout();
  /*
   * The floating card needs its own width plus a readable column left over beside it.
   * 320 for the card, 32 for the gap it keeps from the edge, and 420 of text — below that the
   * reply is a ribbon and the card should go and sit above the composer instead.
   */
  const column = useRef<HTMLDivElement>(null);
  const [roomToFloat, setRoomToFloat] = useState(false);
  useEffect(() => {
    const element = column.current;
    if (!element) return;
    const measure = () => setRoomToFloat(element.clientWidth >= 320 + 32 + 420);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  /**
   * True for the first frame after a session change.
   *
   * Swapping the transcript remounts every row, and each row's entrance animation would fire
   * at once — fifty messages sliding up together, which is what "the content jumps around"
   * turned out to be. They are suppressed for that one frame; messages arriving afterwards
   * animate normally.
   */
  const [swapping, setSwapping] = useState(false);

  /*
   * Before paint, not after.
   *
   * A remounted list starts at scrollTop 0, so setting the position in a `useEffect` means
   * the browser paints the top of the transcript once and the bottom on the next frame. That
   * flash is indistinguishable from a jump. `scrollTop = scrollHeight` forces a synchronous
   * layout either way, so doing it before paint costs nothing extra.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottom.current) return;
    el.scrollTop = el.scrollHeight;
    /*
     * A cheap stand-in for "output arrived".
     *
     * Following the bottom used to depend on the whole `toolRuns` map, which meant subscribing
     * to every streamed chunk here as well. A count of finished calls changes when a card
     * appears or completes — the moments that actually change the page height.
     */
  }, [messages, toolRunCount]);

  // A new session starts at the bottom, not wherever the previous one was left.
  useLayoutEffect(() => {
    pinnedToBottom.current = true;
    setSwapping(true);
  }, [activeSessionId]);

  useEffect(() => {
    if (!swapping) return;
    const frame = requestAnimationFrame(() => setSwapping(false));
    return () => cancelAnimationFrame(frame);
  }, [swapping]);

  const allRuns = runs(messages, compactions);
  const hidden = Math.max(0, allRuns.length - windowSize);
  const visibleRuns = hidden > 0 ? allRuns.slice(hidden) : allRuns;

  return (
    <div ref={column} className="relative flex min-h-0 flex-1 flex-col">
      {/*
       * Over the transcript when there is room beside it, in the column when there is not.
       *
       * The plan is a companion to the conversation rather than part of it: it is one thing that
       * keeps changing, not another entry in a log, so it holds a fixed corner instead of
       * scrolling away with the messages that happened to be on screen when it was written. Below
       * the breakpoint there is no corner to spare — the transcript needs its full width — so it
       * moves to the one place that is always visible, just above where you type.
       */}
      {/*
       * Floating only when it can float clear of the words.
       *
       * The window being wide is not the same as this column being wide: open the side panel and
       * the transcript can be 600px inside a 1400px window, at which point a 320px card in the
       * corner is sitting on top of the reply rather than beside it. Measured here, against the
       * column it would cover.
       */}
      {roomToFloat && (
        <div className="pointer-events-none absolute top-3 right-4 z-20 w-[320px]">
          <TaskList placement="floating" />
        </div>
      )}

      <Scroller
        className="flex-1"
        scrollRef={scrollRef}
        contentClassName={compact ? "px-4" : "px-8"}
        onScroll={(el) => {
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {/*
         * Keyed on the session so switching plays a short fade rather than swapping one
         * wall of text for another between frames — the transition is what tells you the
         * content changed at all when two transcripts look alike.
         *
         * Opacity only. The fade-up used here before translated the whole transcript by
         * 4px, and because that transform counts toward scrollHeight the browser dragged
         * the scroll position along with it as the animation settled.
         */}
        <div
          key={activeSessionId ?? "blank"}
          className={`dw-fade-in mx-auto w-full max-w-[var(--dw-content)] py-5 ${swapping ? "dw-no-enter" : ""}`}
        >
          {/*
           * Runs of tool calls are gathered across messages, not just inside one.
           *
           * A model that calls a tool, reads the result and calls the next one produces a fresh
           * assistant message every time. Grouping within a message therefore caught parallel
           * batches and missed sequential ones — which is the common case, and the one that
           * fills the transcript with a column of near-identical cards. A message carrying text
           * ends the run, because that is the model saying something worth reading.
           */}
          {/*
           * Only the tail is mounted until you ask for the rest.
           *
           * A day-long session runs to thousands of messages, each with its own cards and
           * expanders. Mounting all of them costs memory that never comes back and makes every
           * repaint walk the whole tree, which is what turns scrolling to treacle. The recent
           * end is what anyone is reading; the rest is one click away and stays unmounted until
           * then.
           */}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setWindowSize((n) => n + WINDOW_STEP)}
              className="mb-4 flex h-7 w-full items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:bg-card-hover hover:text-ink-muted"
            >
              显示更早的 {Math.min(hidden, WINDOW_STEP)} 条（共 {hidden} 条）
            </button>
          )}

          {visibleRuns.map((run, index) =>
            run.kind === "compaction" ? (
              /*
               * Where it happened, not at the end.
               *
               * Everything above this line is a summary as far as the model is concerned, and
               * everything below is verbatim — which is only useful if the line is at the
               * boundary. Pinned to the bottom it said the opposite of what it meant: that the
               * work still arriving had already been summarised away.
               */
              <div key={`compaction-${index}`} className="mb-6 flex items-center gap-2 text-[11px] text-ink-faint">
                <span className="h-px flex-1 bg-line-soft" />
                <span>以上内容已压缩为摘要</span>
                <span className="h-px flex-1 bg-line-soft" />
              </div>
            ) : run.kind === "message" ? (
              <MessageRow
                key={messageKey(run.message, run.index)}
                message={run.message}
                index={run.index}
              />
            ) : (
              /* Keyed on the first call, not the position: inserting anything above must not
               * make React tear this run down and build it again. */
              <ToolRun key={`run-${run.calls[0]?.block.id ?? index}`} calls={run.calls} />
            ),
          )}

          {running && lastIsSettledOrEmpty(messages) && <RunningIndicator />}
          {/* Where the running indicator would have been, saying why it is not there. */}
          <ResumeRow />
        </div>
      </Scroller>

      {/*
       * Approvals sit directly above the composer.
       *
       * They used to be pinned to the bottom of the whole pane, which put them over the field
       * you type in — the one control you might want while deciding, and the place your eye is
       * already resting. Anchored to the composer instead, they push nothing around and cover
       * nothing: the decision sits between the transcript that prompted it and the box you
       * would answer in.
       */}
      <div className="relative shrink-0">
        <ApprovalOverlay />
        {!roomToFloat && (
          <div className={`${compact ? "px-4" : "px-8"} pb-1.5`}>
            <div className="mx-auto w-full max-w-[var(--dw-content)]">
              <TaskList placement="inline" />
            </div>
          </div>
        )}
        <Composer />
      </div>
    </div>
  );
}

/**
 * Stand-in for a transcript that is still being read off disk.
 *
 * Opening a stored session replays its whole log and starts its MCP servers. The selection in
 * the sidebar lands immediately; without something here the main column would show the empty
 * state in the meantime, which reads as "this session has no messages".
 */
export function ConversationSkeleton() {
  const { compact } = useLayout();
  // Uneven widths so it reads as prose rather than as a loading bar.
  const rows = [72, 94, 61, 88, 47];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`dw-defer-in min-h-0 flex-1 overflow-hidden ${compact ? "px-4" : "px-8"}`}
        aria-busy
      >
        <div className="mx-auto w-full max-w-[var(--dw-content)] py-5">
          <div className="dw-pulse flex flex-col gap-3">
            <div className="ml-auto h-[38px] w-[45%] rounded-[16px] rounded-br-[6px] bg-card" />
            {rows.map((width, index) => (
              <div
                key={index}
                className="h-[13px] rounded bg-card"
                style={{ width: `${width}%` }}
              />
            ))}
            <div className="mt-2 h-[38px] w-full rounded-[11px] bg-card" />
          </div>
        </div>
      </div>

      <Composer />
    </div>
  );
}

/**
 * Whether this message is where the reply stopped, rather than a pause inside it.
 *
 * `pending` is still arriving; `toolUse` is a handover to a tool with more to come after it.
 * Everything else — a plain stop, a length cap, an error, an abort — is an ending.
 */
function settled(stopReason: AssistantMessage["stopReason"]): boolean {
  return stopReason !== "pending" && stopReason !== "toolUse";
}

/** True while we are waiting on the model rather than rendering its live output. */
function lastIsSettledOrEmpty(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return true;
  return !last.content.some(
    (c) => (c.type === "text" && c.text) || c.type === "toolCall",
  );
}

function messageKey(message: Message, index: number): string {
  if (message.role === "toolResult") return `tr-${message.toolCallId}`;
  return `${message.role}-${message.timestamp}-${index}`;
}

function MessageRow({ message, index }: { message: Message; index: number }) {
  if (message.role === "user") {
    /*
     * The runtime talking to the model, not the user talking.
     *
     * Recognised by what it says, not only by its flag. The flag was added later, so every nudge
     * already written to a log lacks it — and those are exactly the ones sitting in people's
     * transcripts wearing their own bubble, timestamp and edit button, looking like something
     * they typed and never did. Reading the text catches both.
     *
     * Most runtime messages say nothing a reader needs and stay hidden; a nudge is why another
     * turn started, so it gets a line of its own — a note about the conversation rather than a
     * message in it.
     */
    const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (text.startsWith("（自动继续）")) {
      return (
        <div className="mb-6 flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="h-px w-6 bg-line-soft" />
          <span>自动继续 · 清单尚未完成</span>
          <span className="h-px flex-1 bg-line-soft" />
        </div>
      );
    }
    if (message.synthetic) return null;
    return <UserMessage message={message} index={index} />;
  }

  // Tool results are rendered inside their tool card, not as standalone rows.
  if (message.role === "toolResult") return null;

  return <AssistantRow message={message} index={index} />;
}

/**
 * How much of a long transcript is mounted at once, and how much each "show more" adds.
 *
 * Large enough that an ordinary conversation is never truncated, small enough that a session
 * with thousands of messages still scrolls like an empty one.
 */
const WINDOW_STEP = 120;

type Segment =
  | { kind: "block"; block: AssistantContent; index: number }
  | { kind: "tools"; blocks: Extract<AssistantContent, { type: "toolCall" }>[] };

/**
 * Split a reply into runs of tool calls and everything else.
 *
 * Text between two calls is a break in the run — the model stopping to explain is exactly the
 * boundary a reader uses, so folding across it would join two things it deliberately separated.
 */
function segments(content: AssistantContent[]): Segment[] {
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
function LiveToolCard({
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
type Run =
  | { kind: "compaction" }
  | { kind: "message"; message: Message; index: number }
  | { kind: "tools"; calls: { block: Extract<AssistantContent, { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[] };

function runs(messages: Message[], compactions: { at: number }[] = []): Run[] {
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
function isLive(run: ToolRun | undefined, stopReason: AssistantMessage["stopReason"]): boolean {
  return run?.status === "running" || (!run && stopReason === "pending");
}

/**
 * One run of tool work: always a line, never a row of cards.
 *
 * The threshold that used to decide between the two forms is gone. It was the source of the
 * unevenness — the same kind of work looked like two different things depending on how many
 * calls happened to fall together, and the boundary moved as the model chose to batch or not.
 */
function ToolRun({ calls }: { calls: { block: Extract<AssistantContent, { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[] }) {
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
  const summary = useApp((s) =>
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

/** The file a call is about, when it is about one — the part worth naming in a summary. */
function subjectOf(block: Extract<AssistantContent, { type: "toolCall" }>): string | undefined {
  const path = (block.arguments as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path.split("/").pop() : undefined;
}

function diffOf(run: ToolRun | undefined, key: "added" | "removed"): number {
  const value = (run?.result?.details as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" ? value : 0;
}

function AssistantRow({
  message,
  index,
}: {
  message: AssistantMessage;
  index: number;
}) {
  const running = useApp((s) => s.running);
  const retryFrom = useApp((s) => s.retryFrom);

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n\n");

  // `group/msg` is what reveals the row below, and it names the whole reply as the target.
  return (
    <div className="group/msg dw-enter mb-6">
      {/*
       * Grouped before rendering, not after.
       *
       * A run of finished tool calls collapses into one line; anything else — text, thinking, a
       * preview, or a call still going — stays exactly where it is. Whether a card can be folded
       * away is a fact about the call, so it has to be decided here rather than by looking at
       * rendered output that no longer knows what it came from.
       */}
      {segments(message.content).map((segment, position) => {
        if (segment.kind === "block") {
          const { block, index } = segment;
          if (block.type === "thinking") {
            // Open while the turn is still producing it; folded away once it has finished.
            return (
              <ThinkingBlock
                key={index}
                text={block.thinking}
                redacted={block.redacted === true}
                live={message.stopReason === "pending"}
              />
            );
          }
          if (block.type === "text") {
            return block.text ? (
              <div key={index} className="mb-2">
                <Markdown text={block.text} />
              </div>
            ) : null;
          }
          return <LiveToolCard key={block.id} block={block} stopReason={message.stopReason} />;
        }

        const calls = segment.blocks.map((block) => ({ block, stopReason: message.stopReason }));
        return <ToolRun key={`group-${position}`} calls={calls} />;
      })}

      {message.stopReason === "error" && message.errorMessage && (
        /*
         * Stated, not staged.
         *
         * The first version of this put a bordered button under the message, which made a
         * dropped socket look like the most important thing on the screen. A failure is worth
         * one line — what went wrong, and the word that undoes it — set at the same weight as
         * the timestamp under every other reply.
         */
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Text
            size="caption"
            tone="danger"
            className="break-words whitespace-pre-wrap"
          >
            {message.errorMessage}
          </Text>
          <button
            type="button"
            disabled={running}
            onClick={() => void retryFrom(index)}
            className="flex items-center gap-1 rounded text-[11px] text-ink-faint transition-colors duration-150 hover:text-ink disabled:opacity-40"
          >
            <RotateCcw size={10.5} strokeWidth={1.9} />
            重试
          </button>
        </div>
      )}

      {/*
       * Only where the reply actually ends.
       *
       * One answer is often several assistant messages: the model says what it is about to do,
       * calls a tool, reads the result, says the next thing. Those middle messages end with
       * `toolUse` — they are the sentence before the work, not the end of the answer — and each
       * one was getting its own timestamp and copy button, so a single reply came back stamped
       * four times. The row belongs to the message that finished the turn.
       */}
      {settled(message.stopReason) && text.trim() && (
        <MessageActions timestamp={message.timestamp} text={text} />
      )}
    </div>
  );
}
