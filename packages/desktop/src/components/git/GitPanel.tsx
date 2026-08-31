import { Activity, ArrowDownToLine, ArrowUpFromLine, GitBranch, GitCommitHorizontal, GitCompare, RefreshCw, Sparkles, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "../useLiveRefresh.ts";

import type { GitStatus } from "../../../electron/ipc-types.ts";
import type { RepoRef } from "../../../electron/git.ts";
import { IconButton } from "../IconButton.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";

import { Text } from "../Text.tsx";
import { useApp } from "../../store.ts";

import { BranchesView } from "./BranchesView.tsx";
import { ChangesView } from "./ChangesView.tsx";
import { HistoryView } from "./HistoryView.tsx";
import { PipelinesView } from "./PipelinesView.tsx";
import { ReleaseModal } from "./ReleaseModal.tsx";
import { RepoPicker } from "./RepoPicker.tsx";
import { sameStatus } from "./sameStatus.ts";
import { SkeletonList, useSlowLoad } from "../Skeleton.tsx";
import { CountUp } from "../CountUp.tsx";
import { useNarrow } from "../useNarrow.ts";

type View = "changes" | "history" | "branches" | "pipelines";

const VIEWS: { id: View; label: string; icon: typeof GitCompare }[] = [
  { id: "changes", label: "改动", icon: GitCompare },
  { id: "history", label: "历史", icon: GitCommitHorizontal },
  { id: "branches", label: "分支", icon: GitBranch },
  { id: "pipelines", label: "流水线", icon: Activity },
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
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [narrowNav, navRef] = useNarrow(330);

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
      const found = await window.lyra.git.repos(workspacePath);
      const lists = await Promise.all(
        found.map(async (repo) => [repo.path, await window.lyra.git.worktrees(repo.path)] as const),
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

  /*
   * Go and read it, and keep the object we already had when nothing moved.
   *
   * A poll that returns an equal-but-new object is a change as far as React is concerned, so every
   * 1.5s tick re-ran `ChangesView`'s effect — which fetches the whole working-tree diff. That read
   * is slower than the interval it is started on, so the panel spent every turn queued behind
   * itself, which is what "the git panel stutters and takes ages" was. See `sameStatus`.
   */
  const read = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    const next = await window.lyra.git.status(cwd);
    setStatus((current) => (sameStatus(current, next) ? current : next));
  }, [cwd]);

  /*
   * The same read, shared by whoever asks for it at the same moment.
   *
   * Two effects want a status the instant this mounts — the branch watcher below and
   * `useLiveRefresh` — so opening the panel spawned two identical `git status` processes and raced
   * their answers.
   *
   * Deliberately *not* what `act` uses. Sharing is only correct for callers that want "a status",
   * and an operation that has just staged a file wants "the status *after* that" — handing it a
   * read already in flight when the click landed would show the list from before its own change.
   */
  const inflight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current;
    const flight = read().finally(() => {
      inflight.current = null;
    });
    inflight.current = flight;
    return flight;
  }, [read]);

  /*
   * Re-read from scratch when the checkout moves under us, and say so while it happens.
   *
   * Switching branch changes every answer this panel gives, and `git status` on a large repository
   * takes long enough to notice — during which the list on screen belongs to the branch you just
   * left. Showing the old branch's files under the new branch's name is worse than showing
   * nothing: it is wrong, and nothing about it says so.
   *
   * Only on a real move. The poll behind `useLiveRefresh` runs every 1.5s while a turn works, and
   * flashing a skeleton at that rate would make the panel unreadable — those re-reads replace the
   * list in place, which is right for "the agent just edited a file".
   */
  const branch = workspace?.branch ?? null;
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    setSwitching(true);
    void refresh().finally(() => {
      if (alive) setSwitching(false);
    });
    return () => {
      alive = false;
    };
  }, [cwd, branch, refresh]);

  /*
   * Live while the agent works, not once it has finished.
   *
   * The edits this panel exists to show arrive throughout a turn, and re-reading only when the turn
   * settled meant watching an agent rewrite a file and seeing nothing here for minutes. See
   * `useLiveRefresh` for why this polls rather than listening to tool results.
   */
  useLiveRefresh(refresh, running);

  /** Wraps an operation so every one of them reports the same way and re-reads after. */
  const act = useCallback(
    async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      setError(null);
      const result = await operation();
      if (!result.ok) setError(result.error ?? "操作失败");
      // `read`, not `refresh`: this one has to see what the operation just did — see above.
      await read();
      setBusy(false);
      return result.ok;
    },
    [read],
  );

  /*
   * Above every early return, because it is a hook.
   *
   * There are three exits below this line — no workspace, still scanning, no checkout — and a hook
   * placed after them runs on some renders and not others. React counts hooks per render and
   * refuses a count that changes: switching between conversations flips `workspace` and `scanning`
   * often enough that clicking down a list of them was enough to take the window out with
   * "Rendered fewer hooks than expected" (#310).
   *
   * Nothing below needs it before this point, and computing a count from a null status is free.
   */
  const changeCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);
  /*
   * Nothing is known yet: the repositories are still being found, or the one that was found has
   * not answered about its state.
   *
   * Both are the same situation and the panel has to treat them alike, which it did not. Once the
   * scan finished it drew the whole panel from a null status, so a repository with two hundred
   * uncommitted files announced 「工作区干净 · 没有未提交的改动」 and took it back 76ms later —
   * measured, frame by frame. A wrong answer stated confidently is worse than no answer, and the
   * count above the tabs then travelled up from zero as though two hundred files had just been
   * changed while you watched.
   */
  const unread = scanning || (cwd !== null && status === null);
  /*
   * A placeholder only for a wait long enough to be one.
   *
   * These reads are now fast enough to finish inside a couple of frames on an ordinary repository,
   * and a skeleton that appears and goes in 70ms is a flicker — which reads as a glitch, not as
   * progress. `useSlowLoad` holds it back until the wait is real; under the threshold the panel
   * simply arrives.
   */
  const slowUnread = useSlowLoad(unread);
  const slowSwitch = useSlowLoad(switching);

  if (!workspace) {
    return (
      <PanelEmpty icon={GitBranch} title="Git">
        先打开一个项目。
      </PanelEmpty>
    );
  }

  /*
   * Say nothing until there is something to say — but draw the shape of it.
   *
   * This used to be a bare `<div className="flex-1" />` while the scan ran: an empty rectangle for
   * however long it took, then a fully populated panel in one frame, with nothing in between to
   * say a load was happening. The skeleton stands in the same boxes the rows will occupy, so the
   * arrival is the content landing rather than the layout appearing.
   *
   * Under `useSlowLoad`'s threshold there is still nothing, deliberately: a wait nobody noticed
   * should not be announced.
   */
  if (unread) {
    return slowUnread ? (
      <div className="ly-enter flex-1 px-1.5 pt-2">
        <SkeletonList count={5} label="正在读取仓库" />
      </div>
    ) : (
      <div className="flex-1" />
    );
  }

  /*
   * git could not answer, which is not the same as answering no.
   *
   * The panel used to draw the sentence below for both, so a repository git had refused to read —
   * one owned by another user, or with no git on the path at all — was described as having no
   * version control, under a button offering to initialise it. Two wrong claims and one dangerous
   * suggestion. When the main process could not get an answer it now says what stopped it and
   * offers to have the Agent diagnose/fix it rather than misleading the user.
   */
  if (workspace.gitProblem) {
    return (
      <PanelEmpty icon={GitBranch} title="Git 仓库异常">
        <span className="block text-ink-muted">{workspace.gitProblem}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            useApp
              .getState()
              .setComposerDraft(
                `当前项目的 Git 状态异常，无法正常读取仓库信息。\n报错详情：${workspace.gitProblem}\n\n请帮我分析原因并修复此 Git 问题（例如检查 PATH、目录安全配置 safe.directory、或者修复损坏的索引等）。`,
                true,
              );
          }}
          className="mt-3 flex h-[28px] items-center gap-1.5 rounded-md bg-ink px-3 text-detail font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Sparkles size={13} strokeWidth={2} />
          让 Agent 诊断并修复
        </button>
      </PanelEmpty>
    );
  }

  if (!cwd) {
    return (
      <PanelEmpty icon={GitBranch} title="未检测到 Git 仓库">
        <span className="block text-ink-muted">当前目录尚未建立 Git 版本控制。</span>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void act(() => window.lyra.git.init(workspace.path)).then((ok) => {
                // Re-scan rather than assume: the new repository has to come back through the
                // same path as any other, or the panel would be showing something it invented.
                if (ok) setRescan((n) => n + 1);
              });
            }}
            className="h-[28px] rounded-md bg-ink px-3 text-detail font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            初始化仓库
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              useApp
                .getState()
                .setComposerDraft(
                  `请帮我检查当前目录（${workspace.path}）的 Git 仓库状态，并协助我完成 Git 版本控制的初始化与初始提交配置。`,
                  true,
                );
            }}
            className="flex h-[28px] items-center gap-1.5 rounded-md border border-line bg-card px-3 text-detail font-medium text-ink transition-colors hover:bg-card-hover disabled:opacity-40"
          >
            <Sparkles size={13} strokeWidth={2} className="text-accent" />
            让 Agent 处理
          </button>
        </div>
      </PanelEmpty>
    );
  }

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
          {status?.branch && <span className="text-ink">{status.branch}</span>}
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
          onClick={() => void act(() => window.lyra.git.pull(cwd))}
        />
        <IconButton
          icon={<ArrowUpFromLine size={12} strokeWidth={1.9} />}
          label="推送"
          size="sm"
          disabled={busy}
          onClick={() => void act(() => window.lyra.git.push(cwd))}
        />
        <IconButton
          icon={<RefreshCw size={12} strokeWidth={1.9} />}
          label="刷新"
          size="sm"
          disabled={busy}
          // Pressing 刷新 means "go and look now", so it never rides on a read already in flight.
          onClick={() => void read()}
        />
        <IconButton
          icon={<Tag size={12} strokeWidth={1.9} />}
          label="发版 (Release)"
          size="sm"
          disabled={busy}
          onClick={() => setReleaseOpen(true)}
        />
      </div>

      {/* One row of views, counted where a count means something. */}
      <div ref={navRef} className="flex shrink-0 items-center gap-0.5 px-1.5 pb-1.5">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-ly-tip={narrowNav ? `${entry.label}${entry.id === "changes" && changeCount > 0 ? ` (${changeCount})` : ""}` : undefined}
            onClick={() => setView(entry.id)}
            className={`flex h-[26px] shrink-0 items-center gap-1.5 rounded-md text-detail transition-colors duration-[var(--ly-t-quick)] ${
              narrowNav ? "px-2" : "px-2.5"
            } ${
              view === entry.id
                ? "bg-card-hover text-ink"
                : "text-ink-muted hover:bg-card-hover/60"
            }`}
          >
            <entry.icon size={12.5} strokeWidth={1.8} className="shrink-0" />
            {!narrowNav && <span className="truncate">{entry.label}</span>}
            {entry.id === "changes" && changeCount > 0 && (
              <CountUp value={changeCount} className="text-ink-faint tabular-nums" />
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

      {/*
       * Keyed on the branch, so a switch replays the entry animation.
       *
       * Without it the list simply contains different files a moment later, with nothing to say
       * that the ground moved — which is the one thing worth signalling when the branch changed
       * underneath it. Re-mounting is affordable here: the view holds no scroll position or
       * selection worth carrying across a branch it no longer belongs to.
       */}
      {view === "changes" && (
        <ChangesView
          key={status?.branch ?? "detached"}
          loading={slowSwitch}
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
      {view === "pipelines" && (
        <PipelinesView
          cwd={cwd}
          onOpenRelease={() => setReleaseOpen(true)}
        />
      )}

      {releaseOpen && (
        <ReleaseModal
          cwd={workspace.path}
          onClose={() => {
            setReleaseOpen(false);
            void read();
          }}
        />
      )}
    </div>
  );
}
