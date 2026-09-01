import type {
  UserContent,
  UserMessage as UserMessageType,
} from "@lyra/core";
import { ChevronDown, ChevronUp, Copy, Check, FileText, MessageSquarePlus, Pencil } from "lucide-react";
import { openFromEvent } from "./image/viewer-store.ts";
import { useState } from "react";
import { MessageActions } from "./MessageActions.tsx";
import { extractCodeOrErrorBlocks } from "./code-detection.ts";
import { MessageEditor } from "./message/MessageEditor.tsx";
import { useApp } from "../store.ts";

/**
 * Renders an extracted code snippet or stack trace block as a clean collapsible card.
 */
function CollapsibleCodeCard({ name, content }: { name: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = content.split("\n");
  const lineCount = lines.length;
  const sizeKb = (new TextEncoder().encode(content).length / 1024).toFixed(1);

  const previewText = lines.slice(0, 5).join("\n");

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line-soft bg-input/70 transition-all">
      {/* File Header Bar */}
      <div className="flex items-center justify-between border-b border-line/60 bg-shell/50 px-3 py-2 text-caption select-none">
        <div className="flex items-center gap-1.5 text-ink-muted">
          <FileText size={13} className="text-ink-faint" />
          <span className="font-mono text-[12px] font-medium text-ink">{name}</span>
          <span className="text-[11px] text-ink-faint">({lineCount} 行 · {sizeKb} KB)</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
            data-ly-tip="复制全文"
          >
            {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
            <span className="text-[11px]">{copied ? "已复制" : "复制"}</span>
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-caption text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
          >
            <span className="text-[11px]">{expanded ? "收起" : "展开"}</span>
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {/* Snippet Content */}
      <div className="relative font-mono text-[12.5px] leading-5">
        <pre className={`overflow-x-auto p-3 text-ink-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text ${expanded ? "max-h-[420px] overflow-y-auto" : "max-h-[110px] overflow-hidden pb-7"}`}>
          {expanded ? content : previewText}
        </pre>
        {!expanded && lineCount > 5 && (
          <div
            onClick={() => setExpanded(true)}
            className="absolute inset-x-0 bottom-0 flex h-9 cursor-pointer items-center justify-center bg-gradient-to-t from-shell via-shell/90 to-transparent text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
          >
            <span>点击展开余下 {lineCount - 5} 行...</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Parses user text: if attached files or raw error blocks are present,
 * renders natural prompts and code/error attachments separately.
 */
function SmartUserContent({ text }: { text: string }) {
  // 1. If text has explicit attached files format `### 附件文件: filename\n\`\`\`\n...`
  const attachedFileRegex = /### 附件文件:\s*([^\n]+)\n```(?:\w+)?\n([\s\S]*?)\n```/g;
  const matches = [...text.matchAll(attachedFileRegex)];

  if (matches.length > 0) {
    const nonAttachmentPrompt = text.replace(attachedFileRegex, "").trim();
    return (
      <div className="space-y-1.5">
        {matches.map((m, idx) => (
          <CollapsibleCodeCard key={idx} name={m[1].trim()} content={m[2]} />
        ))}
        {nonAttachmentPrompt && (
          <p className="text-body leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-ink">
            {nonAttachmentPrompt}
          </p>
        )}
      </div>
    );
  }

  // 2. If user pasted a code/error block directly without explicit attachment header
  const match = extractCodeOrErrorBlocks(text);
  if (match.hasExtracted && match.extractedBlock) {
    return (
      <div className="space-y-1.5">
        <CollapsibleCodeCard
          name={match.extractedBlock.name}
          content={match.extractedBlock.content}
        />
        {match.mainText && (
          <p className="text-body leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-ink">
            {match.mainText}
          </p>
        )}
      </div>
    );
  }

  // 3. Plain normal user prose
  return (
    <p className="text-body leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-ink">
      {text}
    </p>
  );
}

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
  function submit() {
    const trimmed = draft.trim();
    setEditing(false);
    /*
     * Unchanged text still sends.
     *
     * This used to return early when the wording had not moved, on the reasoning that there was
     * nothing to do. But re-sending the same message is exactly what you want after a turn died
     * on a dropped connection — and pressing 发送 and having nothing at all happen reads as a
     * broken button, not as a considerate no-op. Cancel is right there for changing your mind.
     */
    if (!trimmed) return;
    // Images are carried over: the edit is to the wording, not to what was attached.
    void editMessage(index, [...images, { type: "text", text: trimmed }]);
  }

  if (editing) {
    return (
      <div className="ly-enter mb-2.5 flex justify-end">
        <MessageEditor
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onCancel={() => {
            setEditing(false);
            setDraft(text);
          }}
        />
      </div>
    );
  }

  return (
    <div className="group/msg ly-enter mb-2.5 flex flex-col items-end">
      {/*
       * Always visible, not folded into the hover row below.
       *
       * This message was written by the side chat, not by the person reading it. Finding
       * an instruction in your own voice that you have no memory of writing is disorienting
       * enough that the explanation cannot be something you have to go looking for.
       */}
      {message.origin === "side-chat" && (
        <span className="mb-1 flex items-center gap-1 pr-1 text-caption text-ink-faint">
          <MessageSquarePlus size={11} strokeWidth={1.9} />
          来自侧边聊天
        </span>
      )}

      <div className="max-w-[75%] overflow-hidden rounded-[16px] rounded-br-[6px] bg-card px-4 py-2.5">
        {text && <SmartUserContent text={text} />}
        {/*
         * Thumbnails in a row, not a stack of full-size pictures.
         *
         * What a sent image needs to do here is say which image it was; looking at it properly is
         * a click away, and the viewer is much better at it than a message bubble. At full height
         * three screenshots pushed the reply that followed them off the screen — the picture took
         * the space, and the conversation lost it.
         */}
        {images.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${text ? "mt-2" : ""}`}>
            {images.map((block, i) => (
              /*
               * Openable, but not replaceable: this one has already been sent. The viewer notices
               * the missing `onReplace` and offers the annotated copy for the clipboard instead of
               * silently rewriting a message that is part of the record.
               */
              <button
                key={i}
                type="button"
                aria-label="预览图片"
                onClick={(event) =>
                  openFromEvent(
                    event,
                    images.map((img) => ({ src: `data:${img.mimeType};base64,${img.data}` })),
                    i,
                  )
                }
                className="block h-[64px] w-[64px] shrink-0 overflow-hidden rounded-lg border border-line transition-[opacity,transform] duration-[var(--ly-t-quick)] hover:opacity-88 active:scale-[0.97]"
              >
                {/* `cover`: a row of equal squares reads as a set. Letterboxed thumbnails of mixed
                    aspect ratios read as a layout that gave up. */}
                <img
                  src={`data:${block.mimeType};base64,${block.data}`}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Editing is the one thing a sent message offers that a reply does not. */}
      <MessageActions
        timestamp={message.timestamp}
        text={text}
        className="pr-1"
      >
        <button
          type="button"
          data-ly-tip={running ? "回合进行中，无法编辑" : "编辑并重新发送"}
          aria-label="编辑并重新发送"
          disabled={running}
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Pencil size={12.5} strokeWidth={1.8} />
        </button>
      </MessageActions>
    </div>
  );
}
