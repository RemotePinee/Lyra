/**
 * What the side chat says about work it handed over.
 *
 * One line, and it has to be the right one. Saying only "executing" while three more sit behind it
 * hides that the session has a backlog — which is exactly what you want to know before dispatching
 * a fourth, or deciding to withdraw one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarise } from "../src/components/sidechat/summary.ts";

type Task = Parameters<typeof summarise>[0][number];

const task = (status: Task["status"]): Task => ({ id: status, text: "…", status, origin: "side-chat" }) as Task;

test("nothing running: it says how many are waiting", () => {
	assert.equal(summarise([task("queued"), task("queued")]), "2 个任务在主会话排队");
});

test("one running and nothing behind it: no count, because there is no backlog", () => {
	assert.equal(summarise([task("running")]), "主会话正在执行派出的任务");
});

test("running with a queue: the count is the point", () => {
	const line = summarise([task("running"), task("queued"), task("queued"), task("queued")]);
	assert.equal(line, "正在执行，还有 3 个排队");
	assert.match(line, /3/, "the number of waiting tasks is what the caller cannot see otherwise");
});
