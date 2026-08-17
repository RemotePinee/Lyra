import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { BackToLatest } from "./BackToLatest.tsx";
import { Composer } from "./Composer.tsx";
import { ResumeRow } from "./ResumeRow.tsx";
import { RunningIndicator } from "./RunningIndicator.tsx";
import { TaskList } from "./TaskList.tsx";
import { Scroller } from "./Scroller.tsx";
import {
	isNudge,
	runs,
	ToolRun as ToolRunGroup,
	WINDOW_STEP,
} from "./conversation/runs.tsx";
import { MessageRow, messageKey } from "./conversation/rows.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

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
  /**
   * Whether the newest message is off the bottom of the view.
   *
   * `pinnedToBottom` is a ref because following the bottom happens in a layout effect and must not
   * cost a render. This is the same fact in state, because a button has to be drawn from it. They
   * are set together and read in different places rather than one deriving the other.
   */
  const [away, setAway] = useState(false);
  /** Something arrived while scrolled up, which is the difference between "go down" and "new". */
  const [missed, setMissed] = useState(false);

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
    setMissed(false);
  }, [messages, toolRunCount]);

  /*
   * Arrived while away. Separate from the effect above because that one returns early when not
   * pinned — which is exactly the case this needs to notice.
   */
  useLayoutEffect(() => {
    if (!pinnedToBottom.current) setMissed(true);
  }, [messages, toolRunCount]);

  // A new session starts at the bottom, not wherever the previous one was left.
  useLayoutEffect(() => {
    pinnedToBottom.current = true;
    setAway(false);
    setMissed(false);
    setSwapping(true);
  }, [activeSessionId]);

  useEffect(() => {
    if (!swapping) return;
    const frame = requestAnimationFrame(() => setSwapping(false));
    return () => cancelAnimationFrame(frame);
  }, [swapping]);

  /*
   * Recomputed when the transcript changes, not on every render.
   *
   * A streaming reply re-renders this component on every token; without the memo each one walked
   * the whole message list again and handed every row a freshly built object, so React rebuilt
   * three hundred rows to show one more word arriving.
   */
  const allRuns = useMemo(() => runs(messages, compactions), [messages, compactions]);
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
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          pinnedToBottom.current = atBottom;
          setAway(!atBottom);
          if (atBottom) setMissed(false);
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
          className={`ly-fade-in mx-auto w-full max-w-[var(--ly-content)] py-5 ${swapping ? "ly-no-enter" : ""}`}
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
              className="mb-4 flex h-7 w-full items-center justify-center rounded-md text-detail text-ink-faint transition-colors hover:bg-card-hover hover:text-ink-muted"
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
              <div key={`compaction-${index}`} className="mb-2.5 flex items-center gap-2 text-caption text-ink-faint">
                <span className="h-px flex-1 bg-line-soft" />
                <span>以上内容已压缩为摘要</span>
                <span className="h-px flex-1 bg-line-soft" />
              </div>
            ) : run.kind === "message" ? (
              <MessageRow
                key={messageKey(run.message, run.index)}
                message={run.message}
                index={run.index}
                /* A turn the runtime carried straight on from did not end where it stopped. */
                continued={isNudge(messages[run.index + 1])}
              />
            ) : (
              /* Keyed on the first call, not the position: inserting anything above must not
               * make React tear this run down and build it again. */
              <ToolRunGroup key={`run-${run.calls[0]?.block.id ?? index}`} calls={run.calls} />
            ),
          )}

          {/*
           * Present for the whole turn, not between the parts of one.
           *
           * It used to appear only when the last message had settled — so it came and went with
           * every tool call, and its 46px came and went with it, shifting the transcript up and
           * down all through a turn. A turn either is running or is not; the indicator should
           * say which, and stay put while it does.
           */}
          {running && <RunningIndicator />}
          {/* Where the running indicator would have been, saying why it is not there. */}
          <ResumeRow />
        </div>
      </Scroller>

      {/*
       * Above the composer, over the transcript's last few pixels.
       *
       * Inside the same relative box as the Scroller rather than in the flow: a button that took a
       * row of its own would push the transcript up by its own height the moment it appeared, and
       * a control offering to move you should not itself move the thing it is about.
       */}
      <BackToLatest
        show={away}
        unread={missed}
        onClick={() => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          // Set now rather than waiting for the scroll handler: a smooth scroll fires `scroll`
          // all the way down, and the button would sit there flickering until it arrived.
          pinnedToBottom.current = true;
          setAway(false);
          setMissed(false);
        }}
      />

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
            <div className="mx-auto w-full max-w-[var(--ly-content)]">
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
        className={`ly-defer-in min-h-0 flex-1 overflow-hidden ${compact ? "px-4" : "px-8"}`}
        aria-busy
      >
        <div className="mx-auto w-full max-w-[var(--ly-content)] py-5">
          <div className="ly-pulse flex flex-col gap-3">
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

