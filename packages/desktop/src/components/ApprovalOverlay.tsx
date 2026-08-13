import { Terminal, TriangleAlert } from "lucide-react";
import { Scroller } from "./Scroller.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

const KIND_LABEL: Record<string, string> = {
  bash: "执行命令",
  write: "写入文件",
  edit: "修改文件",
  mcp: "调用 MCP 工具",
  network: "访问网络",
};

/**
 * Approval prompt. It blocks the composer rather than the whole window so the user can still
 * read the transcript above while deciding.
 */
export function ApprovalOverlay() {
  const approvals = useApp((s) => s.approvals);
  const respond = useApp((s) => s.respondToApproval);
  const { compact } = useLayout();
  const request = approvals[0];
  if (!request) return null;

  return (
    <div
      /*
       * Anchored to the top edge of the composer, so it never covers it.
       *
       * The fade is still here because the transcript scrolls underneath: without it, a
       * line of code slides out from behind the card with nothing in between.
       */
      className={`pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center bg-gradient-to-t from-shell via-shell/95 to-transparent pb-2 ${
        compact ? "px-4 pt-8" : "px-8 pt-16"
      }`}
    >
      <div className="dw-slide-up pointer-events-auto w-full max-w-[var(--dw-content)] overflow-hidden rounded-[14px] border border-accent/35 bg-panel shadow-2xl shadow-black/40">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <TriangleAlert
            size={15}
            strokeWidth={1.9}
            className="shrink-0 text-accent"
          />
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">
            {request.title}
          </span>
          <span className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[11px] text-ink-faint">
            {KIND_LABEL[request.kind] ?? request.kind}
          </span>
          {approvals.length > 1 && (
            <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
              还有 {approvals.length - 1} 个
            </span>
          )}
        </div>

        <Scroller
          className="max-h-[min(280px,30vh)] bg-shell/60"
          contentClassName="px-4 py-3"
          fadeColor="var(--color-shell)"
        >
          <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">
            {request.detail}
          </pre>
        </Scroller>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-2.5">
          <button
            type="button"
            onClick={() => void respond(request.id, "reject")}
            className="h-8 rounded-lg px-3 text-[12.5px] text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => void respond(request.id, "always")}
            className="h-8 rounded-lg border border-line px-3 text-[12.5px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
          >
            始终允许
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => void respond(request.id, "once")}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[12.5px] font-medium text-shell transition-opacity hover:opacity-90"
          >
            <Terminal size={13} strokeWidth={2} />
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
}
