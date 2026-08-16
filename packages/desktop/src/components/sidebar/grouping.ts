/**
 * Turning a flat list of sessions into the sidebar's two lists.
 *
 * Pure, and separate from the pane that renders it, because the rules are the sort you want to be
 * able to state and check: a project keeps its configured order, a project with no sessions is
 * only worth a row when it was pinned, and searching filters sessions without dissolving the
 * projects they belong to.
 */

import type { SessionMeta } from "@lyra/core";

export interface Group {
	path: string;
	name: string;
	sessions: SessionMeta[];
}

export interface ProjectRef {
	path: string;
	name: string;
	pinned: boolean;
	lastOpenedAt: number;
}

/** The one group every project-less conversation lands in, whatever directory it actually ran in. */
export const NO_PROJECT = "\u0000no-project";

export function groupSessions(
	sessions: SessionMeta[],
	projects: ProjectRef[],
	query: string,
	/**
	 * Directories that are scratch space rather than projects.
	 *
	 * Sessions there are real and worth returning to — a review you asked about yesterday should
	 * be one click away — but they are not projects, and grouping them by directory the usual way
	 * produces a row called `owner-repo-6381` sitting among someone's actual work. They all go
	 * into one group instead, named for what they are.
	 *
	 * More than one root because the directory has been renamed once and stored sessions still
	 * record the path they were created under.
	 */
	scratchRoots: string[] = [],
): { pinned: Group[]; recent: Group[] } {
	const needle = query.trim().toLowerCase();
	const filtered = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;

	const byPath = new Map<string, Group>();
	for (const project of projects) {
		byPath.set(project.path, { path: project.path, name: project.name, sessions: [] });
	}
	const roots = scratchRoots.filter(Boolean).map((root) => (root.endsWith("/") ? root : `${root}/`));
	const isScratch = (cwd: string) => roots.some((root) => cwd.startsWith(root));

	for (const session of filtered) {
		const key = isScratch(session.cwd) ? NO_PROJECT : session.cwd;
		let group = byPath.get(key);
		if (!group) {
			group = {
				path: key,
				name: key === NO_PROJECT ? "无项目" : session.projectName,
				sessions: [],
			};
			byPath.set(key, group);
		}
		group.sessions.push(session);
	}

	const pinnedPaths = new Set(projects.filter((p) => p.pinned).map((p) => p.path));
	const order = new Map(projects.map((p, i) => [p.path, i]));
	const all = [...byPath.values()]
		// A project with no sessions is only worth a row when the user pinned it.
		.filter((g) => g.sessions.length > 0 || pinnedPaths.has(g.path))
		.sort((a, b) => rank(a.path, order) - rank(b.path, order));

	return {
		pinned: all.filter((g) => pinnedPaths.has(g.path)),
		recent: all.filter((g) => !pinnedPaths.has(g.path)),
	};
}

/** Configured projects in their configured order, then unknown ones, then 无项目 last of all. */
function rank(path: string, order: Map<string, number>): number {
	if (path === NO_PROJECT) return 1000;
	return order.get(path) ?? 999;
}

/**
 * Which sessions belong in the list at all.
 *
 * Archived ones live in settings — that is the whole point of archiving them. Empty ones are not
 * conversations yet: no title, nothing to return to, so a row for one cannot be usefully clicked.
 * The active session is exempt, because the conversation you are in the middle of starting has to
 * stay visible and selected while its first message is still in flight.
 */
export function listableSessions(sessions: SessionMeta[], activeSessionId: string | null): SessionMeta[] {
	return sessions.filter((s) => !s.archived && (s.messageCount > 0 || s.id === activeSessionId));
}

/** What the settings row says it will take you to. */
export function activeProviderLabel(providers: { name: string; enabled: boolean; models: unknown[] }[]): string {
	const enabled = providers.filter((p) => p.enabled);
	if (enabled.length === 0) return "未配置模型供应商";
	const models = enabled.reduce((sum, p) => sum + p.models.length, 0);
	return `${enabled.map((p) => p.name).join(" · ")} · ${models} 个模型`;
}
