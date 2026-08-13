import { GitCommitVertical } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
 * Both controls open the Git panel rather than acting here. Committing used to happen in a
 * popover hanging off this row, which could only ever stage everything and record it blind —
 * there was nowhere in it to see what was going in. Reviewing and committing are one motion, so
 * they belong in the one place that can show both.
 */
export function ChangeBar() {
  const workspace = useApp((s) => s.workspace);
  const running = useApp((s) => s.running);
  const openTab = useSide((s) => s.openTab);

  const [stat, setStat] = useState<{
    added: number;
    removed: number;
    files: number;
  } | null>(null);

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
        data-dw-tip="在 Git 面板中查看并提交"
        onClick={() => openTab("review")}
        className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-card-hover hover:text-ink"
      >
        <GitCommitVertical size={13} strokeWidth={1.8} className="shrink-0" />
        提交
      </button>
    </>
  );
}
