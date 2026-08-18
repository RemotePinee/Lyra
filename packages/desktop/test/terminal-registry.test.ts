/**
 * Which shell a pane gets, and what it takes to end one.
 *
 * The whole point of this registry is that a shell outlives the pane showing it: panes are
 * unmounted constantly — closing one, switching to a conversation laid out differently, making
 * another pane full screen — and every one of those used to kill the shell underneath. So the
 * claims worth testing are all about identity and survival: the same directory gets the same
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

test("a second attach to the same directory joins the shell that is already there", () => {
	const { registry, spawned } = harness();

	const first = registry.attach("/work/app", 80, 24);
	const second = registry.attach("/work/app", 80, 24);

	assert.equal(spawned.length, 1, "no second shell was started");
	assert.equal(second.id, first.id);
	assert.equal(second.pid, first.pid, "and it is the same process");
});

test("different directories get shells of their own", () => {
	const { registry, spawned } = harness();

	const app = registry.attach("/work/app", 80, 24);
	const docs = registry.attach("/work/docs", 80, 24);

	assert.equal(spawned.length, 2);
	assert.notEqual(docs.id, app.id);
});

test("detaching leaves the shell running — it is the pane that went away, not the terminal", () => {
	const { registry, spawned, terminals } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	registry.detach(id);

	assert.equal(spawned[0].killed, false, "the shell is still running");
	assert.equal(terminals.size, 1, "and still on the books");
});

test("what the shell said while no pane was listening comes back on the next attach", () => {
	const { registry, spawned } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	spawned[0].say("$ npm run build\r\n");
	registry.detach(id);
	// A long build carries on in a terminal nobody is looking at. That is the point of it.
	spawned[0].say("built in 12s\r\n");

	const again = registry.attach("/work/app", 80, 24);
	assert.equal(again.pid, spawned[0].pid, "same shell");
	assert.equal(again.replay, "$ npm run build\r\nbuilt in 12s\r\n", "and everything it wrote, in order");
});

test("a shell that has just started has nothing to replay", () => {
	const { registry } = harness();
	assert.equal(registry.attach("/work/app", 80, 24).replay, "");
});

test("coming back tells the shell the size of the pane it came back to", () => {
	const { registry, spawned } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	registry.detach(id);
	registry.attach("/work/app", 120, 40);

	assert.deepEqual(spawned[0].sizes.at(-1), [120, 40]);
});

test("an attach that does not know the size yet leaves the shell at the size it had", () => {
	const { registry, spawned } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	registry.detach(id);
	registry.attach("/work/app", 0, 0);

	assert.deepEqual(spawned[0].sizes, [], "nothing was resized to a sliver on the way to finding out");
});

test("a shell that exits on its own stops being handed out", () => {
	const { registry, spawned, terminals } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	spawned[0].quit(0);
	assert.equal(terminals.size, 0, `${id} is gone`);

	registry.attach("/work/app", 80, 24);
	assert.equal(spawned.length, 2, "and asking again starts a fresh one");
});

test("killing is the one thing that ends a shell", () => {
	const { registry, spawned, terminals } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	registry.kill(id);

	assert.equal(spawned[0].killed, true);
	assert.equal(terminals.size, 0);
});

test("idle shells are retired once there are too many, oldest first", () => {
	const { registry, spawned, terminals } = harness();

	// Four directories, each detached in turn, so all four are idle and their order is known.
	for (const dir of ["/a", "/b", "/c", "/d"]) registry.detach(registry.attach(dir, 80, 24).id);
	assert.equal(terminals.size, 4);

	registry.attach("/e", 80, 24);

	assert.equal(spawned[0].killed, true, "/a had been idle longest");
	assert.equal(spawned[1].killed, false, "/b is still around");
	assert.equal(terminals.size, 4, "and the ceiling held");
});

test("a shell with a pane on it is never retired to make room", () => {
	const { registry, spawned, terminals } = harness();

	// All four in use: this is a layout someone built, not four shells nobody wanted.
	for (const dir of ["/a", "/b", "/c", "/d"]) registry.attach(dir, 80, 24);
	registry.attach("/e", 80, 24);

	assert.deepEqual(
		spawned.map((pty) => pty.killed),
		[false, false, false, false, false],
		"nothing on screen was ended underneath the user",
	);
	assert.equal(terminals.size, 5, "the ceiling yields rather than take a shell away");
});

test("output is capped, so a runaway shell cannot grow the main process without bound", () => {
	const { registry, spawned } = harness();

	const { id } = registry.attach("/work/app", 80, 24);
	registry.detach(id);
	// 4MB of `yes`, well past the cap.
	for (let i = 0; i < 4096; i++) spawned[0].say("y\n".repeat(512));

	const replay = registry.attach("/work/app", 80, 24).replay;
	assert.ok(replay.length <= 256 * 1024, `kept ${replay.length} bytes`);
	assert.ok(replay.length > 128 * 1024, "and still enough to redraw a screen from");
});
