import { Check, GitCommitVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayScrollbar } from "./OverlayScrollbar.tsx";
import { MenuBody, Popover, usePopover } from "./Popover.tsx";
import { useSide } from "../sideStore.ts";
import { useApp } from "../store.ts";

/**
 * How much is uncommitted, always in view.
 *
 * The agent edits files. The one thing you need to keep track of while it does — and the thing
 * that is easiest to lose track of — is how much has piled up that you have not looked at.
 * Having to open a panel to find out makes it something you ask about; sitting here, it is
 * something you notice.
 *
 * Committing lives on the same row for a related reason. Reviewing and committing are one
 * motion: you read the diff, you decide, you record it. Send someone to a terminal in between
 * and the judgement they formed is gone by the time they arrive.
 */
export function ChangeBar() {
  const workspace = useApp((s) => s.workspace);
  const running = useApp((s) => s.running);
  const notify = useApp((s) => s.notify);
  const refreshWorkspace = useApp((s) => s.refreshWorkspace);
  const openTab = useSide((s) => s.openTab);

  const [stat, setStat] = useState<{
    added: number;
    removed: number;
    files: number;
  } | null>(null);
  const commitMenu = usePopover();

  const cwd = workspace?.path;
  const isRepo = workspace?.isGitRepo ?? false;

  const refresh = useCallback(async () => {
    if (!cwd || !isRepo) {
      setStat(null);
      return;
    }
    const next = await window.deepwise.git.stat(cwd);
    setStat({ added: next.added, removed: next.removed, files: next.files });
  }, [cwd, isRepo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The agent writes files as it works; re-count once each turn settles.
  useEffect(() => {
    if (!running) void refresh();
  }, [running, refresh]);

  if (!stat || stat.files === 0) return null;

  return (
    <>
      <button
        type="button"
        title={`${stat.files} 个文件有未提交的改动 · 点击查看`}
        onClick={() => openTab("review")}
        className="dw-scroll flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-150 hover:bg-card-hover"
      >
        <span className="font-mono text-[11.5px] text-ok">
          +{stat.added.toLocaleString()}
        </span>
        <span className="font-mono text-[11.5px] text-danger">
          −{stat.removed.toLocaleString()}
        </span>
      </button>

      <button
        type="button"
        onClick={commitMenu.toggle}
        aria-haspopup="dialog"
        aria-expanded={commitMenu.open}
        className={`flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-150 ${
          commitMenu.open
            ? "bg-card-hover text-ink"
            : "text-ink-muted hover:bg-card-hover hover:text-ink"
        }`}
      >
        <GitCommitVertical size={13} strokeWidth={1.8} className="shrink-0" />
        提交
      </button>

      {commitMenu.open && cwd && (
        <CommitBox
          anchor={commitMenu.anchor}
          onClose={commitMenu.close}
          cwd={cwd}
          stat={stat}
          onCommitted={() => {
            commitMenu.close();
            void refresh();
            // The branch line may have moved; the chip beside this reads it.
            void refreshWorkspace();
            notify("已提交");
          }}
          onFailed={(error) => notify(error, "error")}
        />
      )}
    </>
  );
}

function CommitBox({
  anchor,
  onClose,
  cwd,
  stat,
  onCommitted,
  onFailed,
}: {
  anchor: Parameters<typeof Popover>[0]["anchor"];
  onClose: () => void;
  cwd: string;
  stat: { added: number; removed: number; files: number };
  onCommitted: () => void;
  onFailed: (error: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => field.current?.focus(), []);

  async function commit() {
    if (!message.trim() || busy) return;
    setBusy(true);
    const result = await window.deepwise.git.commit(cwd, message);
    setBusy(false);
    if (result.ok) onCommitted();
    else onFailed(result.error ?? "提交失败");
  }

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      placement="top"
      align="end"
      width={320}
    >
      <MenuBody>
        <div className="px-2 pt-1.5 pb-2">
          <p className="pb-2 text-[11.5px] text-ink-faint">
            {stat.files} 个文件 ·{" "}
            <span className="text-ok">+{stat.added.toLocaleString()}</span>{" "}
            <span className="text-danger">
              −{stat.removed.toLocaleString()}
            </span>{" "}
            · 全部暂存并提交
          </p>

          <div className="dw-scroll-host relative">
            <textarea
              ref={field}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                // Enter commits; the message is one line far more often than not.
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void commit();
                }
              }}
              rows={3}
              placeholder="这次改动做了什么"
              className="block max-h-[160px] w-full resize-none overflow-y-auto rounded-lg border border-line bg-input px-2.5 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink-faint"
            />
            {/* A long commit message scrolls inside its 160px ceiling, like the composer. */}
            <OverlayScrollbar viewport={field} orientation="vertical" />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-7 rounded-lg border border-line px-3 text-[12.5px] text-ink-muted transition-colors duration-150 hover:bg-card-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!message.trim() || busy}
              onClick={() => void commit()}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-shell transition-opacity duration-150 hover:opacity-90 disabled:opacity-45"
            >
              {busy ? (
                "提交中…"
              ) : (
                <>
                  <Check size={12.5} strokeWidth={2.4} />
                  提交
                </>
              )}
            </button>
          </div>
        </div>
      </MenuBody>
    </Popover>
  );
}
