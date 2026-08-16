/**
 * Reviewing pull requests: the list beside the one you are reading.
 *
 * Two panes rather than a page per pull request, because reviewing is a pass over several of them
 * — you skim, open, decide, move on. Losing the list on every open turns three decisions into six
 * navigations.
 *
 * Narrow, the two become one: the list until something is chosen, then the detail with a way back.
 * A 300px list beside a 300px diff is worse than either alone.
 */

import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import type { PullRequestDetail as Detail } from "../../electron/ipc-types.ts";
import { useLayout } from "../layout.tsx";
import { usePrChat } from "../prChatStore.ts";
import { PullRequestDetail, type PrTab } from "./pr/PullRequestDetail.tsx";
import { PullRequestList } from "./pr/PullRequestList.tsx";
import { ReviewBar } from "./pr/ReviewBar.tsx";
import { usePullRequests } from "./pr/usePullRequests.ts";

/** Wide enough for a title and a repository name without either becoming an ellipsis. */
const LIST_WIDTH = 300;

export function PullRequestsView() {
	const { compact } = useLayout();
	/*
	 * Reviewing happens in two postures, and the list is only wanted in one of them.
	 *
	 * Choosing what to review needs the list; reading a diff needs the width — a 300px column of
	 * titles is dead space beside code that is wrapping because of it. Per-visit rather than a
	 * saved setting: which posture you want follows what you are doing right now, and it is one
	 * click either way.
	 */
	const [expanded, setExpanded] = useState(false);
	/* Held here rather than in the detail, because the review bar below it depends on which tab is
	 * open — 聊天 brings its own field. */
	const [tab, setTab] = useState<PrTab>("summary");
	const pr = usePullRequests();

	/*
	 * Asked in the pull request's own conversation, not the workspace's.
	 *
	 * This used to switch to the chat view and prompt the project session, which was wrong twice:
	 * it interrupted whatever was being worked on, and it asked an agent rooted in one repository
	 * to reason about a branch in another — usually one not on this machine at all.
	 *
	 * Queued rather than sent, because the conversation may still be opening. The panel sends it
	 * the moment there is a session, which is also the click that first opens the tab.
	 */
	const askAgent = (detail: Detail) => {
		usePrChat
			.getState()
			.queueAsk(
				`审查这个 Pull Request：先用 gh pr diff ${detail.number} --repo ${detail.repo} 拿到改动，再指出其中的缺陷和风险，按严重程度排序。只读，不要改动任何仓库。`,
			);
	};

	const submit = async (verdict: "approve" | "request-changes" | "comment", body: string): Promise<string | null> => {
		if (!pr.selected) return "没有选中的 Pull Request";
		const { repo, number } = pr.selected;
		const result =
			verdict === "comment"
				? await window.lyra.git.commentOnPullRequest(repo, number, body)
				: await window.lyra.git.reviewPullRequest(repo, number, verdict, body);
		if (result.error) return result.error;
		// What was just said is part of the pull request now; show it rather than claim it.
		pr.refreshDetail();
		return null;
	};

	const list = (
		<PullRequestList
			groups={pr.groups}
			filter={pr.filter}
			onFilter={pr.setFilter}
			query={pr.query}
			onQuery={pr.setQuery}
			selected={pr.selected}
			onSelect={(item) => pr.setSelected({ repo: item.repo, number: item.number })}
			loading={pr.loading}
			error={pr.error}
			onRefresh={pr.refresh}
		/>
	);

	/*
	 * `min-w-0`, or a wide diff line pushes the whole column past the window.
	 *
	 * A flex child's default minimum width is its content, so one long line of code widens the
	 * pane it sits in — and the header's buttons, anchored to the right of that pane, go off the
	 * edge of the screen with it.
	 */
	const detail = (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<PullRequestDetail
				detail={pr.detail}
				loading={pr.detailLoading}
				error={pr.detailError}
				onRefresh={pr.refreshDetail}
				onAskAgent={askAgent}
				expanded={expanded}
				onToggleExpanded={() => setExpanded((open) => !open)}
				tab={tab}
				onTab={setTab}
			/>
			{tab !== "chat" && <ReviewBar onSubmit={submit} disabled={!pr.detail} />}
		</div>
	);

	if (compact) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				{pr.selected ? (
					<>
						<button
							type="button"
							onClick={() => pr.setSelected(null)}
							className="ly-item flex h-9 shrink-0 items-center gap-1.5 px-3 text-label text-ink-muted"
						>
							<ArrowLeft size={13.5} strokeWidth={1.9} />
							全部 Pull Request
						</button>
						{detail}
					</>
				) : (
					list
				)}
			</div>
		);
	}

	/*
	 * The columns start at the window's top edge, not below the toolbar.
	 *
	 * The shell reserves 44px above every view for the window controls, which meant this rule
	 * began 44px lower than the sidebar's — two vertical lines on one screen, one of them starting
	 * in mid-air. Cancelling the reservation and re-applying it *inside* each column puts both
	 * lines on the same origin while leaving the toolbar's space untouched.
	 *
	 * No banner across the top either, for the same reason: anything spanning both columns would
	 * push the rule back down.
	 */
	return (
		<div className="-mt-11 flex min-h-0 flex-1">
			{!expanded && (
				<div
					style={{ width: LIST_WIDTH }}
					className="flex min-h-0 shrink-0 flex-col border-r border-line-soft pt-11"
				>
					{list}
				</div>
			)}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col pt-11">{detail}</div>
		</div>
	);
}
