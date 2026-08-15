/**
 * When a scheduled task runs, and when the list says it will.
 *
 * These two answers used to be written in one process each — the scheduler decided whether to run
 * something now, and nothing at all told you when it would run next. Now they are one file, and
 * these tests are what holds them to the same story: a badge that says 09:00 while the run happens
 * at 09:05 is worse than no badge, because it is believed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isDue, nextRunAt } from "../src/config/schedule.ts";
import type { ScheduledTask } from "../src/config/settings.ts";

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		id: "t1",
		name: "nightly",
		prompt: "…",
		cwd: "/tmp",
		enabled: true,
		schedule: { kind: "daily", time: "09:00" },
		...over,
	} as ScheduledTask;
}

/** 2026-03-10, a Tuesday, in local time — the tests are about wall clocks, not UTC. */
const at = (hour: number, minute = 0) => new Date(2026, 2, 10, hour, minute, 0, 0).getTime();

test("a daily task is due once the hour has come, and not before", () => {
	assert.equal(isDue(task(), at(8, 59)), false);
	assert.equal(isDue(task(), at(9, 0)), true);
	assert.equal(isDue(task(), at(23, 0)), true, "still due if the app was closed all morning");
});

test("a daily task that already ran today is not due again", () => {
	const ran = task({ lastRunAt: at(9, 1) });
	assert.equal(isDue(ran, at(18, 0)), false);
	// Tomorrow it is.
	assert.equal(isDue(ran, at(9, 0) + 24 * 3600_000), true);
});

test("an interval task is due once its period has elapsed", () => {
	const every30 = task({ schedule: { kind: "interval", minutes: 30 } });
	assert.equal(isDue(every30, at(9)), true, "never run before, so it is due now");
	assert.equal(isDue({ ...every30, lastRunAt: at(9) }, at(9, 29)), false);
	assert.equal(isDue({ ...every30, lastRunAt: at(9) }, at(9, 30)), true);
});

test("the next run of a daily task is today while the hour is ahead, tomorrow once it has passed", () => {
	assert.equal(nextRunAt(task(), at(8)), at(9), "later today");
	assert.equal(nextRunAt(task(), at(10)), at(9) + 24 * 3600_000, "tomorrow");
});

test("having run today pushes the next run to tomorrow, even before the hour", () => {
	// The nine o'clock slot is used up; saying "09:00 today" would be a time that never comes.
	const ran = task({ lastRunAt: at(9, 1) });
	assert.equal(nextRunAt(ran, at(9, 30)), at(9) + 24 * 3600_000);
});

test("a disabled task has no next run at all", () => {
	assert.equal(nextRunAt(task({ enabled: false }), at(8)), null);
});

test("the two agree: what is due now is what was predicted for now", () => {
	/*
	 * The property that matters. Walk a day in ten-minute steps and check that the moment the
	 * prediction comes due, the scheduler agrees — that is the disagreement these tests exist to
	 * prevent, and it is not visible from either function alone.
	 */
	const daily = task({ lastRunAt: at(9, 1) - 24 * 3600_000 });
	const predicted = nextRunAt(daily, at(0));
	assert.ok(predicted !== null);

	for (let t = at(0); t < at(23, 50); t += 10 * 60_000) {
		if (isDue(daily, t)) {
			assert.ok(t >= predicted, `due at ${new Date(t).toTimeString()} but predicted ${new Date(predicted).toTimeString()}`);
			break;
		}
	}
});

test("a malformed time never fires and never predicts", () => {
	const broken = task({ schedule: { kind: "daily", time: "not-a-time" } });
	assert.equal(isDue(broken, at(9)), false);
	assert.equal(nextRunAt(broken, at(9)), null);
});
