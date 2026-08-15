/**
 * How long ago, in the units a person would use.
 */

/** Coarse on purpose: the exact minute of a commit is never the question in a list. */
export function relativeTime(iso: string): string {
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
