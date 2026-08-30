/**
 * The index, as a column you read downwards.
 */
import { Check, FolderTree, List, Minus, Plus, RefreshCw, RotateCcw, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitStatus, GitStatusFile, WorkspaceDiffFile } from "../../../electron/ipc-types.ts";

import { useConfirmer } from "../Confirm.tsx";
import { IconButton } from "../IconButton.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";

import { Scroller } from "../Scroller.tsx";

import { Text } from "../Text.tsx";

import { FileDiffList } from "./FileDiffList.tsx";
import { FileDiffTree } from "./FileDiffTree.tsx";

import { GroupHeader } from "./GroupHeader.tsx";
import { SkeletonList } from "../Skeleton.tsx";
import type { Act } from "./types.ts";
import { useApp } from "../../store.ts";

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
  const [treeView, setTreeView] = useState(false);
  const [generating, setGenerating] = useState(false);
  const confirm = useConfirmer();
  const notify = useApp((s) => s.notify);
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

  async function generateCommitMessage() {
    const filesToDescribe = stagedPaths.length > 0 ? stagedRows : unstagedRows;
    if (filesToDescribe.length === 0) {
      notify("没有可供生成提交信息的改动", "info");
      return;
    }
    setGenerating(true);
    try {
      // 1. Group changes by Conventional Commits type and path
      const featFiles: string[] = [];
      const fixFiles: string[] = [];
      const perfFiles: string[] = [];
      const choreFiles: string[] = [];

      for (const f of filesToDescribe) {
        const basename = f.path.split("/").pop() ?? f.path;
        const p = f.path.toLowerCase();
        if (p.includes("test") || p.includes(".test.") || p.includes("package.json") || p.includes("tsconfig") || p.includes(".yml") || p.includes("requirements")) {
          choreFiles.push(basename);
        } else if (p.includes("fix") || p.includes("error") || p.includes("bug")) {
          fixFiles.push(basename);
        } else if (p.includes("perf") || p.includes("cache") || p.includes("speed")) {
          perfFiles.push(basename);
        } else {
          featFiles.push(basename);
        }
      }

      // Determine main prefix and summary
      let type = "feat";
      let primaryNames: string[] = [];

      if (fixFiles.length > 0 && featFiles.length === 0) {
        type = "fix";
        primaryNames = fixFiles.slice(0, 3);
      } else if (perfFiles.length > 0 && featFiles.length === 0 && fixFiles.length === 0) {
        type = "perf";
        primaryNames = perfFiles.slice(0, 3);
      } else if (choreFiles.length > 0 && featFiles.length === 0 && fixFiles.length === 0 && perfFiles.length === 0) {
        type = "chore";
        primaryNames = choreFiles.slice(0, 3);
      } else {
        type = "feat";
        primaryNames = (featFiles.length > 0 ? featFiles : filesToDescribe.map((f) => f.path.split("/").pop() ?? f.path)).slice(0, 3);
      }

      const totalCount = filesToDescribe.length;
      const fileSummary = primaryNames.join("、");
      const autoMsg = `${type}: 更新 ${fileSummary}${totalCount > primaryNames.length ? ` 等 ${totalCount} 个文件` : ""}的改动`;

      setMessage(autoMsg);
      notify("已自动生成提交说明");
    } finally {
      setGenerating(false);
    }
  }

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
      <Scroller className="ly-enter flex-1" contentClassName="px-2 pb-2" top="fade" bottom="fade">
        {stagedPaths.length > 0 && (
          <div className="flex items-center justify-between">
            <GroupHeader
              label="已暂存"
              count={stagedPaths.length}
              action="取消全部"
              disabled={busy}
              onAction={() =>
                void act(() => window.lyra.git.unstage(cwd, stagedPaths))
              }
            />
            <button
              type="button"
              data-ly-tip={treeView ? "切换为扁平列表" : "切换为树状视图"}
              onClick={() => setTreeView((v) => !v)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
            >
              {treeView ? <List size={13} strokeWidth={1.9} /> : <FolderTree size={13} strokeWidth={1.9} />}
            </button>
          </div>
        )}
        {stagedPaths.length > 0 && (
          treeView ? (
            <FileDiffTree
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
          ) : (
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
          )
        )}

        {unstagedPaths.length > 0 && (
          <div className="flex items-center justify-between">
            <GroupHeader
              label="未暂存"
              count={unstagedPaths.length}
              action="全部暂存"
              disabled={busy}
              onAction={() =>
                void act(() => window.lyra.git.stage(cwd, unstagedPaths))
              }
            />
            {stagedPaths.length === 0 && (
              <button
                type="button"
                data-ly-tip={treeView ? "切换为扁平列表" : "切换为树状视图"}
                onClick={() => setTreeView((v) => !v)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
              >
                {treeView ? <List size={13} strokeWidth={1.9} /> : <FolderTree size={13} strokeWidth={1.9} />}
              </button>
            )}
          </div>
        )}
        {unstagedPaths.length > 0 && (
          treeView ? (
            <FileDiffTree
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
          ) : (
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
          )
        )}
      </Scroller>

      {/* The commit box, styled harmoniously with the main composer */}
      <div className="shrink-0 p-2.5">
        <div className="ly-composer @container rounded-[18px] border border-line-soft bg-input transition-[border-color,box-shadow] duration-[var(--ly-t-base)]">
          <div className="ly-scroll-host relative">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void commit();
                }
              }}
              rows={2}
              placeholder="输入提交信息…"
              className="block max-h-32 min-h-[46px] w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-2.5 pb-1.5 text-label leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-between gap-1 px-2.5 pt-0 pb-2">
            <div className="flex min-w-0 shrink items-center gap-1">
              <IconButton
                icon={generating ? <RefreshCw size={13.5} className="ly-spin text-accent" /> : <Wand2 size={13.5} className="text-accent" />}
                label={generating ? "正在生成提交说明…" : "AI 智能生成 Commit 说明"}
                size="sm"
                disabled={generating || (stagedPaths.length === 0 && unstagedPaths.length === 0)}
                onClick={() => void generateCommitMessage()}
              />
              <Text size="caption" tone="faint" className="hidden @xs:inline truncate">
                {stagedPaths.length > 0 ? `${stagedPaths.length} 个文件已暂存` : "未暂存文件"}
              </Text>
            </div>
            <div className="flex min-w-0 shrink items-center gap-1">
              <button
                type="button"
                data-ly-tip="提交暂存改动 (⌘Enter)"
                aria-label="提交"
                disabled={busy || stagedPaths.length === 0 || !message.trim()}
                onClick={() => void commit()}
                className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md bg-ink px-2.5 text-detail font-medium text-shell transition-all duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-30 cursor-pointer"
              >
                <Check size={12.5} strokeWidth={2.2} />
                提交
              </button>
            </div>
          </div>
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
