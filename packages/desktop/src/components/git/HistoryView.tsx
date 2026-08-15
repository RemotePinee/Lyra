/**
 * What has already happened, with the graph beside it.
 */
import { GitCommitHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitCommit, WorkspaceDiffFile } from "../../../electron/ipc-types.ts";

import { PanelEmpty } from "../PanelEmpty.tsx";

import { Scroller } from "../Scroller.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { Text } from "../Text.tsx";

import { CommitGraph, LANE_WIDTH } from "./CommitGraph.tsx";
import { FileDiffList } from "./FileDiffList.tsx";
import { buildGraph, graphWidth } from "./graph.ts";
import { relativeTime } from "./relative-time.ts";

/** Fixed, because the graph has to know it to line its strokes up across rows. */
const ROW_HEIGHT = 46;

/**
 * The log, drawn as the graph it is.
 *
 * A flat list of subjects cannot answer the questions people actually bring to a history: where
 * did this branch off, when did it come back, what was on main while this was happening. Those
 * are shape, not text — so the shape is drawn. Each lane keeps one colour from the commit that
 * starts it to the merge that ends it, which is what makes a column followable.
 */
export function HistoryView({ cwd }: { cwd: string }) {
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
