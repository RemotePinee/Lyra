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
import { useApp } from "../store.ts";
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
	const settings = useApp((s) => s.settings);
	const openWorkspace = useApp((s) => s.openWorkspace);
	const newSession = useApp((s) => s.newSession);
	const setComposerDraft = useApp((s) => s.setComposerDraft);
	const setView = useApp((s) => s.setView);
	const pr = usePullRequests();

	/*
	 * Open the app's conversation window, already pointed at the right place.
	 *
	 * The whole question is where that conversation should run. A review is about a repository,
	 * and if that repository is one of the user's projects then everything they would want — the
	 * files, the history, the branch switcher — is right there, so the conversation should be in
	 * it. If it is not one of their projects, there is nothing to pretend about: it opens with no
	 * project at all, in a scratch directory, and the agent works from the pull request itself.
	 *
	 * Only their project list is searched. A checkout the app has never been told about is not
	 * somewhere it should start working in uninvited, and matching is on `origin` rather than on
	 * a directory name, so a folder that merely shares a name is not mistaken for the repository.
	 *
	 * The text is left in the composer rather than sent. What to ask about a review is the user's
	 * to decide, and a question that appears already answered is one they never got to change.
	 */
	const openChat = async (detail: Detail, intent: "ask" | "review") => {
		const projects = [...(settings?.projects ?? [])].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
		const local = await window.lyra.git
			.findLocalCheckout(
				detail.repo,
				projects.map((p) => p.path),
			)
			.catch(() => null);

		if (local) {
			await openWorkspace(local);
		} else {
			// No project: a scratch directory with the pull request's facts written into it.
			const cwd = await window.lyra.git
				.scratchForPullRequest({
					repo: detail.repo,
					number: detail.number,
					title: detail.title,
					author: detail.author,
					url: detail.url,
					headRefName: detail.headRefName,
					baseRefName: detail.baseRefName,
					state: detail.state,
					body: detail.body,
				})
				.catch(() => null);
			useApp.setState({ workspace: null, scratchCwd: cwd });
		}

		await newSession();
		setComposerDraft(draftFor(detail, intent, local));
		setView("chat");
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
				onOpenChat={openChat}
				expanded={expanded}
				onToggleExpanded={() => setExpanded((open) => !open)}
				tab={tab}
				onTab={setTab}
			/>
			<ReviewBar onSubmit={submit} disabled={!pr.detail} />
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
				<div style={{ width: LIST_WIDTH }} className="flex min-h-0 shrink-0 flex-col border-r border-line-soft">
					{list}
				</div>
			)}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
		</div>
	);
}

/**
 * What lands in the composer.
 *
 * `ask` is an opening, not an instruction — the user is expected to edit it, and a request to
 * "了解" invites a summary rather than committing them to a full review they may not want.
 * `review` is the instruction, because that button says exactly what it will ask for.
 *
 * The branch is only mentioned when the repository is actually here. Naming a branch that cannot
 * be checked out reads as an instruction the agent then has to refuse.
 */
function draftFor(detail: Detail, intent: "ask" | "review", local: string | null): string {
	const where = local ? `本地仓库就是当前项目，分支 ${detail.headRefName} → ${detail.baseRefName}。` : "";

	if (intent === "review") {
		return `审查 Pull Request #${detail.number}：${detail.title}\n${detail.url}\n\n${where}先拿到改动，再指出其中的缺陷和风险，按严重程度排序。只读，不要改动仓库。`;
	}
	return `帮我了解 Pull Request #${detail.number}：${detail.title}\n${detail.url}${where ? `\n\n${where}` : ""}`;
}
