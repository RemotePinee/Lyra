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
import { activeProviderLabel, groupSessions, listableSessions } from "../src/components/sidebar/grouping.ts";

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
	const kept = listableSessions([session({ id: "x", archived: true }), session({ id: "y" })], null, "");
	assert.deepEqual(
		kept.map((s) => s.id),
		["y"],
	);
});

test("an empty session is not a conversation yet, unless it is the one being started", () => {
	const sessions = [session({ id: "empty", messageCount: 0 }), session({ id: "started", messageCount: 0 })];
	assert.deepEqual(
		listableSessions(sessions, "started", "").map((s) => s.id),
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

test("pull request conversations stay out of the sidebar", () => {
	/*
	 * They are ordinary sessions in an ordinary directory — that is what lets one reopen months
	 * later — but the directory is a scratch folder under the app's home, not a project. Listed,
	 * the pane would grow a project per review anyone ever asked a question about.
	 */
	const root = "/home/.lyra/pr";
	const sessions = [
		session({ id: "work", cwd: "/projects/thing" }),
		session({ id: "review", cwd: `${root}/owner-repo-6381` }),
	];

	assert.deepEqual(
		listableSessions(sessions, null, root).map((s) => s.id),
		["work"],
	);
});

test("a project that merely starts with the same characters is still listed", () => {
	/*
	 * The root arrives without a trailing slash, which is exactly what makes this worth a test:
	 * a plain `startsWith` also matches `/home/.lyra/prototypes`, and that project would vanish
	 * from the sidebar with nothing on screen to explain it.
	 */
	const root = "/home/.lyra/pr";
	const sessions = [session({ id: "prototypes", cwd: "/home/.lyra/prototypes" })];

	assert.deepEqual(
		listableSessions(sessions, null, root).map((s) => s.id),
		["prototypes"],
	);
});

test("without the root known yet, nothing is excluded", () => {
	// The path arrives from the main process just after boot; until then the list is simply
	// unfiltered rather than empty.
	const sessions = [session({ id: "review", cwd: "/home/.lyra/pr/owner-repo-1" })];
	assert.equal(listableSessions(sessions, null, "").length, 1);
});
