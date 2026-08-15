import { useEffect, useRef } from "react";

import { OverlayScrollbar } from "./OverlayScrollbar.tsx";

/**
 * The surface you type into, wherever you are typing.
 *
 * One component rather than two sets of matching class strings. The main composer and the side
 * chat's had drifted — different radius, different padding, different button heights, so the
 * two sat at different heights beside each other and read as parts of different applications.
 * Anything that is the same about them is now the same by construction, and what differs is
 * only what genuinely differs: which controls sit along the bottom.
 *
 * `left` and `right` are those controls. Left is context — what this will run against; right is
 * action — what happens when you commit.
 */
export function ComposerShell({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  autoFocus,
  /** Rendered above the field, for image thumbnails. */
  attachments,
  left,
  right,
  onFiles,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  attachments?: React.ReactNode;
  left?: React.ReactNode;
  right?: React.ReactNode;
  /** Supplied only where attachments are accepted; enables paste and drop. */
  onFiles?: (files: FileList | null) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);

  /*
   * Grow with the text, but never past a third of the window.
   *
   * Measured against the window rather than a fixed ceiling because the same component now
   * runs inside a 368px panel and across a full-width column; a 300px field in a short window
   * would leave no transcript above it in either.
   */
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, Math.max(72, Math.min(300, window.innerHeight * 0.34)))}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value]);

  return (
    <div
      /*
       * A container, so the controls along the bottom can drop labels when *this* runs out
       * of room rather than when the window does. The two are not the same question: at
       * 1100px wide with a sidebar and a panel open, this field is 350px.
       */
      className="dw-composer @container rounded-[18px] border border-line-soft bg-input transition-[border-color,box-shadow] duration-200"
      onDragOver={onFiles ? (e) => e.preventDefault() : undefined}
      onDrop={
        onFiles
          ? (e) => {
              e.preventDefault();
              onFiles(e.dataTransfer.files);
            }
          : undefined
      }
    >
      {attachments}

      {/*
       * The field scrolls once it hits its ceiling, so it needs the app's thumb like every
       * other scroller. Native bars are hidden globally, which left a long draft scrolling
       * with nothing to say so — and no way to see how much of it was above the fold.
       */}
      <div className="dw-scroll-host relative">
        <textarea
          ref={field}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onPaste={
            onFiles
              ? (e) => {
                  if (e.clipboardData.files.length > 0)
                    onFiles(e.clipboardData.files);
                }
              : undefined
          }
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="block max-h-[min(300px,34vh)] w-full resize-none overflow-y-auto bg-transparent px-4 pt-3.5 pb-2.5 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-faint"
        />
        <OverlayScrollbar viewport={field} orientation="vertical" />
      </div>

      {/*
       * Both sides shrink. `right` used to be `shrink-0`, which is why a long model name
       * beside a narrow column pushed the row wider than the field and every control ended
       * up drawn on top of the next.
       */}
      <div className="flex items-center justify-between gap-1 px-3 pt-0 pb-2.5">
        <div className="flex min-w-0 shrink items-center gap-1">{left}</div>
        <div className="flex min-w-0 shrink items-center gap-1">{right}</div>
      </div>
    </div>
  );
}

/** The send / stop button, so both composers commit with the same target. */
export function ComposerSend({
  running,
  disabled,
  onSend,
  onStop,
}: {
  running: boolean;
  disabled?: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  if (running) {
    return (
      <button
        type="button"
        data-dw-tip="停止"
        aria-label="停止"
        onClick={onStop}
        className="dw-pop flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full bg-ink text-shell transition-all duration-150 hover:opacity-85"
      >
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
          <rect width="11" height="11" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-dw-tip="发送"
      aria-label="发送"
      disabled={disabled}
      onClick={onSend}
      className="flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full bg-elevated text-ink transition-all duration-150 enabled:hover:bg-ink enabled:hover:text-shell enabled: disabled:opacity-45"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
