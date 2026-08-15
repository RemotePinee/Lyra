import { ArrowDownToLine, ArrowUpFromLine, GitBranch, GitCommitHorizontal, GitCompare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { GitStatus } from "../../../electron/ipc-types.ts";
import type { RepoRef } from "../../../electron/git.ts";
import { IconButton } from "../IconButton.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";

import { Text } from "../Text.tsx";
import { useApp } from "../../store.ts";

import { BranchesView } from "./BranchesView.tsx";
import { ChangesView } from "./ChangesView.tsx";
import { HistoryView } from "./HistoryView.tsx";
import { RepoPicker } from "./RepoPicker.tsx";

type View = "changes" | "history" | "branches";

const VIEWS: { id: View; label: string; icon: typeof GitCompare }[] = [
  { id: "changes", label: "改动", icon: GitCompare },
  { id: "history", label: "历史", icon: GitCommitHorizontal },
  { id: "branches", label: "分支", icon: GitBranch },
];

/**
 * Git, as a place rather than a button.
 *
 * Committing used to live in a popover hanging off the composer's status bar: one message field
 * and one button that staged everything. That is the shape of a shortcut, and it can only ever
 * be a shortcut — there is nowhere in it to see what you are about to commit, to leave half of
 * it out, to look at what happened yesterday, or to compare two branches. Those are the reasons
 * you open a git client, and none of them fit above a text field.
 *
 * Three views, because there are three questions: what is changing now, what changed before,
 * and what else is going on. They share one file list, since "what changed" renders the same
 * whether the change is uncommitted, a commit old, or the distance between two branches.
 */
export function GitPanel() {
  const workspace = useApp((s) => s.workspace);
  const running = useApp((s) => s.running);
  const [view, setView] = useState<View>("changes");
  /*
   * Which repository the panel is looking at.
   *
   * A workspace is a folder someone opened, and it is perfectly ordinary for one to hold
   * several repositories — a frontend beside a backend, or services versioned apart on purpose.
   * Assuming the root was the repository meant everything else was invisible.
   */
  const [repos, setRepos] = useState<RepoRef[]>([]);
  /** True until the first scan finishes, so "no repository" is only said once it is known. */
  const [scanning, setScanning] = useState(true);
  /** Bumped to re-run the scan after something changes what it would find. */
  const [rescan, setRescan] = useState(0);
  /** Worktrees per repository, keyed by the repository's path. */
  const [trees, setTrees] = useState<Record<string, RepoRef[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Rescan when the workspace changes; the selection follows unless it is still valid.
   *
   * Each repository is asked for its worktrees at the same time. A worktree has a `.git` of its
   * own, so the directory scan finds it and would list it a second time as a repository in its
   * own right — the same branch of the same history appearing twice, under two names. Anything
   * claimed by a repository as a worktree is therefore removed from the top level and shown
   * beneath the repository it belongs to.
   */
  const workspacePath = workspace?.path ?? null;
  useEffect(() => {
    if (!workspacePath) {
      setRepos([]);
      setTrees({});
      setScanning(false);
      return;
    }
    let cancelled = false;
    setScanning(true);
    void (async () => {
      const found = await window.deepwise.git.repos(workspacePath);
      const lists = await Promise.all(
        found.map(async (repo) => [repo.path, await window.deepwise.git.worktrees(repo.path)] as const),
      );
      if (cancelled) return;

      const linked = new Map<string, RepoRef[]>();
      const claimed = new Set<string>();
      for (const [root, all] of lists) {
        const attached = all.filter((tree) => tree.worktree);
        linked.set(root, attached);
        for (const tree of attached) claimed.add(tree.path);
      }
      const roots = found.filter((repo) => !claimed.has(repo.path));

      setRepos(roots);
      setTrees(Object.fromEntries(roots.map((repo) => [repo.path, linked.get(repo.path) ?? []])));
      setSelected((current) => {
        const reachable = [...roots.map((r) => r.path), ...claimed];
        return current && reachable.includes(current) ? current : (roots[0]?.path ?? null);
      });
      setScanning(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, rescan]);

  /*
   * Only a real repository, never the workspace root as a stand-in.
   *
   * Falling back to the folder meant every panel below this had something to work with, so a
   * directory with no version control at all rendered as a repository with no branch: a dash
   * where the name goes, pull and push buttons that could not do anything, and "工作区干净"
   * announcing that nothing had changed in a history that did not exist.
   */
  const cwd = selected;

  const refresh = useCallback(async () => {
    if (!cwd) return setStatus(null);
    setStatus(await window.deepwise.git.status(cwd));
  }, [cwd]);

  // Re-read when a turn ends: the agent's edits are the changes this panel is here to show.
  useEffect(() => {
    if (!running) void refresh();
  }, [running, refresh]);

  /** Wraps an operation so every one of them reports the same way and re-reads after. */
  const act = useCallback(
    async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      setError(null);
      const result = await operation();
      if (!result.ok) setError(result.error ?? "操作失败");
      await refresh();
      setBusy(false);
      return result.ok;
    },
    [refresh],
  );

  if (!workspace) {
    return (
      <PanelEmpty icon={GitBranch} title="Git">
        先打开一个项目。
      </PanelEmpty>
    );
  }

  // Nothing is known yet; an empty state now would be a claim the scan has not made.
  if (scanning) return <div className="flex-1" />;

  if (!cwd) {
    return (
      <PanelEmpty icon={GitBranch} title="不是 Git 仓库">
        <span className="block">这个目录还没有版本控制。</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void act(() => window.deepwise.git.init(workspace.path)).then((ok) => {
              // Re-scan rather than assume: the new repository has to come back through the
              // same path as any other, or the panel would be showing something it invented.
              if (ok) setRescan((n) => n + 1);
            });
          }}
          className="mt-3 h-[26px] rounded-md bg-ink px-2.5 text-[11.5px] font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          初始化仓库
        </button>
      </PanelEmpty>
    );
  }

  const changeCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
       * Which checkout everything below is about.
       *
       * Only when there is a choice to make. One repository with no worktrees is the common case
       * and needs no row telling you so — the branch line underneath already says where you are.
       */}
      {(repos.length > 1 || Object.values(trees).some((list) => list.length > 0)) && (
        <RepoPicker
          repos={repos}
          trees={trees}
          selected={cwd}
          onSelect={setSelected}
        />
      )}

      {/* Where you are, and the two things you do with a remote. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2.5">
        <GitBranch
          size={12.5}
          strokeWidth={1.8}
          className="shrink-0 text-ink-faint"
        />
        <Text size="label" tone="muted" className="min-w-0 truncate">
          <span className="text-ink">{status?.branch ?? "—"}</span>
          {status?.upstream && (
            <span className="pl-1.5 text-ink-faint">{status.upstream}</span>
          )}
        </Text>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <Text size="caption" mono numeric tone="muted" className="shrink-0">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.ahead > 0 && status.behind > 0 && " "}
            {status.behind > 0 && `↓${status.behind}`}
          </Text>
        )}
        <div className="min-w-1 flex-1" />
        <IconButton
          icon={<ArrowDownToLine size={12} strokeWidth={1.9} />}
          label="拉取（--ff-only）"
          size="sm"
          disabled={busy}
          onClick={() => void act(() => window.deepwise.git.pull(cwd))}
        />
        <IconButton
          icon={<ArrowUpFromLine size={12} strokeWidth={1.9} />}
          label="推送"
          size="sm"
          disabled={busy}
          onClick={() => void act(() => window.deepwise.git.push(cwd))}
        />
        <IconButton
          icon={<RefreshCw size={12} strokeWidth={1.9} />}
          label="刷新"
          size="sm"
          disabled={busy}
          onClick={() => void refresh()}
        />
      </div>

      {/* One row of views, counted where a count means something. */}
      <div className="flex shrink-0 items-center gap-0.5 px-1.5 pb-1.5">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setView(entry.id)}
            className={`flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors duration-150 ${
              view === entry.id
                ? "bg-card-hover text-ink"
                : "text-ink-muted hover:bg-card-hover/60"
            }`}
          >
            <entry.icon size={12} strokeWidth={1.8} className="shrink-0" />
            {entry.label}
            {entry.id === "changes" && changeCount > 0 && (
              <span className="text-ink-faint tabular-nums">{changeCount}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-1.5 mb-1.5 shrink-0 rounded-lg border border-danger/25 bg-danger/8 px-2.5 py-1.5">
          <Text
            size="detail"
            tone="danger"
            className="break-words whitespace-pre-wrap"
          >
            {error}
          </Text>
        </div>
      )}

      {view === "changes" && (
        <ChangesView
          status={status}
          cwd={workspace.path}
          busy={busy}
          act={act}
        />
      )}
      {view === "history" && <HistoryView cwd={cwd} />}
      {view === "branches" && (
        <BranchesView
          cwd={cwd}
          status={status}
          busy={busy}
          act={act}
          repos={repos}
          trees={trees}
          onSelectRepo={setSelected}
        />
      )}
    </div>
  );
}
