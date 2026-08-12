import { ExternalLink, GitPullRequest, RefreshCw } from "lucide-react";
import { ScrollText } from "./ScrollText.tsx";
import { useCallback, useEffect, useState } from "react";
import type { PullRequestSummary } from "../../electron/ipc-types.ts";
import { Scroller } from "./Scroller.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

export function PullRequestsView() {
	const workspace = useApp((s) => s.workspace);
	const send = useApp((s) => s.send);
	const setView = useApp((s) => s.setView);
	const { compact } = useLayout();
	const [items, setItems] = useState<PullRequestSummary[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async () => {
		if (!workspace) return;
		setLoading(true);
		try {
			const result = await window.deepwise.git.pullRequests(workspace.path);
			setItems(result.pullRequests);
			setError(result.error ?? null);
		} finally {
			setLoading(false);
		}
	}, [workspace]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Scroller className="flex-1" contentClassName={`mx-auto w-full max-w-[880px] py-6 ${compact ? "px-4" : "px-8"}`}>
				<header className="flex flex-wrap items-start justify-between gap-3 pb-6">
					<div>
						<h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink">拉取请求</h1>
						<p className="mt-1.5 text-[12.5px] text-ink-muted">
							{workspace ? `${workspace.name} · 通过 gh CLI 读取` : "先选择一个项目"}
						</p>
					</div>
					<button
						type="button"
						title="刷新"
						onClick={() => void refresh()}
						className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
					>
						<RefreshCw size={14} strokeWidth={1.8} className={loading ? "dw-spin" : undefined} />
					</button>
				</header>

				{error && (
					<div className="mb-4 rounded-[10px] border border-accent/35 bg-accent/8 px-3.5 py-2.5 text-[12.5px] text-accent">
						{error}
					</div>
				)}

				{!error && items.length === 0 && !loading && (
					<p className="py-16 text-center text-[13px] text-ink-faint">没有开放中的拉取请求</p>
				)}

				<div className="space-y-2">
					{items.map((pr) => (
						<div key={pr.number} className="dw-scroll dw-enter rounded-[10px] border border-line bg-card/40 px-4 py-3">
							<div className="flex items-center gap-2">
								<GitPullRequest
									size={14}
									strokeWidth={1.9}
									className={pr.isDraft ? "shrink-0 text-ink-faint" : "shrink-0 text-ok"}
								/>
								<ScrollText text={pr.title} className="min-w-0 flex-1 text-[13.5px] text-ink" />
								<span className="shrink-0 font-mono text-[11.5px] text-ink-faint">#{pr.number}</span>
								<button
									type="button"
									title="在浏览器中打开"
									onClick={() => void window.deepwise.system.openExternal(pr.url)}
									className="shrink-0 text-ink-faint transition-colors hover:text-ink"
								>
									<ExternalLink size={13} strokeWidth={1.8} />
								</button>
							</div>

							<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
								<span>{pr.author}</span>
								<span className="font-mono">{pr.headRefName}</span>
								<span className="font-mono">
									<span className="text-ok">+{pr.additions}</span> <span className="text-danger">-{pr.deletions}</span>
								</span>
								{pr.isDraft && <span className="rounded bg-card px-1.5 py-0.5">草稿</span>}
								<div className="flex-1" />
								<button
									type="button"
									onClick={() => {
										setView("chat");
										void send([
											{
												type: "text",
												text: `审查 PR #${pr.number}「${pr.title}」（分支 ${pr.headRefName}）。用 gh pr diff ${pr.number} 拿到改动，指出其中的缺陷和风险，按严重程度排序。不要切换分支。`,
											},
										]);
									}}
									className="rounded-md px-2 py-0.5 text-[11.5px] text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
								>
									让 Agent 审查
								</button>
							</div>
						</div>
					))}
				</div>
			</Scroller>
		</div>
	);
}
