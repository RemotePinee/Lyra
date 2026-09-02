/**
 * The sync row and the empty state, in the app, against a real repository.
 *
 * The rules have unit tests and they cover the table. What they cannot cover is whether any of it
 * is wired up: whether the panel reads the state it was given, whether pressing 「发布分支」 pushes,
 * and — the part that has broken before — whether the screen notices afterwards. Publishing changes
 * no file, so a panel comparing readings on file lists alone would go on offering to publish a
 * branch that had just been published.
 *
 * The remote is a bare repository next to the project, so this needs no network and no credentials.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

const exec = promisify(execFile);

let app: RunningApp;
let project = "";
let remote = "";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd });
	return stdout;
}

async function seed(home: string): Promise<void> {
	// The remote lives outside the workspace, or the panel's repository scan would list it too.
	remote = join(home, "remote.git");
	await exec("git", ["init", "-q", "--bare", remote]);

	project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "one.txt"), "one\n");
	await exec("git", ["init", "-q", "--initial-branch=main", project]);
	await git(project, "config", "user.email", "test@example.com");
	await git(project, "config", "user.name", "Test");
	await git(project, "add", ".");
	await git(project, "commit", "-qm", "first");
	/*
	 * A remote, and a branch that has never been pushed to it.
	 *
	 * This is the reported state: `git status` reports no ahead count without an upstream, so every
	 * number the panel had was zero and it drew 「工作区干净 · 没有未提交的改动」 over a commit that
	 * had never left the machine.
	 */
	await git(project, "remote", "add", "origin", remote);

	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "",
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			sync: { enabled: false, port: 4527, token: null },
		}),
	);
}

before(async () => {
	app = await startApp({ port: 9484, seed });
	await openGitPanel();
});

after(async () => {
	await app?.stop();
});

async function openGitPanel(): Promise<void> {
	await app.evaluate(`(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		document.querySelector('button[aria-label="面板"]').click();
		await wait(250);
		const row = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim().startsWith("Git"));
		if (!row) throw new Error("no Git row in the panel menu");
		row.click();
		await wait(900);
		return true;
	})()`);
}

interface Panel {
	/** `remoteState`, straight off the row. */
	state: string;
	/** The branch line as drawn: name, then whatever follows it. */
	branch: string;
	/** The empty state's sentence, and the button under it. */
	body: string;
	action: string | null;
	/** How much room the row has, which decides between the icon and the spelled-out form. */
	rowWidth: number;
	/** Each sync control: its accessible name, whether it is disabled, its badge, and its text. */
	buttons: { label: string; disabled: boolean; badge: string | null; text: string }[];
}

/** Read the panel, after giving it a moment to have re-read the repository. */
async function panel(settleMs = 700): Promise<Panel> {
	return app.evaluate<Panel>(`(async () => {
		await new Promise((r) => setTimeout(r, ${settleMs}));
		const row = document.querySelector("[data-ly-sync]");
		if (!row) throw new Error("the git panel is not on screen");
		const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent.includes("工作区"));
		const block = heading?.parentElement;
		return {
			state: row.dataset.lySync,
			branch: row.dataset.lyBranch,
			rowWidth: Math.round(row.clientWidth),
			body: (block?.querySelector("p")?.textContent ?? "").trim(),
			action: (block?.querySelector("button")?.textContent ?? "").trim() || null,
			buttons: [...row.querySelectorAll("button")].map((b) => ({
				label: b.getAttribute("aria-label") ?? "",
				disabled: b.disabled,
				// Read off the attribute rather than the text: the same count is a corner badge in
				// the narrow form and part of 「推送 1」 in the wide one.
				badge: b.dataset.lyCount ?? null,
				text: (b.textContent ?? "").trim(),
			})),
		};
	})()`);
}

/** Press 刷新, which is a fetch and a re-read — the panel does not poll unless a turn is running. */
async function pressRefresh(): Promise<void> {
	await app.evaluate(`(async () => {
		const row = document.querySelector("[data-ly-sync]");
		const refresh = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").includes("刷新"));
		if (!refresh) throw new Error("no refresh button in the sync row");
		refresh.click();
		return true;
	})()`);
}

/** Press the empty state's primary button and wait for the panel to settle. */
async function pressAction(): Promise<void> {
	await app.evaluate(`(async () => {
		const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent.includes("工作区"));
		const button = heading?.parentElement?.querySelector("button");
		if (!button) throw new Error("the empty state has no action button");
		button.click();
		return true;
	})()`);
}

// ---------------------------------------------------------------------------

test("a branch that has never been pushed says so, and offers to publish it", async () => {
	const view = await panel(1200);
	assert.equal(view.state, "no-upstream");
	assert.equal(view.branch, "main · 未跟踪远端");
	/*
	 * The whole point. This used to read 「没有未提交的改动。」 with no button, over a commit that
	 * existed nowhere else.
	 */
	assert.equal(view.body, "这个分支还没有发布到 origin");
	assert.equal(view.action, "发布分支");

	const pull = view.buttons.find((b) => b.label.includes("上游"));
	assert.ok(pull, `no disabled pull button among ${JSON.stringify(view.buttons.map((b) => b.label))}`);
	assert.equal(pull.disabled, true, "pull needs an upstream to pull from");
	// And it explains itself rather than being a dead grey icon.
	assert.match(pull.label, /当前分支没有上游/);

	const push = view.buttons.find((b) => b.label.includes("发布"));
	assert.ok(push, "push should offer to publish");
	assert.equal(push.disabled, false);
	assert.equal(push.badge, null, "no number: 「发布过没有」 is a yes-or-no question");
});

test("publishing it works, and the panel notices with no file having changed", async () => {
	await pressAction();
	const view = await panel(2500);

	assert.equal(view.state, "tracking", "the branch has an upstream now");
	assert.equal(view.branch, "main · origin/main");
	assert.equal(view.body, "没有未提交的改动。");
	assert.equal(view.action, null, "nothing left to do");

	// The commit really is on the remote, not merely reported as sent.
	const refs = await git(project, "ls-remote", remote);
	assert.match(refs, /refs\/heads\/main/, `the remote has no main branch:\n${refs}`);
});

test("a new commit shows up as unpushed, with the count on the button", async () => {
	await writeFile(join(project, "two.txt"), "two\n");
	await git(project, "add", ".");
	await git(project, "commit", "-qm", "second");
	// The panel re-reads on its own poll only while a turn runs, so ask it to look now.
	await pressRefresh();

	const view = await panel(2500);
	assert.equal(view.state, "tracking");
	assert.equal(view.body, "1 个提交尚未推送到 origin/main");
	assert.equal(view.action, "推送");

	const push = view.buttons.find((b) => (b.label ?? "").includes("推送到"));
	assert.ok(push, `no push button among ${JSON.stringify(view.buttons.map((b) => b.label))}`);
	assert.equal(push.badge, "1", "the count belongs on the button you would press");
	/*
	 * At this width the emphasised control spells itself out. 「推送 1」 is a sentence; an arrow with
	 * a superscript 1 is a puzzle — and only this one control does it, so the row still has exactly
	 * one thing standing out.
	 */
	assert.equal(
		push.text,
		"推送 1",
		`the wide form did not render at ${view.rowWidth}px: ${JSON.stringify(view.buttons.map((b) => b.text))}`,
	);
	const others = view.buttons.filter((b) => b !== push);
	for (const button of others) {
		assert.equal(button.text, "", `${button.label} should stay an icon: "${button.text}"`);
	}
});

test("pressing 推送 sends it and the row goes quiet", async () => {
	await pressAction();
	const view = await panel(2500);

	assert.equal(view.body, "没有未提交的改动。");
	assert.equal(view.action, null);
	for (const button of view.buttons) {
		assert.equal(button.badge, null, `${button.label} still carries a badge`);
	}

	const log = await git(project, "log", "--oneline", "origin/main");
	assert.match(log, /second/, `the second commit did not reach the remote:\n${log}`);
});

test("刷新 asks the remote, so 「落后」 can appear at all", async () => {
	/*
	 * The other half of the report. `behind` is computed against the remote-tracking refs, and this
	 * panel never fetched — so before this change the number could not become non-zero no matter
	 * what anyone else pushed. If 刷新 still only re-read the local status, this test cannot pass.
	 */
	const other = join(project, "..", "other");
	await exec("git", ["clone", "-q", remote, other]);
	await git(other, "config", "user.email", "other@example.com");
	await git(other, "config", "user.name", "Other");
	await writeFile(join(other, "three.txt"), "three\n");
	await git(other, "add", ".");
	await git(other, "commit", "-qm", "third");
	await git(other, "push", "-q", "origin", "main");

	await pressRefresh();
	const view = await panel(3000);

	assert.equal(view.body, "远端领先 1 个提交");
	assert.equal(view.action, "拉取");
	const pull = view.buttons.find((b) => (b.label ?? "").includes("拉取"));
	assert.ok(pull, `no pull button among ${JSON.stringify(view.buttons.map((b) => b.label))}`);
	assert.equal(pull.badge, "1");
	assert.equal(pull.disabled, false);
});

test("拉取 brings it down and the row goes quiet again", async () => {
	await pressAction();
	const view = await panel(2500);
	assert.equal(view.body, "没有未提交的改动。");
	assert.equal(view.action, null);

	const log = await git(project, "log", "--oneline");
	assert.match(log, /third/, `the pull did not land:\n${log}`);
});

test("a failure is explained in words, not in the command that failed", async () => {
	// Point the remote at nothing, then give it something to push.
	await git(project, "remote", "set-url", "origin", join(project, "..", "gone.git"));
	await writeFile(join(project, "four.txt"), "four\n");
	await git(project, "add", ".");
	await git(project, "commit", "-qm", "fourth");
	await pressRefresh();
	await panel(1500);

	await pressAction();
	const message = await app.evaluate<string>(`(async () => {
		await new Promise((r) => setTimeout(r, 2500));
		const bar = document.querySelector("[class*=border-danger]");
		return (bar?.textContent ?? "").trim();
	})()`);

	/*
	 * Not 「Command failed: git push」 and not three lines of git's own advice block. The mapping is
	 * in `git-errors.ts`; this is the check that the panel is actually going through it.
	 */
	assert.equal(message, "远端仓库不存在，或没有访问权限。");

	// Put it back so the last test starts from a working repository.
	await git(project, "remote", "set-url", "origin", remote);
});

test("a detached HEAD disables both, and says why on each", async () => {
	await git(project, "checkout", "-q", "--detach", "HEAD");
	await pressRefresh();

	const view = await panel(2500);
	assert.equal(view.state, "detached");
	/*
	 * Not 「HEAD」. `rev-parse --abbrev-ref HEAD` answers with that string here, which is what made
	 * `pushBranch` run `push -u origin HEAD` and fail.
	 */
	assert.match(view.branch, /^游离 HEAD · [0-9a-f]{7,}$/);
	assert.equal(view.body, "当前不在任何分支上。");
	assert.equal(view.action, null);

	const sync = view.buttons.filter((b) => !b.label.includes("刷新"));
	assert.equal(sync.length, 2);
	for (const button of sync) {
		assert.equal(button.disabled, true, `${button.label} should be disabled`);
		assert.match(button.label, /当前不在任何分支上/);
	}
});
