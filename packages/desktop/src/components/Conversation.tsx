import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { BackToLatest } from "./BackToLatest.tsx";
import { Composer } from "./Composer.tsx";
import { ResumeRow } from "./ResumeRow.tsx";
import { RunningIndicator } from "./RunningIndicator.tsx";
import { TaskList } from "./TaskList.tsx";
import { Scroller } from "./Scroller.tsx";
import { isNudge, runs } from "./conversation/grouping.ts";
import { ToolRun as ToolRunGroup, WINDOW_STEP } from "./conversation/runs.tsx";
import { MessageRow, messageKey } from "./conversation/rows.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

/**
 * Nothing about the window's shape belongs to the transcript.
 *
 * The transcript takes no props: everything it draws comes from the store, and the store tells it
 * directly when that changes. But it is mounted inside the dock, and the dock is re-rendered by
 * every drag — a pane's boundary, a pane being carried, the sidebar's edge — so a fresh element
 * was handed down forty-five times a second and React rebuilt several hundred rows behind it, each
 * one re-parsing its markdown. Dragging the sidebar across a long session cost 470KB of re-parsed
 * prose per gesture. A memo boundary here is one comparison of two empty objects, and it is where
 * the layout stops being the transcript's business.
 */
export const Conversation = memo(function Conversation() {
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
    let frame = 0;
    const measure = () => {
      if (document.documentElement.hasAttribute("data-resizing")) {
        // Debounce / coalesce measurement during resizing drags so we don't trigger layout thrashing
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            setRoomToFloat(element.clientWidth >= 320 + 32 + 420);
          });
        }
        return;
      }
      setRoomToFloat(element.clientWidth >= 320 + 32 + 420);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const lastClientWidth = useRef(0);
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
  /**
   * The final answer has started arriving.
   *
   * Text in the last assistant message while it is still streaming — tool calls and reasoning do
   * not count, because neither is the thing being waited for. This is the moment the running
   * indicator stops being informative and starts being noise.
   */
  const answering = useMemo(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
    return last.content.some((block) => block.type === "text" && block.text.trim().length > 0);
  }, [messages]);

  const [away, setAway] = useState(false);
  /** Something arrived while scrolled up, which is the difference between "go down" and "new". */
  const [missed, setMissed] = useState(false);

  const updateScrollState = useCallback(
    (el: HTMLDivElement) => {
      // Every frame of `glideToBottom` fires this; letting it decide anything mid-flight is
      // what made the button flicker and the pin land early.
      if (gliding.current) return;
      const atBottom = el.scrollHeight - el.clientHeight <= 1 || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      pinnedToBottom.current = atBottom;
      setAway(!atBottom);
      if (atBottom) setMissed(false);

      if (activeSessionId) {
        const cache = useApp.getState().sessionCache;
        const currentEntry = cache[activeSessionId];
        if (currentEntry) {
          currentEntry.scrollTop = el.scrollTop;
          currentEntry.pinnedToBottom = atBottom;
        }
      }
    },
    [activeSessionId],
  );

  const handleResize = useCallback(
    (el: HTMLDivElement) => {
      if (gliding.current) return;
      const widthChanged = lastClientWidth.current !== 0 && lastClientWidth.current !== el.clientWidth;
      lastClientWidth.current = el.clientWidth;

      // When width changes (e.g. sidebar toggle or window resize), markdown reflows.
      // In that case, do not touch scrollTop to prevent text from jumping upward.
      if (widthChanged) {
        if (pinnedToBottom.current) {
          setAway(false);
          if (activeSessionId) {
            const cache = useApp.getState().sessionCache;
            const currentEntry = cache[activeSessionId];
            if (currentEntry) {
              currentEntry.scrollTop = el.scrollTop;
              currentEntry.pinnedToBottom = true;
            }
          }
          return;
        }
        updateScrollState(el);
        return;
      }

      // Vertical content height changed (e.g. indicator unfolded, card expanded).
      // If pinned to bottom, keep following the bottom so indicators never get masked by bottom fade.
      if (pinnedToBottom.current) {
        el.scrollTop = el.scrollHeight;
        updateScrollState(el);
        return;
      }

      updateScrollState(el);
    },
    [activeSessionId, updateScrollState],
  );

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
		if (!el) return;
		if (pinnedToBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
		// Synchronize scroll & pinned state in case message/tool changes altered content height
		updateScrollState(el);
		/*
		 * A cheap stand-in for "output arrived".
		 *
		 * Following the bottom used to depend on the whole `toolRuns` map, which meant subscribing
		 * to every streamed chunk here as well. A count of finished calls changes when a card
		 * appears or completes — the moments that actually change the page height.
		 */
		setMissed(false);
	}, [messages, toolRunCount, running, answering, updateScrollState]);

  /**
   * Ride down to the newest message, on a curve, without being interrupted on the way.
   *
   * `scrollTo({ behavior: "smooth" })` was two problems. It aims at a fixed offset, and a reply
   * still streaming grows the page underneath it — so it arrived somewhere that was no longer the
   * bottom. And `pinnedToBottom` was set on the click, which let the layout effect below snap
   * `scrollTop` to the end mid-flight: the jump the button exists to avoid, performed by the
   * button. Both are fixed by owning the animation: the target is re-read every frame, and being
   * pinned is the *result* of arriving rather than a decision taken up front.
   *
   * The curve is the same shape as `--ly-e-out`, which everything else in the app decelerates on.
   */
  const glide = useRef(0);
  const gliding = useRef(false);
  const glideToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    cancelAnimationFrame(glide.current);
    const from = el.scrollTop;
    const started = performance.now();
    const DURATION = 420;
    gliding.current = true;

    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / DURATION);
      const eased = 1 - (1 - progress) ** 3;
      const target = el.scrollHeight - el.clientHeight;
      el.scrollTop = from + (target - from) * eased;
      if (progress < 1) {
        glide.current = requestAnimationFrame(step);
        return;
      }
      gliding.current = false;
      pinnedToBottom.current = true;
      setAway(false);
      setMissed(false);
    };
    glide.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  /*
   * Sending puts you back at the bottom, wherever you had scrolled to.
   *
   * Reading back through a conversation and then asking something is ordinary, and the reply to
   * it arrives at the end — so staying where you were means watching a screen on which nothing
   * appears to happen. Your own message is the one thing you can be certain you want to see.
   */
  const pending = useApp((s) => s.pendingUserMessage);
  useLayoutEffect(() => {
    if (!pending) return;
    glideToBottom();
  }, [pending, glideToBottom]);

  /*
   * Arrived while away. Separate from the effect above because that one returns early when not
   * pinned — which is exactly the case this needs to notice.
   */
  useLayoutEffect(() => {
    if (!pinnedToBottom.current) setMissed(true);
  }, [messages, toolRunCount]);

	// Restore cached scroll position or default to bottom.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		const cached = activeSessionId ? useApp.getState().sessionCache[activeSessionId] : undefined;
		if (cached && typeof cached.scrollTop === "number") {
			pinnedToBottom.current = cached.pinnedToBottom ?? false;
			if (el) el.scrollTop = cached.scrollTop;
			setAway(!pinnedToBottom.current);
		} else {
			pinnedToBottom.current = true;
			if (el) el.scrollTop = el.scrollHeight;
			setAway(false);
		}
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

  const handleIndicatorTransition = useCallback(
    (e: React.TransitionEvent<HTMLDivElement>) => {
      // Only care about height transitions on the reveal container itself
      if (e.target !== e.currentTarget || e.propertyName !== "grid-template-rows") return;
      const el = scrollRef.current;
      if (el && pinnedToBottom.current) {
        el.scrollTop = el.scrollHeight;
        updateScrollState(el);
      }
    },
    [updateScrollState],
  );

  return (
    <div ref={column} className="flex min-h-0 flex-1 flex-col">
      {/*
       * The transcript and the button that scrolls it, in a box of their own.
       *
       * This used to be the same box as the composer, and `bottom` measured from the bottom of
       * *that* — so the button sat inside the field you type in rather than above the last
       * message. What it offers is about the transcript, so the transcript is what it is
       * positioned against.
       */}
      <div className="relative flex min-h-0 flex-1 flex-col">
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
        className="flex-1 ly-transcript-scroll"
        scrollRef={scrollRef}
        contentClassName={compact ? "px-4" : "px-8"}
        onScroll={updateScrollState}
        onResize={handleResize}
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
        {/*
         * `ly-transcript`: every direct child of this is one row, and rows off screen are not
         * drawn. See the rule in `styles.css` — it is what keeps the window responsive while a
         * pane is being resized, and it has to be applied here because this is the only element
         * that knows its children are rows.
         */}
        <div
          key={activeSessionId ?? "blank"}
          className={`ly-transcript ly-fade-in mx-auto w-full max-w-[var(--ly-content)] py-5 ${swapping ? "ly-no-enter" : ""}`}
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
            /*
             * Compaction leaves no mark in the transcript.
             *
             * There was a rule across the conversation here saying everything above it had been
             * summarised. True, and about the request rather than about anything being read — so it
             * spent a permanent line, and a visible seam through the middle of someone's work, on
             * an implementation detail. It is mentioned once on the running line while the turn is
             * still going (see `RunningIndicator`) and then it is gone, which is the weight it
             * deserves.
             */
            run.kind === "compaction" ? null : run.kind === "message" ? (
              <MessageRow
                key={messageKey(run.message, run.index)}
                message={run.message}
                index={run.index}
                upTo={run.upTo}
                /* A turn the runtime carried straight on from did not end where it stopped. */
                continued={isNudge(messages[run.index + 1])}
                /* Computed with the grouping, so its identity changes only when the transcript
                 * does — see `Run` in `grouping.ts` for what recomputing it here used to cost. */
                turnStats={run.turnStats}
              />
            ) : (
              /* Keyed on the first call, not the position: inserting anything above must not
               * make React tear this run down and build it again. */
              <ToolRunGroup
                key={`run-${run.calls[0]?.block.id ?? index}`}
                calls={run.calls}
                /*
                 * The last run of a turn still in progress keeps its highlight moving.
                 *
                 * Only the last: an earlier group is finished no matter what the turn is doing,
                 * and gliding all of them would say several things are happening at once.
                 */
                trailing={running && index === visibleRuns.length - 1}
              />
            ),
          )}

          {/*
           * Present for the whole turn — until the answer starts, at which point it has been
           * overtaken by what it was standing in for.
           *
           * It stays put through the parts of a turn: it used to appear only when the last message
           * had settled, so it came and went with every tool call, and its 46px came and went with
           * it, shifting the transcript up and down all through a turn.
           *
           * But once prose is streaming in above it, "Nearly there…" is describing something the
           * reader can already see the end of. Sitting under a finished answer saying almost-done
           * reads as the app having lost track of itself.
           *
           * Folded rather than removed, so the height goes continuously — which is the whole
           * reason it was made to stay put in the first place.
           */}
          <div
            className="ly-reveal"
            data-open={running && !answering}
            aria-hidden={!running || answering}
            onTransitionEnd={handleIndicatorTransition}
          >
            <div>
              <div>{running && <RunningIndicator />}</div>
            </div>
          </div>
          {/* Where the running indicator would have been, saying why it is not there. */}
          <ResumeRow />
        </div>
      </Scroller>

      {/*
       * Over the transcript's last few pixels, not in the flow.
       *
       * A button that took a row of its own would push the transcript up by its own height the
       * moment it appeared, and a control offering to move you should not itself move the thing
       * it is about.
       */}
      <BackToLatest
        show={away}
        unread={missed}
        onClick={glideToBottom}
      />
      </div>

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
});

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

