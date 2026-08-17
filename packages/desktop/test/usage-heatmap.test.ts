/**
 * The usage calendar.
 *
 * The claims: every day lands in the column and row it belongs to, a session at either end of the
 * day counts on that day, and the shading ranks days against each other rather than against a
 * number nobody chose.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, heatLevel, heatmapWeeks, monthLabels } from "../src/components/settings/usage-heatmap.ts";

const at = (iso: string, input = 0, output = 0, cost = 0) => ({
	updatedAt: new Date(iso).getTime(),
	usage: { input, output, cost: { total: cost } },
});

test("the grid is weeks of seven, oldest first, ending on this week", () => {
	// A Thursday.
	const now = new Date(2026, 7, 13, 15, 0);
	const grid = heatmapWeeks([], now, 4);

	assert.equal(grid.length, 4);
	for (const column of grid) assert.equal(column.length, 7, "every column is a full week");

	// Columns start on Monday.
	for (const column of grid) assert.equal(column[0]?.date.getDay(), 1, `column starts on ${column[0]?.date}`);

	// Today is in the last column.
	const last = grid[grid.length - 1]!;
	assert.ok(last.some((d) => d.key === dayKey(now)), "today is in the final week");
});

test("a session counts on the local day it happened, including late at night", () => {
	const now = new Date(2026, 7, 13, 12, 0);
	const grid = heatmapWeeks([at("2026-08-12T23:30:00"), at("2026-08-13T00:10:00")], now, 2);
	const days = grid.flat();

	assert.equal(days.find((d) => d.key === "2026-08-12")?.sessions, 1, "23:30 belongs to the 12th");
	assert.equal(days.find((d) => d.key === "2026-08-13")?.sessions, 1, "00:10 belongs to the 13th");
});

test("several sessions on one day add up", () => {
	const now = new Date(2026, 7, 13, 12, 0);
	const grid = heatmapWeeks(
		[at("2026-08-11T09:00:00", 100, 20, 0.5), at("2026-08-11T14:00:00", 300, 80, 1.5)],
		now,
		2,
	);
	const day = grid.flat().find((d) => d.key === "2026-08-11");
	assert.equal(day?.sessions, 2);
	assert.equal(day?.input, 400);
	assert.equal(day?.output, 100);
	assert.equal(day?.cost, 2);
});

test("days with nothing on them are present and empty, not missing", () => {
	const now = new Date(2026, 7, 13, 12, 0);
	const grid = heatmapWeeks([], now, 3);
	const days = grid.flat();
	assert.equal(days.length, 21);
	assert.ok(days.every((d) => d.sessions === 0 && d.input === 0), "a rectangle of zeroes, not holes");
});

test("sessions older than the window are simply not shown", () => {
	const now = new Date(2026, 7, 13, 12, 0);
	const grid = heatmapWeeks([at("2020-01-01T10:00:00", 999)], now, 2);
	assert.ok(grid.flat().every((d) => d.input === 0));
});

test("shading ranks days against the busiest, so one huge day does not flatten the rest", () => {
	assert.equal(heatLevel(0, 1000), 0, "nothing is nothing");
	assert.equal(heatLevel(1000, 1000), 4, "the busiest day is the darkest");
	assert.equal(heatLevel(500, 1000), 3);
	assert.equal(heatLevel(200, 1000), 2);
	assert.equal(heatLevel(50, 1000), 1, "a quiet day is still visible");
	// And with no data at all nothing is shaded, rather than everything.
	assert.equal(heatLevel(0, 0), 0);
	assert.equal(heatLevel(10, 0), 0);
});

test("month labels appear once per month and never on the last column", () => {
	const now = new Date(2026, 7, 13, 12, 0);
	const grid = heatmapWeeks([], now, 12);
	const labels = monthLabels(grid);

	assert.ok(labels.length >= 2, `expected a few months across 12 weeks, got ${labels.length}`);
	const columns = labels.map((l) => l.column);
	assert.deepEqual(columns, [...new Set(columns)], "one label per column");
	assert.ok(
		labels.every((l) => l.column < grid.length - 1),
		"nothing on the final column, where it would collide with the edge",
	);
	assert.deepEqual([...new Set(labels.map((l) => l.text))], labels.map((l) => l.text), "each month once");
});
