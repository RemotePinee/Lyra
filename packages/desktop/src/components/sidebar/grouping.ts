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

export function groupSessions(
	sessions: SessionMeta[],
	projects: ProjectRef[],
	query: string,
): { pinned: Group[]; recent: Group[] } {
	const needle = query.trim().toLowerCase();
	const filtered = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;

	const byPath = new Map<string, Group>();
	for (const project of projects) {
		byPath.set(project.path, { path: project.path, name: project.name, sessions: [] });
	}
	for (const session of filtered) {
		let group = byPath.get(session.cwd);
		if (!group) {
			group = { path: session.cwd, name: session.projectName, sessions: [] };
			byPath.set(session.cwd, group);
		}
		group.sessions.push(session);
	}

	const pinnedPaths = new Set(projects.filter((p) => p.pinned).map((p) => p.path));
	const order = new Map(projects.map((p, i) => [p.path, i]));
	const all = [...byPath.values()]
		// A project with no sessions is only worth a row when the user pinned it.
		.filter((g) => g.sessions.length > 0 || pinnedPaths.has(g.path))
		.sort((a, b) => (order.get(a.path) ?? 999) - (order.get(b.path) ?? 999));

	return {
		pinned: all.filter((g) => pinnedPaths.has(g.path)),
		recent: all.filter((g) => !pinnedPaths.has(g.path)),
	};
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
