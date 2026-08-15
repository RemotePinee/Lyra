/**
 * What the agent's answer is allowed to turn into.
 *
 * The model writes prose; labels and comments are pulled back out of it. That extraction is the
 * one place a wrong answer becomes a wrong action — a hallucinated label applied to someone's
 * issue, or a comment posted with the parser's own scaffolding still in it — so it is checked
 * rather than trusted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AREAS, parse } from "../src/tasks/triage.ts";
import { prompt as reviewPrompt } from "../src/tasks/review.ts";

test("labels and comment are read out of an ordinary reply", () => {
	const { labels, comment } = parse(`LABELS: area:desktop, area:session
COMMENT: 缺少复现步骤和版本号。没有这两项无法判断是不是已修复的问题。`);

	assert.deepEqual(labels, ["area:desktop", "area:session"]);
	assert.match(comment, /复现步骤/);
});

test("a label the model invented is dropped rather than applied", () => {
	const { labels } = parse("LABELS: area:desktop, area:quantum, bug\nCOMMENT: x");
	assert.deepEqual(labels, ["area:desktop"], "only names from the fixed list survive");
});

test("at most two areas, however many are offered", () => {
	const { labels } = parse(`LABELS: ${AREAS.join(", ")}\nCOMMENT: x`);
	assert.equal(labels.length, 2);
});

test("a reply with no LABELS line applies nothing", () => {
	const { labels, comment } = parse("我觉得这个 issue 属于桌面端。");
	assert.deepEqual(labels, []);
	assert.equal(comment, "");
});

test("a runaway comment is cut rather than posted whole", () => {
	const { comment } = parse(`LABELS: area:build\nCOMMENT: ${"很长".repeat(2000)}`);
	assert.ok(comment.length <= 1000);
});

test("the review prompt says so when the diff was cut short", () => {
	assert.match(reviewPrompt(7, "diff", true), /截断/);
	assert.doesNotMatch(reviewPrompt(7, "diff", false), /diff 太长/);
});

test("the review prompt tells it not to do the things a bot does badly", () => {
	const p = reviewPrompt(1, "diff", false);
	assert.match(p, /不要评论代码风格/);
	assert.match(p, /不要夸奖/);
	assert.match(p, /没找到问题就直说/);
});
