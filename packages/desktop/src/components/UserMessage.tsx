import type {
  UserContent,
  UserMessage as UserMessageType,
} from "@deepwise/core";
import { MessageSquarePlus, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MessageActions } from "./MessageActions.tsx";
import { OverlayScrollbar } from "./OverlayScrollbar.tsx";
import { useApp } from "../store.ts";

/**
 * A message you sent, with the two things you want from one afterwards: to copy it, and to
 * take it back.
 *
 * Editing re-runs the conversation from this point. Everything after — the reply it drew, and
 * anything built on that reply — is discarded, because none of it follows from the new
 * wording any more. Leaving it would put an answer to a question nobody asked directly under
 * the question that replaced it.
 */
export function UserMessage({
  message,
  index,
}: {
  message: UserMessageType;
  index: number;
}) {
  const running = useApp((s) => s.running);
  const editMessage = useApp((s) => s.editMessage);

  const text = message.content
    .filter(
      (block): block is Extract<UserContent, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
  const images = message.content.filter((block) => block.type === "image");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow to fit while editing, so a long prompt is not edited through a three-line window.
  useEffect(() => {
    const el = textareaRef.current;
    if (!editing || !el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [editing, draft]);

  function submit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === text) return;
    // Images are carried over: the edit is to the wording, not to what was attached.
    void editMessage(index, [...images, { type: "text", text: trimmed }]);
  }

  if (editing) {
    return (
      <div className="dw-enter mb-6 flex justify-end">
        {/* The same surface as the composer: editing a message is the same act as writing one. */}
        <div className="dw-composer w-full rounded-[18px] border border-line-soft bg-input px-4 pt-3.5 pb-2.5">
          <div className="dw-scroll-host relative">
            <textarea
              ref={textareaRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                  setDraft(text);
                }
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              className="block max-h-[320px] w-full resize-none overflow-y-auto bg-transparent text-[13.5px] leading-relaxed text-ink"
            />
            {/* Same treatment as the composer: a long edit scrolls, so it needs a thumb. */}
            <OverlayScrollbar viewport={textareaRef} orientation="vertical" />
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(text);
              }}
              className="h-7 rounded-lg border border-line px-3 text-[12.5px] text-ink-muted transition-colors duration-150 hover:bg-card-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={submit}
              className="h-7 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-shell transition-opacity duration-150 hover:opacity-90 disabled:opacity-45"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg dw-enter mb-6 flex flex-col items-end">
      {/*
       * Always visible, not folded into the hover row below.
       *
       * This message was written by the side chat, not by the person reading it. Finding
       * an instruction in your own voice that you have no memory of writing is disorienting
       * enough that the explanation cannot be something you have to go looking for.
       */}
      {message.origin === "side-chat" && (
        <span className="mb-1 flex items-center gap-1 pr-1 text-[11px] text-ink-faint">
          <MessageSquarePlus size={11} strokeWidth={1.9} />
          来自侧边聊天
        </span>
      )}

      <div className="max-w-[75%] rounded-[16px] rounded-br-[6px] bg-card px-4 py-2.5">
        {text && (
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
            {text}
          </p>
        )}
        {images.map((block, i) => (
          <img
            key={i}
            src={`data:${block.mimeType};base64,${block.data}`}
            alt=""
            className="mt-2 max-h-[240px] rounded-lg border border-line"
          />
        ))}
      </div>

      {/* Editing is the one thing a sent message offers that a reply does not. */}
      <MessageActions
        timestamp={message.timestamp}
        text={text}
        className="pr-1"
      >
        <button
          type="button"
          title={running ? "回合进行中，无法编辑" : "编辑并重新发送"}
          aria-label="编辑并重新发送"
          disabled={running}
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-card-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Pencil size={12.5} strokeWidth={1.8} />
        </button>
      </MessageActions>
    </div>
  );
}
