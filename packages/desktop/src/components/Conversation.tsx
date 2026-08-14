import type { AssistantMessage, Message } from "@deepwise/core";
import { RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { Composer } from "./Composer.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { PreviewCard, type PreviewInfo } from "./PreviewCard.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { RunningIndicator } from "./RunningIndicator.tsx";
import { TaskList } from "./TaskList.tsx";
import { Scroller } from "./Scroller.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { Text } from "./Text.tsx";
import { UserMessage } from "./UserMessage.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

export function Conversation() {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const toolRuns = useApp((s) => s.toolRuns);
  const activeSessionId = useApp((s) => s.activeSessionId);
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
  }, [messages, toolRuns]);

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
          {messages.map((message, index) => (
            <MessageRow
              key={messageKey(message, index)}
              message={message}
              index={index}
            />
          ))}

          {running && lastIsSettledOrEmpty(messages) && <RunningIndicator />}
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
    // Synthetic messages are the runtime talking to the model, not the user talking.
    if (message.synthetic) return null;
    return <UserMessage message={message} index={index} />;
  }

  // Tool results are rendered inside their tool card, not as standalone rows.
  if (message.role === "toolResult") return null;

  return <AssistantRow message={message} index={index} />;
}

function AssistantRow({
  message,
  index,
}: {
  message: AssistantMessage;
  index: number;
}) {
  const toolRuns = useApp((s) => s.toolRuns);
  const running = useApp((s) => s.running);
  const retryFrom = useApp((s) => s.retryFrom);

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n\n");

  // `group/msg` is what reveals the row below, and it names the whole reply as the target.
  return (
    <div className="group/msg dw-enter mb-6">
      {message.content.map((block, index) => {
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
        const run = toolRuns[block.id];
        /*
         * A preview replaces its own tool card.
         *
         * The card would say "预览已生成" above the thing itself, which is a caption nobody
         * needs — the page is right there, and it is the result.
         */
        const preview = (run?.result?.details as { preview?: PreviewInfo } | undefined)?.preview;
        if (preview) return <PreviewCard key={block.id} preview={preview} />;
        return (
          <ToolCard
            key={block.id}
            toolName={block.name}
            args={block.arguments}
            summary={run?.summary ?? block.name}
            /*
             * No record does not mean "still going".
             *
             * A card with no run used to default to running, so any call whose record was lost
             * — an id the provider never supplied, a session reloaded mid-command — sat there
             * counting up forever. If the turn that produced it has finished, the call is over
             * too, whatever became of its record.
             */
            status={
              run?.status ??
              (message.stopReason === "pending" ? "running" : "error")
            }
            result={run?.result}
          />
        );
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

      {/* Intermediate tool-only turns have nothing to copy, so they get no row. */}
      {message.stopReason !== "pending" && text.trim() && (
        <MessageActions timestamp={message.timestamp} text={text} />
      )}
    </div>
  );
}
