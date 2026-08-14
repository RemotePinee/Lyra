import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitBranchPlus,
  GitCompare,
  FolderGit2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  GitCommit,
  GitStatus,
  WorkspaceDiffFile,
} from "../../../electron/ipc-types.ts";
import type { BranchList, RepoRef } from "../../../electron/git.ts";
import { IconButton } from "../IconButton.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";
import { MenuItem, Popover, usePopover } from "../Popover.tsx";
import { Scroller } from "../Scroller.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { Text } from "../Text.tsx";
import { useApp } from "../../store.ts";
import { CommitGraph, LANE_WIDTH } from "./CommitGraph.tsx";
import { FileDiffList } from "./FileDiffList.tsx";
import { buildGraph, graphWidth } from "./graph.ts";

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
  useEffect(() => {
    if (!workspace) {
      setRepos([]);
      setTrees({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const found = await window.deepwise.git.repos(workspace.path);
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
        const reachable = [...roots.map((r) => r.path), ...[...claimed]];
        return current && reachable.includes(current) ? current : (roots[0]?.path ?? null);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.path]);

  const cwd = selected ?? workspace?.path ?? null;

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

  if (!workspace || !cwd) {
    return (
      <PanelEmpty icon={GitBranch} title="Git">
        {workspace ? "这个项目里没有找到 Git 仓库。" : "先打开一个项目。"}
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

type Act = (
  operation: () => Promise<{ ok: boolean; error?: string }>,
) => Promise<boolean>;

/**
 * Staged above unstaged, with the commit box under both.
 *
 * The split is the whole reason to have an index in front of you: the top group is what the
 * next commit will contain, the bottom is what it will not. Reading down the column is reading
 * the commit you are about to make.
 */
function ChangesView({
  status,
  cwd,
  busy,
  act,
}: {
  status: GitStatus | null;
  cwd: string;
  busy: boolean;
  act: Act;
}) {
  const [message, setMessage] = useState("");
  const [staged, setStaged] = useState<WorkspaceDiffFile[]>([]);
  const [unstaged, setUnstaged] = useState<WorkspaceDiffFile[]>([]);

  /*
   * Two diffs, matching the two groups.
   *
   * The staged side is the index against HEAD and the unstaged side the working tree against
   * the index — the same split git itself makes. Fetched here rather than in the parent so a
   * staging click re-reads only what it changed.
   */
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.deepwise.git.diffRefs(cwd, "HEAD", null),
      window.deepwise.diff.workspaceDiff(cwd),
    ]).then(([indexDiff, treeDiff]) => {
      if (!live) return;
      const stagedPaths = new Set(
        status?.staged.map((file) => file.path) ?? [],
      );
      const unstagedPaths = new Set(
        status?.unstaged.map((file) => file.path) ?? [],
      );
      setStaged(indexDiff.files.filter((file) => stagedPaths.has(file.path)));
      setUnstaged(
        treeDiff.files.filter((file) => unstagedPaths.has(file.path)),
      );
    });
    return () => {
      live = false;
    };
  }, [cwd, status]);

  const stagedPaths = status?.staged.map((file) => file.path) ?? [];
  const unstagedPaths = status?.unstaged.map((file) => file.path) ?? [];
  const nothing = stagedPaths.length === 0 && unstagedPaths.length === 0;

  async function commit() {
    const ok = await act(() => window.deepwise.git.commitStaged(cwd, message));
    if (ok) setMessage("");
  }

  if (nothing) {
    return (
      <PanelEmpty icon={Check} title="工作区干净">
        没有未提交的改动。
      </PanelEmpty>
    );
  }

  return (
    <>
      <Scroller className="flex-1" contentClassName="px-1.5 pb-2" fade={false}>
        {stagedPaths.length > 0 && (
          <GroupHeader
            label="已暂存"
            count={stagedPaths.length}
            action="取消全部"
            disabled={busy}
            onAction={() =>
              void act(() => window.deepwise.git.unstage(cwd, stagedPaths))
            }
          />
        )}
        {stagedPaths.length > 0 && (
          <FileDiffList
            files={staged}
            actions={(file) => (
              <IconButton
                icon={<Minus size={12} strokeWidth={1.9} />}
                label="取消暂存"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() => window.deepwise.git.unstage(cwd, [file.path]))
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
              void act(() => window.deepwise.git.stage(cwd, unstagedPaths))
            }
          />
        )}
        {unstagedPaths.length > 0 && (
          <FileDiffList
            files={unstaged}
            actions={(file) => (
              <>
                <IconButton
                  icon={<RotateCcw size={12} strokeWidth={1.9} />}
                  label="放弃改动"
                  size="sm"
                  tone="danger"
                  disabled={busy}
                  onClick={() => {
                    // Deleting an untracked file is not something to do on one click.
                    if (
                      window.confirm(
                        `放弃 ${file.path} 的改动？此操作不可撤销。`,
                      )
                    ) {
                      void act(() =>
                        window.deepwise.git.discard(cwd, [file.path]),
                      );
                    }
                  }}
                />
                <IconButton
                  icon={<Plus size={12} strokeWidth={1.9} />}
                  label="暂存"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() => window.deepwise.git.stage(cwd, [file.path]))
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
          className="block w-full resize-none rounded-lg border border-line bg-input px-2.5 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink-faint"
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
            className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12px] font-medium text-shell transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            <Check size={12} strokeWidth={2.2} />
            提交
          </button>
        </div>
      </div>
    </>
  );
}

function GroupHeader({
  label,
  count,
  action,
  disabled,
  onAction,
}: {
  label: string;
  count: number;
  action: string;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1 pt-2 pb-1">
      <Text size="caption" tone="faint" weight="medium">
        {label}
      </Text>
      <Text size="caption" tone="faint" numeric>
        {count}
      </Text>
      <div className="min-w-1 flex-1" />
      <button
        type="button"
        disabled={disabled}
        onClick={onAction}
        className="rounded px-1 text-[11px] text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
      >
        {action}
      </button>
    </div>
  );
}

/**
 * The log, drawn as the graph it is.
 *
 * A flat list of subjects cannot answer the questions people actually bring to a history: where
 * did this branch off, when did it come back, what was on main while this was happening. Those
 * are shape, not text — so the shape is drawn. Each lane keeps one colour from the commit that
 * starts it to the merge that ends it, which is what makes a column followable.
 */
function HistoryView({ cwd }: { cwd: string }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiffFile[]>([]);

  useEffect(() => {
    void window.deepwise.git.log(cwd, 80).then(setCommits);
  }, [cwd]);

  useEffect(() => {
    if (!open) return setDiff([]);
    let live = true;
    void window.deepwise.git
      .commitDiff(cwd, open)
      .then((result) => live && setDiff(result.files));
    return () => {
      live = false;
    };
  }, [cwd, open]);

  const rows = useMemo(() => buildGraph(commits), [commits]);
  const width = useMemo(() => graphWidth(rows, LANE_WIDTH), [rows]);

  if (commits.length === 0) {
    return (
      <PanelEmpty icon={GitCommitHorizontal} title="没有提交">
        这个仓库还没有任何提交。
      </PanelEmpty>
    );
  }

  return (
    <Scroller className="flex-1" contentClassName="px-1.5 pb-2" fade={false}>
      {rows.map((row) => {
        const commit = row.commit;
        const expanded = open === commit.sha;
        return (
          <div key={commit.sha}>
            {/*
             * The graph column and the text share a row, and the graph is told the row's height
             * so its lines meet the ones above and below exactly.
             */}
            <div className="flex items-stretch">
              <CommitGraph row={row} height={ROW_HEIGHT} width={width} />
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : commit.sha)}
                aria-expanded={expanded}
                style={{ height: ROW_HEIGHT }}
                /* `dw-scroll` is what lets the subject scroll on hover — the marquee keys off an
                 * ancestor carrying it, which is why the same component scrolls in the sidebar
                 * and merely clipped here. */
                className="dw-scroll flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-card-hover"
              >
                <span className="min-w-0 flex-1">
                  {/*
                   * Scrolled on hover rather than cut off. A commit subject is the one line that
                   * says what a commit was for, and the useful half is regularly past the ellipsis
                   * — the same reason session titles in the sidebar scroll instead of truncating.
                   */}
                  <ScrollText text={commit.subject} className="dw-fade-tail block text-[12.5px]" />
                  <span className="flex items-center gap-1.5">
                    <Text size="caption" tone="faint" mono>
                      {commit.shortSha}
                    </Text>
                    <Text size="caption" tone="faint" className="truncate">
                      {commit.author} · {relativeTime(commit.date)}
                    </Text>
                  </span>
                </span>
                {/*
                 * Badges give way before the subject does.
                 *
                 * A branch name like `origin/fix/forwarded-chain-diagnostics` is wider than half
                 * this panel, and as an unshrinkable box it pushed the whole row past the panel's
                 * edge — subject, refs and all, running out of the window. They shrink three times
                 * as readily as the subject, so the line stays inside and the name that got cut is
                 * a hover away.
                 */}
                {commit.refs.length > 0 && (
                  <span className="flex min-w-0 shrink-[3] gap-1 overflow-hidden">
                    {commit.refs.slice(0, 2).map((ref) => (
                      <Text
                        key={ref}
                        size="caption"
                        tone="muted"
                        title={ref}
                        className="max-w-[132px] shrink truncate rounded border border-line px-1 py-px"
                      >
                        {ref}
                      </Text>
                    ))}
                  </span>
                )}
              </button>
            </div>
            {expanded && (
              <div className="dw-enter mb-1.5" style={{ marginLeft: width }}>
                <FileDiffList
                  files={diff}
                  emptyLabel="正在读取这次提交的改动…"
                />
              </div>
            )}
          </div>
        );
      })}
    </Scroller>
  );
}

/** Fixed, because the graph has to know it to line its strokes up across rows. */
const ROW_HEIGHT = 46;

/**
 * Branches, and the diff between any two of them.
 *
 * Comparison is the reason this view exists rather than a switcher in a menu: "how does mine
 * differ from main" is a question you ask before merging, and answering it anywhere else means
 * leaving the app for a terminal.
 */
function BranchesView({
  cwd,
  status,
  busy,
  act,
  repos,
  trees,
  onSelectRepo,
}: {
  cwd: string;
  status: GitStatus | null;
  busy: boolean;
  act: Act;
  repos: RepoRef[];
  trees: Record<string, RepoRef[]>;
  onSelectRepo: (path: string) => void;
}) {
  const [branches, setBranches] = useState<BranchList>({
    current: null,
    local: [],
    remote: [],
  });
  const [compare, setCompare] = useState<{ base: string; head: string } | null>(
    null,
  );
  const [diff, setDiff] = useState<{
    files: WorkspaceDiffFile[];
    added: number;
    removed: number;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  /** Repositories and their worktrees, flattened in display order. */
  const checkouts = repos.flatMap((repo) => [repo, ...(trees[repo.path] ?? [])]);

  const load = useCallback(() => {
    void window.deepwise.git.branches(cwd).then(setBranches);
  }, [cwd]);

  useEffect(load, [load, status?.branch]);

  useEffect(() => {
    if (!compare) return setDiff(null);
    let live = true;
    void window.deepwise.git
      .diffRefs(cwd, compare.base, compare.head)
      .then((result) => live && setDiff(result));
    return () => {
      live = false;
    };
  }, [cwd, compare]);

  const current = branches.current;
  /*
   * The upstream belongs in this list even though the switcher filters it out.
   *
   * `listBranches` drops remote branches that already have a local counterpart, which is right
   * for a switcher — checking out `origin/main` when you have `main` is a detached head nobody
   * asked for. But "what do I have that the remote does not" is the most common comparison
   * there is, and dropping the upstream makes it the one comparison you cannot run.
   */
  const remotes =
    status?.upstream && !branches.remote.includes(status.upstream)
      ? [status.upstream, ...branches.remote]
      : branches.remote;

  return (
    <Scroller className="flex-1" contentClassName="px-1.5 pb-2" fade={false}>
      {compare ? (
        <>
          <div className="flex items-center gap-1.5 px-1 py-1.5">
            <button
              type="button"
              onClick={() => setCompare(null)}
              className="rounded px-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
            >
              ← 返回
            </button>
            <Text size="label" tone="muted" className="min-w-0 truncate">
              <span className="text-ink">{compare.base}</span>
              <span className="px-1 text-ink-faint">→</span>
              <span className="text-ink">{compare.head}</span>
            </Text>
            {diff && (
              <Text size="caption" mono numeric className="ml-auto shrink-0">
                <span className="text-ok">+{diff.added}</span>{" "}
                <span className="text-danger">−{diff.removed}</span>
              </Text>
            )}
          </div>
          <FileDiffList
            files={diff?.files ?? []}
            emptyLabel={diff ? "两个分支没有差异" : "正在比较…"}
          />
        </>
      ) : (
        <>
          {/*
           * Every checkout in the workspace, before its branches.
           *
           * A repository's branches only make sense once you know which repository you are
           * looking at, and a folder someone opened may hold several — plus a worktree for each,
           * which is a further checkout of the same history on another branch. This list used to
           * exist only as a picker in the panel's title row, where it went unnoticed twice; the
           * question "where am I working" belongs on the page that answers "on what branch".
           */}
          {checkouts.length > 1 && (
            <>
              <GroupHeader label="工作区" count={checkouts.length} action="" disabled onAction={() => {}} />
              {checkouts.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  data-dw-tip={entry.path}
                  onClick={() => onSelectRepo(entry.path)}
                  className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 text-left transition-colors ${
                    entry.worktree ? "pl-5" : "pl-1.5"
                  } ${entry.path === cwd ? "bg-card-hover" : "hover:bg-card-hover"}`}
                >
                  {entry.worktree ? (
                    <GitBranchPlus size={12} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
                  ) : (
                    <FolderGit2 size={12} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
                  )}
                  {/* The name identifies the checkout; the branch qualifies it. Names keep their
                   * width and branches give theirs up, or `CliRelay-wt-audit` becomes `CliR…`. */}
                  <Text size="label" tone={entry.path === cwd ? "default" : "muted"} className="min-w-0 shrink truncate">
                    {entry.label}
                  </Text>
                  <Text size="caption" tone="faint" className="ml-auto min-w-0 shrink-[4] truncate">
                    {entry.branch ?? "游离 HEAD"}
                  </Text>
                  {entry.path === cwd && <Check size={12} strokeWidth={2.2} className="shrink-0 text-accent" />}
                </button>
              ))}
            </>
          )}

          <GroupHeader
            label="本地"
            count={branches.local.length}
            action={creating ? "取消" : "新建"}
            disabled={busy}
            onAction={() => {
              setCreating(!creating);
              setName("");
            }}
          />

          {creating && (
            <form
              className="flex items-center gap-1.5 px-1 pb-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() =>
                  window.deepwise.git.createBranch(cwd, name),
                ).then((ok) => {
                  if (ok) {
                    setCreating(false);
                    setName("");
                    load();
                  }
                });
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="新分支名"
                className="h-[26px] min-w-0 flex-1 rounded-md border border-line bg-input px-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-ink-faint"
              />
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="h-[26px] shrink-0 rounded-md bg-ink px-2.5 text-[11.5px] font-medium text-shell disabled:opacity-40"
              >
                创建并切换
              </button>
            </form>
          )}

          {branches.local.map((branch) => (
            <BranchRow
              key={branch}
              name={branch}
              current={branch === current}
              busy={busy}
              onSwitch={() =>
                void act(() => window.deepwise.git.switchBranch(cwd, branch))
              }
              onCompare={
                current && branch !== current
                  ? () => setCompare({ base: branch, head: current })
                  : undefined
              }
              onDelete={
                branch === current
                  ? undefined
                  : () => {
                      if (window.confirm(`删除分支 ${branch}？`)) {
                        void act(() =>
                          window.deepwise.git.deleteBranch(cwd, branch),
                        ).then(load);
                      }
                    }
              }
            />
          ))}

          {remotes.length > 0 && (
            <GroupHeader
              label="远程"
              count={remotes.length}
              action=""
              disabled
              onAction={() => {}}
            />
          )}
          {remotes.map((branch) => (
            <BranchRow
              key={branch}
              name={branch}
              current={false}
              busy={busy}
              remote
              onSwitch={() =>
                void act(() => window.deepwise.git.switchBranch(cwd, branch))
              }
              onCompare={
                current
                  ? () => setCompare({ base: branch, head: current })
                  : undefined
              }
            />
          ))}
        </>
      )}
    </Scroller>
  );
}

function BranchRow({
  name,
  current,
  busy,
  remote,
  onSwitch,
  onCompare,
  onDelete,
}: {
  name: string;
  current: boolean;
  busy: boolean;
  remote?: boolean;
  onSwitch: () => void;
  onCompare?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="group/branch flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-card-hover">
      <GitBranch
        size={12}
        strokeWidth={1.8}
        className={`shrink-0 ${current ? "text-accent" : "text-ink-faint"}`}
      />
      <Text
        size="label"
        tone={current ? "default" : "muted"}
        className="min-w-0 flex-1 truncate"
      >
        {name}
      </Text>
      {current ? (
        <Text size="caption" tone="faint" className="shrink-0 pr-1">
          当前
        </Text>
      ) : (
        /*
         * Revealed on hover, like the archive control in the sidebar's session list.
         * Three permanent buttons per row would turn a list you read into a control panel.
         */
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/branch:opacity-100 focus-within:opacity-100">
          {onCompare && (
            <IconButton
              icon={<GitCompare size={12} strokeWidth={1.9} />}
              label="与当前分支比较"
              size="sm"
              onClick={onCompare}
            />
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onSwitch}
            className="h-[22px] rounded px-1.5 text-[11px] text-ink-muted transition-colors hover:bg-elevated hover:text-ink disabled:opacity-40"
          >
            {remote ? "检出" : "切换"}
          </button>
          {onDelete && (
            <IconButton
              icon={<Trash2 size={12} strokeWidth={1.9} />}
              label="删除分支"
              size="sm"
              tone="danger"
              onClick={onDelete}
            />
          )}
        </span>
      )}
    </div>
  );
}

/** Coarse on purpose: the exact minute of a commit is never the question in a list. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * The repository this panel is looking at, and everywhere else it could look.
 *
 * A workspace is a folder someone opened. Plenty of them hold several repositories — a frontend
 * beside a backend, services versioned apart on purpose — and any repository may have worktrees,
 * which are further checkouts of the same history on other branches. All of it was being found
 * and none of it was reachable: the panel picked whichever repository sorted first and gave no
 * way to say otherwise.
 *
 * Worktrees are nested under the repository they belong to rather than listed as peers, because
 * that is what they are. Sharing one history is the whole point of a worktree, and a flat list
 * would put two checkouts of the same project side by side as though they were separate work.
 */
function RepoPicker({
  repos,
  trees,
  selected,
  onSelect,
}: {
  repos: RepoRef[];
  trees: Record<string, RepoRef[]>;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const menu = usePopover();
  const everything = repos.flatMap((repo) => [repo, ...(trees[repo.path] ?? [])]);
  const current = everything.find((entry) => entry.path === selected) ?? repos[0];
  const total = everything.length;

  return (
    <>
      <button
        type="button"
        onClick={menu.toggle}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        data-dw-tip={`${repos.length} 个仓库${
          total > repos.length ? ` · ${total - repos.length} 个工作树` : ""
        } · 点击切换`}
        data-dw-tip-side="bottom"
        className={`dw-scroll flex h-8 shrink-0 items-center gap-1.5 border-b border-line-soft px-2.5 text-left transition-colors ${
          menu.open ? "bg-card-hover" : "hover:bg-card-hover"
        }`}
      >
        {current?.worktree ? (
          <GitBranchPlus size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
        ) : (
          <Folder size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
        )}
        <ScrollText text={current?.label ?? "仓库"} className="dw-fade-tail min-w-0 flex-1 text-[12.5px]" />
        {/* A bare total says nothing about what it counts; the split does. */}
        <Text size="caption" tone="faint" className="shrink-0 tabular-nums">
          {repos.length}
          {total > repos.length && <span className="pl-1">+{total - repos.length}</span>}
        </Text>
        <ChevronDown size={12} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
      </button>

      {menu.open && (
        <Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width={264}>
          {/*
           * The app's own menu parts, not a hand-rolled list.
           *
           * This was a bare scrolling div with rows built here — which meant its own row height,
           * its own padding and a scrollbar the rest of the app does not show, sitting a few
           * pixels away from menus that had all three settled long ago. `Scroller` brings the
           * hidden bar and the faded edge; `MenuItem` brings the two-line row this needs anyway.
           */}
          <Scroller className="max-h-[min(320px,44vh)]" contentClassName="p-1" fadeColor="var(--color-float)">
            {repos.map((repo) => (
              <div key={repo.path}>
                <MenuItem
                  icon={<Folder size={13} strokeWidth={1.8} />}
                  detail={repo.branch ?? "游离 HEAD"}
                  selected={repo.path === selected}
                  title={repo.path}
                  trailing={repo.path === selected ? <Check size={12.5} strokeWidth={2.2} /> : undefined}
                  onClick={() => {
                    onSelect(repo.path);
                    menu.close();
                  }}
                >
                  {repo.label}
                </MenuItem>
                {(trees[repo.path] ?? []).map((tree) => (
                  <MenuItem
                    key={tree.path}
                    // A worktree is a checkout of the repository above it; the mark says which.
                    icon={<GitBranchPlus size={13} strokeWidth={1.8} />}
                    detail={tree.branch ?? "游离 HEAD"}
                    selected={tree.path === selected}
                    title={tree.path}
                    trailing={tree.path === selected ? <Check size={12.5} strokeWidth={2.2} /> : undefined}
                    onClick={() => {
                      onSelect(tree.path);
                      menu.close();
                    }}
                  >
                    {tree.label}
                  </MenuItem>
                ))}
              </div>
            ))}
          </Scroller>
        </Popover>
      )}
    </>
  );
}

