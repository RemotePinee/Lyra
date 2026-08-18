/**
 * Which shell a pane gets, and what it takes to end one.
 *
 * The whole point of this registry is that a shell outlives the pane showing it: panes are
 * unmounted constantly — closing one, switching to a conversation laid out differently, making
 * another pane full screen — and every one of those used to kill the shell underneath. So the
 * claims worth testing are all about identity and survival: connecting twice reaches the same
 * shell, a detach ends nothing, and what the shell said while nobody was watching comes back.
 *
 * Driven through `createTerminalRegistry` with a stand-in pty, so none of this needs Electron —
 * and so "did it spawn a second shell?" is a countable fact rather than something inferred from
 * output that looks familiar.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTerminalRegistry, type LiveTerminal } from "../electron/terminal-registry.ts";

interface FakePty {
	pid: number;
	killed: boolean;
	writes: string[];
	sizes: [number, number][];
	say(data: string): void;
	quit(code: number): void;
}

/** A registry and the shells it started, with nothing real on the other end. */
function harness() {
	const terminals = new Map<string, LiveTerminal>();
	const spawned: FakePty[] = [];
	let nextPid = 1000;

	const spawnPty = () => {
		const dataHandlers: ((data: string) => void)[] = [];
		const exitHandlers: ((event: { exitCode: number }) => void)[] = [];
		const pty = {
			pid: nextPid++,
			killed: false,
			writes: [] as string[],
			sizes: [] as [number, number][],
			write: (data: string) => pty.writes.push(data),
			resize: (cols: number, rows: number) => pty.sizes.push([cols, rows]),
			kill: () => {
				pty.killed = true;
			},
			onData: (fn: (data: string) => void) => dataHandlers.push(fn),
			onExit: (fn: (event: { exitCode: number }) => void) => exitHandlers.push(fn),
			say: (data: string) => dataHandlers.forEach((fn) => fn(data)),
			quit: (code: number) => exitHandlers.forEach((fn) => fn({ exitCode: code })),
		};
		spawned.push(pty as unknown as FakePty);
		return pty as never;
	};

	const registry = createTerminalRegistry({
		terminals,
		spawnPty,
		// Every path is a project here; which paths qualify is decided elsewhere and tested there.
		insideAProject: () => true,
		window: () => null,
	});

	return { registry, terminals, spawned };
}

test("opening always starts another shell — that is what the tab strip's + is for", () => {
	const { registry, spawned } = harness();

	const first = registry.open("/work/app", 80, 24);
	const second = registry.open("/work/app", 80, 24);

	assert.equal(spawned.length, 2);
	assert.notEqual(second.id, first.id);
	assert.deepEqual([first.title, second.title], ["终端 1", "终端 2"], "and it is numbered per project");
});

test("a project lists its own shells, and only its own", () => {
	const { registry } = harness();

	registry.open("/work/app", 80, 24);
	registry.open("/work/app", 80, 24);
	registry.open("/work/docs", 80, 24);

	assert.deepEqual(
		registry.list("/work/app").map((tab) => tab.title),
		["终端 1", "终端 2"],
	);
	assert.deepEqual(
		registry.list("/work/docs").map((tab) => tab.title),
		["终端 1"],
		"numbering starts again in a project of its own",
	);
});

test("attaching reaches the shell that is already there rather than starting one", () => {
	const { registry, spawned } = harness();

	const opened = registry.open("/work/app", 80, 24);
	const again = registry.attach(opened.id, 80, 24);

	assert.equal(spawned.length, 1, "no second shell was started");
	assert.equal(again?.pid, opened.pid, "and it is the same process");
});

test("attaching to a shell that is gone says so instead of quietly starting a new one", () => {
	const { registry, spawned } = harness();

	const opened = registry.open("/work/app", 80, 24);
	registry.kill(opened.id);

	assert.equal(registry.attach(opened.id, 80, 24), null);
	assert.equal(spawned.length, 1, "and nothing was spawned behind the caller's back");
});

test("a number is only reused once the tab holding it has gone", () => {
	const { registry } = harness();

	const first = registry.open("/work/app", 80, 24);
	registry.open("/work/app", 80, 24);
	registry.kill(first.id);

	assert.equal(registry.open("/work/app", 80, 24).title, "终端 1", "the free number came back");
});

test("detaching leaves the shell running — it is the pane that went away, not the terminal", () => {
	const { registry, spawned, terminals } = harness();

	const { id, epoch } = registry.open("/work/app", 80, 24);
	registry.detach(id, epoch);

	assert.equal(spawned[0].killed, false, "the shell is still running");
	assert.equal(terminals.size, 1, "and still on the books");
});

test("what the shell said while no pane was listening comes back on the next attach", () => {
	const { registry, spawned } = harness();

	const { id, epoch } = registry.open("/work/app", 80, 24);
	spawned[0].say("$ npm run build\r\n");
	registry.detach(id, epoch);
	// A long build carries on in a terminal nobody is looking at. That is the point of it.
	spawned[0].say("built in 12s\r\n");

	const again = registry.attach(id, 80, 24);
	assert.equal(again?.pid, spawned[0].pid, "same shell");
	assert.equal(again?.replay, "$ npm run build\r\nbuilt in 12s\r\n", "and everything it wrote, in order");
});

test("a shell that has just started has nothing to replay", () => {
	const { registry } = harness();
	assert.equal(registry.open("/work/app", 80, 24).replay, "");
});

test("a late detach from a pane that has already been replaced does not mute the shell", () => {
	/*
	 * React mounts, unmounts and remounts an effect in development, and the first mount's `attach`
	 * resolves after the second one has already connected. Its cleanup then detaches an id that
	 * something else is now listening to — and the shell went quiet, because output is only
	 * forwarded while a pane is attached. On screen that was a terminal that opened to nothing at
	 * all and never recovered.
	 *
	 * So a detach says which connection it is ending, and one that has been superseded is ignored.
	 */
	const { registry, terminals } = harness();

	const first = registry.open("/work/app", 80, 24);
	const second = registry.attach(first.id, 80, 24);
	assert.ok(second);
	registry.detach(first.id, first.epoch);

	assert.equal(terminals.get(first.id)?.attached, true, "the shell is still being listened to");

	registry.detach(second.id, second.epoch);
	assert.equal(terminals.get(first.id)?.attached, false, "and the current pane can still let go");
});

test("coming back tells the shell the size of the pane it came back to", () => {
	const { registry, spawned } = harness();

	const { id, epoch } = registry.open("/work/app", 80, 24);
	registry.detach(id, epoch);
	registry.attach(id, 120, 40);

	assert.deepEqual(spawned[0].sizes.at(-1), [120, 40]);
});

test("an attach that does not know the size yet leaves the shell at the size it had", () => {
	const { registry, spawned } = harness();

	const { id, epoch } = registry.open("/work/app", 80, 24);
	registry.detach(id, epoch);
	registry.attach(id, 0, 0);

	assert.deepEqual(spawned[0].sizes, [], "nothing was resized to a sliver on the way to finding out");
});

test("a shell that exits on its own stops being handed out", () => {
	const { registry, spawned, terminals } = harness();

	const { id } = registry.open("/work/app", 80, 24);
	spawned[0].quit(0);

	assert.equal(terminals.size, 0);
	assert.equal(registry.attach(id, 80, 24), null);
	assert.deepEqual(registry.list("/work/app"), [], "and the tab strip stops listing it");
});

test("killing is the one thing that ends a shell", () => {
	const { registry, spawned, terminals } = harness();

	const { id } = registry.open("/work/app", 80, 24);
	registry.kill(id);

	assert.equal(spawned[0].killed, true);
	assert.equal(terminals.size, 0);
});

test("making room never closes a tab of the project you are looking at", () => {
	const { registry, spawned, terminals } = harness();

	// Fifteen elsewhere, all idle, then the ceiling is reached from inside one project.
	for (let i = 0; i < 15; i++) {
		const opened = registry.open(`/other/${i}`, 80, 24);
		registry.detach(opened.id, opened.epoch);
	}
	const mine = registry.open("/work/app", 80, 24);
	registry.detach(mine.id, mine.epoch);
	registry.open("/work/app", 80, 24);

	assert.equal(spawned[0].killed, true, "an idle shell from another project went");
	assert.equal(terminals.has(mine.id), true, "the tab in this project stayed");
	assert.deepEqual(
		registry.list("/work/app").map((tab) => tab.title),
		["终端 1", "终端 2"],
		"so the strip kept both of its tabs",
	);
});

test("the ceiling yields rather than close something the user can see", () => {
	const { registry, spawned, terminals } = harness();

	// Every shell alive is a tab of the project in front of you: none of them may be taken away.
	for (let i = 0; i < 17; i++) registry.open("/work/app", 80, 24);

	assert.equal(terminals.size, 17);
	assert.deepEqual(
		spawned.filter((pty) => pty.killed),
		[],
		"nothing on screen was ended underneath the user",
	);
});

test("output is capped, so a runaway shell cannot grow the main process without bound", () => {
	const { registry, spawned } = harness();

	const { id, epoch } = registry.open("/work/app", 80, 24);
	registry.detach(id, epoch);
	// 4MB of `yes`, well past the cap.
	for (let i = 0; i < 4096; i++) spawned[0].say("y\n".repeat(512));

	const replay = registry.attach(id, 80, 24)?.replay ?? "";
	assert.ok(replay.length <= 256 * 1024, `kept ${replay.length} bytes`);
	assert.ok(replay.length > 128 * 1024, "and still enough to redraw a screen from");
});
