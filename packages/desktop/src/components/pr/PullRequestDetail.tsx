/**
 * One pull request, in the two views a review actually needs.
 *
 * 摘要 is what it claims to do — the description, who has weighed in, what CI thinks. 代码 is what
 * it does. Keeping them as tabs rather than one long page is what makes the second one usable:
 * a diff is read top to bottom, and it should not start four screens down.
 */

import { ExternalLink, GitPullRequest, Maximize2, MessagesSquare, Minimize2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { PullRequestDetail as Detail } from "../../../electron/ipc-types.ts";
import { relativeTime } from "../git/relative-time.ts";
import { Markdown } from "../Markdown.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { Scroller } from "../Scroller.tsx";
import { PullRequestCode } from "./PullRequestCode.tsx";
import { PullRequestMeta, verdictLabel } from "./PullRequestMeta.tsx";
import { DetailSkeleton } from "./PullRequestSkeleton.tsx";

export type PrTab = "summary" | "code";

export function PullRequestDetail({
	detail,
	loading,
	error,
	onRefresh,
	onOpenChat,
	expanded,
	onToggleExpanded,
	tab,
	onTab,
}: {
	detail: Detail | null;
	loading: boolean;
	error: string | null;
	onRefresh: () => void;
	/** Opens the app's conversation window with something already typed. */
	onOpenChat: (detail: Detail, intent: "ask" | "review") => void;
	/** Whether the list beside this is collapsed, which decides if the title has to be shown here. */
	expanded: boolean;
	onToggleExpanded: () => void;
	/**
	 * Lifted, because the review bar below this belongs to two of these tabs and not the third.
	 * 摘要 and 代码 are things you form an opinion about; 聊天 has a field of its own, and stacking
	 * two composers is not a layout, it is a question about which one you meant.
	 */
	tab: PrTab;
	onTab: (tab: PrTab) => void;
}) {
	const [descriptionOpen, setDescriptionOpen] = useState(true);

	if (error) {
		return <Centered>{error}</Centered>;
	}
	if (!detail) {
		// Loading gets the shape of a pull request; having nothing selected is not a load.
		if (loading) return <DetailSkeleton />;
		return <Centered>选中左边的一个 Pull Request</Centered>;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-1 px-3 py-2">
				{/*
				 * Expanded, the list is gone and with it the only thing saying which pull request this
				 * is. The heading inside the summary does not answer that — it scrolls away, and on
				 * the 代码 tab it was never there. So the title moves up here, and the tabs slide off
				 * the left edge to make room, landing near the centre.
				 */}
				{expanded && (
					<div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
						<GitPullRequest
							size={13.5}
							strokeWidth={1.9}
							className={`shrink-0 ${detail.isDraft ? "text-ink-faint" : "text-ok"}`}
						/>
						<ScrollText text={detail.title} className="min-w-0 text-label text-ink" />
					</div>
				)}

				{(["summary", "code"] as const).map((key) => (
					<button
						key={key}
						type="button"
						onClick={() => onTab(key)}
						className={`h-[26px] rounded-lg px-2.5 text-label transition-colors ${
							tab === key ? "bg-card-hover text-ink" : "text-ink-muted hover:text-ink"
						}`}
					>
						{key === "summary" ? "摘要" : "代码"}
					</button>
				))}

				<div className="flex-1" />

				<IconAction label="重新读取" onClick={onRefresh} spinning={loading}>
					<RefreshCw size={13.5} strokeWidth={1.8} />
				</IconAction>
				<IconAction label="在浏览器中打开" onClick={() => void window.lyra.system.openExternal(detail.url)}>
					<ExternalLink size={13.5} strokeWidth={1.8} />
				</IconAction>

				{/*
				 * Chat and review, in that order, then expand at the very end.
				 *
				 * Both open the same thing — the app's own conversation window — and differ only in
				 * what they put in the composer: 聊天 leaves a question to edit, 让 Agent 审查 leaves
				 * the review request. Expand is last because it is about this pane rather than about
				 * the pull request, and because that is where the eye looks for it.
				 */}
				<button
					type="button"
					onClick={() => onOpenChat(detail, "ask")}
					className="ml-1 flex h-[26px] items-center gap-1.5 rounded-lg px-2.5 text-detail text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
				>
					<MessagesSquare size={12.5} strokeWidth={1.8} />
					聊天
				</button>
				<button
					type="button"
					onClick={() => onOpenChat(detail, "review")}
					className="flex h-[26px] items-center gap-1.5 rounded-lg border border-line px-2.5 text-detail text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
				>
					让 Agent 审查
				</button>
				<IconAction label={expanded ? "显示列表" : "展开占满"} onClick={onToggleExpanded}>
					{expanded ? <Minimize2 size={13} strokeWidth={1.9} /> : <Maximize2 size={13} strokeWidth={1.9} />}
				</IconAction>
			</header>

			{/*
			 * The summary is keyed on the pull request, so switching rebuilds it rather than
			 * mutating it in place.
			 *
			 * Two things fall out of that. The scroll position resets, which it must — landing
			 * halfway down a review you have not opened yet is disorienting. And the content fades
			 * in, so a cached pull request that appears within a single frame still reads as
			 * something arriving rather than as the pane flickering. Opacity only: a transform
			 * counts toward scrollHeight and would drag the scroll position along with it.
			 */}
			{tab === "code" ? (
				<PullRequestCode repo={detail.repo} number={detail.number} />
			) : (
				<Scroller
					key={`${detail.repo}#${detail.number}`}
					className="flex-1"
					contentClassName="ly-fade-in px-5 pt-1 pb-6"
					fadeColor="var(--color-shell)"
				>
					<h1 className="text-heading leading-snug font-semibold tracking-tight text-ink">{detail.title}</h1>
					<p className="pt-1.5 pb-4 text-detail text-ink-faint">
						{detail.author} · {relativeTime(detail.createdAt)} · {detail.repo} #{detail.number}
					</p>

					<PullRequestMeta detail={detail} />

					<section className="pt-5">
						<button
							type="button"
							onClick={() => setDescriptionOpen((open) => !open)}
							aria-expanded={descriptionOpen}
							className="ly-item flex h-7 items-center gap-1.5 rounded-md px-1.5 text-label text-ink"
						>
							描述
							<span className="text-ink-faint">{descriptionOpen ? "▾" : "▸"}</span>
						</button>

						{descriptionOpen &&
							(detail.body.trim() ? (
								<div className="pt-1 pl-1.5">
									<Markdown text={detail.body} className="text-label" />
								</div>
							) : (
								<p className="px-1.5 pt-1 text-label text-ink-faint">作者没有写描述。</p>
							))}
					</section>

					{detail.reviews.length > 0 && (
						<section className="pt-5">
							<h2 className="pb-2 text-label text-ink">审查意见</h2>
							{detail.reviews.map((review, index) => (
								<Entry
									key={`${review.author}-${index}`}
									who={review.author}
									when={review.submittedAt}
									tag={verdictLabel(review.state)}
									body={review.body}
								/>
							))}
						</section>
					)}

					{detail.threads.length > 0 && (
						<section className="pt-5">
							<h2 className="pb-2 text-label text-ink">评论</h2>
							{detail.threads.map((comment, index) => (
								<Entry key={`${comment.author}-${index}`} who={comment.author} when={comment.createdAt} body={comment.body} />
							))}
						</section>
					)}
				</Scroller>
			)}
		</div>
	);
}

/** One person's say, whether it came with a verdict or not. */
function Entry({ who, when, tag, body }: { who: string; when: string; tag?: string; body: string }) {
	return (
		<article className="mb-2 rounded-[10px] border border-line-soft px-3 py-2.5">
			<div className="flex items-baseline gap-2 pb-1">
				<span className="text-detail text-ink">{who}</span>
				{tag && <span className="text-detail text-ink-faint">{tag}</span>}
				<div className="flex-1" />
				<span className="text-detail text-ink-faint">{relativeTime(when)}</span>
			</div>
			{body.trim() ? (
				<Markdown text={body} className="text-label" />
			) : (
				<p className="text-label text-ink-faint">（没有留下文字）</p>
			)}
		</article>
	);
}

function IconAction({
	label,
	onClick,
	spinning,
	children,
}: {
	label: string;
	onClick: () => void;
	spinning?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			aria-label={label}
			onClick={onClick}
			className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
		>
			<span className={spinning ? "ly-spin" : undefined}>{children}</span>
		</button>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center px-6">
			<p className="text-center text-label leading-relaxed text-ink-faint">{children}</p>
		</div>
	);
}
