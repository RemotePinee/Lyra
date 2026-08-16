/**
 * The sidebar's list, as rules rather than as a rendering.
 *
 * These were four conditions buried in a 474-line component, and each one is the kind that is only
 * noticed when it is wrong: a pinned project vanishing because it has no sessions yet, a search
 * dissolving the projects it filtered within, a half-started conversation disappearing out from
 * under the message being sent in it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { activeProviderLabel, groupSessions, listableSessions, NO_PROJECT } from "../src/components/sidebar/grouping.ts";

type Session = Parameters<typeof listableSessions>[0][number];

function session(over: Partial<Session>): Session {
	return {
		id: "s1",
		title: "会话",
		cwd: "/a",
		projectName: "a",
		messageCount: 2,
		archived: false,
		updatedAt: 0,
		createdAt: 0,
		...over,
	} as Session;
}

const projects = [
	{ path: "/pinned", name: "置顶项目", pinned: true, lastOpenedAt: 2 },
	{ path: "/a", name: "a", pinned: false, lastOpenedAt: 1 },
];

test("archived sessions are not listed; they live in settings", () => {
	const kept = listableSessions([session({ id: "x", archived: true }), session({ id: "y" })], null);
	assert.deepEqual(
		kept.map((s) => s.id),
		["y"],
	);
});

test("an empty session is not a conversation yet, unless it is the one being started", () => {
	const sessions = [session({ id: "empty", messageCount: 0 }), session({ id: "started", messageCount: 0 })];
	assert.deepEqual(
		listableSessions(sessions, "started").map((s) => s.id),
		["started"],
	);
});

test("a pinned project keeps its row with no sessions; an unpinned one does not", () => {
	const { pinned, recent } = groupSessions([], projects, "");
	assert.deepEqual(
		pinned.map((g) => g.path),
		["/pinned"],
	);
	assert.deepEqual(recent, []);
});

test("searching filters sessions without dissolving their projects", () => {
	const sessions = [
		session({ id: "1", title: "改一下登录", cwd: "/a" }),
		session({ id: "2", title: "登录页样式", cwd: "/b", projectName: "b" }),
		session({ id: "3", title: "无关的事", cwd: "/a" }),
	];
	const { recent } = groupSessions(sessions, projects, "登录");
	assert.deepEqual(
		recent.map((g) => [g.path, g.sessions.map((s) => s.id)]),
		[
			["/a", ["1"]],
			["/b", ["2"]],
		],
	);
});

test("projects keep their configured order; unknown ones go last", () => {
	const sessions = [session({ id: "1", cwd: "/z", projectName: "z" }), session({ id: "2", cwd: "/a" })];
	const { recent } = groupSessions(sessions, projects, "");
	assert.deepEqual(
		recent.map((g) => g.path),
		["/a", "/z"],
	);
});

test("the settings row counts models across enabled providers only", () => {
	const label = activeProviderLabel([
		{ name: "Relay", enabled: true, models: [1, 2] },
		{ name: "旧的", enabled: false, models: [1] },
	]);
	assert.equal(label, "Relay · 2 个模型");
});

test("with nothing configured the settings row says so", () => {
	assert.equal(activeProviderLabel([]), "未配置模型供应商");
});

test("project-less conversations are grouped together, not as a project each", () => {
	/*
	 * They are real sessions worth returning to — a review asked about yesterday should be one
	 * click away — but their directory is scratch space. Grouped by directory the usual way, each
	 * one becomes a project called `owner-repo-6381` sitting among the user's actual work.
	 */
	const roots = ["/home/.lyra/scratch"];
	const sessions = [
		session({ id: "work", cwd: "/a" }),
		session({ id: "review-1", cwd: "/home/.lyra/scratch/owner-repo-1" }),
		session({ id: "review-2", cwd: "/home/.lyra/scratch/owner-repo-2" }),
	];

	const { recent } = groupSessions(sessions, projects, "", roots);
	const scratch = recent.find((g) => g.path === NO_PROJECT);

	assert.ok(scratch, "there should be one group for them");
	assert.deepEqual(
		scratch.sessions.map((s) => s.id),
		["review-1", "review-2"],
		"both belong to the same group despite different directories",
	);
	assert.equal(scratch.name, "无项目");
	assert.equal(recent[recent.length - 1].path, NO_PROJECT, "and it sorts last");
});

test("every historical scratch root is recognised, not just the current one", () => {
	// The directory was renamed once. Sessions record the path they were created under, so
	// forgetting the old one turns every already-opened review back into a fake project.
	const sessions = [
		session({ id: "old", cwd: "/home/.lyra/pr/owner-repo-1" }),
		session({ id: "new", cwd: "/home/.lyra/scratch/owner-repo-2" }),
	];

	const { recent } = groupSessions(sessions, [], "", ["/home/.lyra/scratch", "/home/.lyra/pr"]);
	assert.equal(recent.length, 1, "both are project-less, so there is one group");
	assert.equal(recent[0].path, NO_PROJECT);
});

test("a project whose path merely starts the same is still its own project", () => {
	// The root arrives without a trailing slash; a plain `startsWith` would swallow
	// `/home/.lyra/prototypes` into the project-less group.
	const sessions = [session({ id: "prototypes", cwd: "/home/.lyra/prototypes" })];

	const { recent } = groupSessions(sessions, [], "", ["/home/.lyra/pr"]);
	assert.equal(recent[0].path, "/home/.lyra/prototypes");
});

test("with no scratch roots known yet, nothing is grouped as project-less", () => {
	const sessions = [session({ id: "review", cwd: "/home/.lyra/scratch/owner-repo-1" })];
	const { recent } = groupSessions(sessions, [], "", []);
	assert.notEqual(recent[0].path, NO_PROJECT);
});
