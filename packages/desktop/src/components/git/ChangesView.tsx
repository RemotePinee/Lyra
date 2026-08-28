/**
 * The index, as a column you read downwards.
 */
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitStatus, GitStatusFile, WorkspaceDiffFile } from "../../../electron/ipc-types.ts";

import { useConfirmer } from "../Confirm.tsx";
import { IconButton } from "../IconButton.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";

import { Scroller } from "../Scroller.tsx";

import { Text } from "../Text.tsx";

import { FileDiffList } from "./FileDiffList.tsx";

import { GroupHeader } from "./GroupHeader.tsx";
import { SkeletonList } from "../Skeleton.tsx";
import type { Act } from "./types.ts";

/**
 * Staged above unstaged, with the commit box under both.
 *
 * The split is the whole reason to have an index in front of you: the top group is what the
 * next commit will contain, the bottom is what it will not. Reading down the column is reading
 * the commit you are about to make.
 */
export function ChangesView({
  status,
  cwd,
  busy,
  loading,
  act,
}: {
  status: GitStatus | null;
  cwd: string;
  busy: boolean;
  /** The checkout moved and this is being re-read; see `switching` in `GitPanel`. */
  loading?: boolean;
  act: Act;
}) {
  const [message, setMessage] = useState("");
  const confirm = useConfirmer();
  /** The hunks, once they arrive. The rows themselves do not wait for them — see `rowsFor`. */
  const [hunks, setHunks] = useState<{ staged: WorkspaceDiffFile[]; unstaged: WorkspaceDiffFile[] }>({
    staged: [],
    unstaged: [],
  });

  /*
   * Two diffs, matching the two groups.
   *
   * The staged side is the index against HEAD and the unstaged side the working tree against
   * the index — the same split git itself makes. Fetched here rather than in the parent so a
   * staging click re-reads only what it changed.
   *
   * `status` has to be a stable object across polls that found nothing new, or this runs every
   * 1.5s and the panel spends every turn queued behind a read slower than the interval it is
   * started on. That is `sameStatus`, in the parent.
   */
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.lyra.git.diffRefs(cwd, "HEAD", null),
      window.lyra.diff.workspaceDiff(cwd),
    ]).then(([indexDiff, treeDiff]) => {
      if (!live) return;
      setHunks({ staged: indexDiff.files, unstaged: treeDiff.files });
    });
    return () => {
      live = false;
    };
  }, [cwd, status]);

  const stagedPaths = status?.staged.map((file) => file.path) ?? [];
  const unstagedPaths = status?.unstaged.map((file) => file.path) ?? [];
  const nothing = stagedPaths.length === 0 && unstagedPaths.length === 0;

  /*
   * The rows come from `status`; only their contents wait for the diff.
   *
   * These used to be the diff's own file list, which meant the group heading — "未暂存 240",
   * drawn from `status` — arrived a couple of hundred milliseconds before anything under it, and
   * then two hundred rows landed at once. A count with nothing beneath it reads as a panel that
   * failed rather than one that is loading, and the rows arriving in one frame reads as a jolt.
   *
   * Everything a row shows is already in `status`: the path, what happened to it, how many lines.
   * The only thing the diff adds is the hunks, and those are not on screen until the row is
   * expanded. So the list is drawn immediately and each row picks up its hunks when they land.
   */
  const stagedRows = rowsFor(status?.staged ?? [], hunks.staged);
  const unstagedRows = rowsFor(status?.unstaged ?? [], hunks.unstaged);

  async function commit() {
    const ok = await act(() => window.lyra.git.commitStaged(cwd, message));
    if (ok) setMessage("");
  }

  /*
   * While the checkout is moving, stand in the shape of what is coming.
   *
   * Ahead of the empty state on purpose: mid-switch there is no answer yet, and 「工作区干净」 is an
   * answer — the wrong one, stated confidently, for however long `git status` takes on a large
   * repository.
   */
  if (loading) {
    return (
      <div className="ly-enter flex-1 px-1.5 pt-2">
        <SkeletonList count={5} label="正在读取改动" />
      </div>
    );
  }

  if (nothing) {
    return (
      <PanelEmpty icon={Check} title="工作区干净">
        没有未提交的改动。
      </PanelEmpty>
    );
  }

  return (
    /* `ly-enter` so the list arrives rather than replacing the skeleton in one frame. */
    <>
      <Scroller className="ly-enter flex-1" contentClassName="px-1.5 pb-2" top="none" bottom="none">
        {stagedPaths.length > 0 && (
          <GroupHeader
            label="已暂存"
            count={stagedPaths.length}
            action="取消全部"
            disabled={busy}
            onAction={() =>
              void act(() => window.lyra.git.unstage(cwd, stagedPaths))
            }
          />
        )}
        {stagedPaths.length > 0 && (
          <FileDiffList
            cwd={cwd}
            files={stagedRows}
            actions={(file) => (
              <IconButton
                icon={<Minus size={12} strokeWidth={1.9} />}
                label="取消暂存"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() => window.lyra.git.unstage(cwd, [file.path]))
                }
              />
            )}
          />
        )}

        {unstagedPaths.length > 0 && (
          <GroupHeader
            label="未暂存"
            count={unstagedPaths.length}
            action="全部暂存"
            disabled={busy}
            onAction={() =>
              void act(() => window.lyra.git.stage(cwd, unstagedPaths))
            }
          />
        )}
        {unstagedPaths.length > 0 && (
          <FileDiffList
            cwd={cwd}
            files={unstagedRows}
            actions={(file) => (
              <>
                <IconButton
                  icon={<RotateCcw size={12} strokeWidth={1.9} />}
                  label="放弃改动"
                  size="sm"
                  tone="danger"
                  disabled={busy}
                  /*
                   * The app's own confirmation, not the browser's.
                   *
                   * Discarding is the most irreversible thing this panel does — an untracked file
                   * is deleted outright, and a tracked one loses work that was never committed, so
                   * there is nothing to recover it from. It did ask, via `window.confirm`, which
                   * draws a Chromium dialog with system fonts, an OS-blue button and the word
                   * "localhost" across the top, and freezes the renderer while it is up.
                   */
                  onClick={() =>
                    confirm.ask({
                      title: `放弃 ${file.path.split("/").pop()} 的改动？`,
                      detail:
                        "这个文件会回到上次提交的样子；没提交过的内容找不回来，git 里也没有它的副本。",
                      confirmLabel: "放弃改动",
                      onConfirm: () =>
                        void act(() => window.lyra.git.discard(cwd, [file.path])),
                    })
                  }
                />
                <IconButton
                  icon={<Plus size={12} strokeWidth={1.9} />}
                  label="暂存"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() => window.lyra.git.stage(cwd, [file.path]))
                  }
                />
              </>
            )}
          />
        )}
      </Scroller>

      {/* The commit box, always in view: it is what the list above is building towards. */}
      <div className="shrink-0 border-t border-line-soft p-1.5">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
              void commit();
          }}
          rows={2}
          placeholder="提交信息"
          className="block w-full resize-none rounded-lg border border-line bg-input px-2.5 py-2 text-label leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink-faint"
        />
        <div className="flex items-center justify-between gap-2 pt-1.5">
          <Text size="caption" tone="faint">
            {stagedPaths.length > 0
              ? `将提交 ${stagedPaths.length} 个文件`
              : "先暂存要提交的文件"}
          </Text>
          <button
            type="button"
            disabled={busy || stagedPaths.length === 0 || !message.trim()}
            onClick={() => void commit()}
            className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 text-detail font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-40"
          >
            <Check size={12} strokeWidth={2.2} />
            提交
          </button>
        </div>
      </div>

      {confirm.element}
    </>
  );
}

/**
 * One row per file git reported, carrying its hunks if they have arrived.
 *
 * `status` is the authority on which files are in the group and what happened to them — it is what
 * the heading counts, and drawing the rows from anything else lets the two disagree. The diff only
 * supplies what a row shows once it is expanded, so a file it has not answered for yet is a
 * perfectly good row with nothing folded inside it.
 *
 * Line counts prefer the diff's, which are computed from the comparison the panel actually shows;
 * `status` takes its own from `--numstat`, and the two have drifted apart before.
 */
function rowsFor(files: GitStatusFile[], diffed: WorkspaceDiffFile[]): WorkspaceDiffFile[] {
  const known = new Map(diffed.map((file) => [file.path, file]));
  return files.map(
    (file) =>
      known.get(file.path) ?? {
        path: file.path,
        status: file.status,
        added: file.added,
        removed: file.removed,
        hunks: [],
      },
  );
}
