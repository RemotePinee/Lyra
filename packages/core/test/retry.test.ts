import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchWithRetry, isRetryableError, isRetryableStatus, retryDelay } from "../src/ai/retry.ts";

const socketError = () => Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
const noSleep = async () => {};

test("transport failures are retryable, request mistakes are not", () => {
	assert.equal(isRetryableError(socketError()), true);
	assert.equal(isRetryableError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })), true);
	// A bad request body is not going to become good on the second try.
	assert.equal(isRetryableError(new TypeError("Invalid JSON")), false);
	assert.equal(isRetryableStatus(429), true);
	assert.equal(isRetryableStatus(503), true);
	assert.equal(isRetryableStatus(400), false);
	assert.equal(isRetryableStatus(401), false);
});

test("a dropped socket is retried and the answer still arrives", async () => {
	let calls = 0;
	const response = await fetchWithRetry(
		async () => {
			calls++;
			if (calls < 3) throw socketError();
			return new Response("ok", { status: 200 });
		},
		"https://example.test",
		{},
		{ attempts: 3, sleep: noSleep },
	);
	assert.equal(calls, 3);
	assert.equal(response.status, 200);
});

test("giving up rethrows the last error rather than inventing one", async () => {
	let calls = 0;
	await assert.rejects(
		fetchWithRetry(
			async () => {
				calls++;
				throw socketError();
			},
			"https://example.test",
			{},
			{ attempts: 2, sleep: noSleep },
		),
		/fetch failed/,
	);
	assert.equal(calls, 2);
});

test("a 4xx is returned as-is, without a second attempt", async () => {
	let calls = 0;
	const response = await fetchWithRetry(
		async () => {
			calls++;
			return new Response("nope", { status: 401 });
		},
		"https://example.test",
		{},
		{ attempts: 3, sleep: noSleep },
	);
	assert.equal(calls, 1);
	assert.equal(response.status, 401);
});

test("a 429 is retried, and the caller is told each time", async () => {
	let calls = 0;
	const notices: string[] = [];
	const response = await fetchWithRetry(
		async () => {
			calls++;
			return calls < 2 ? new Response("slow down", { status: 429 }) : new Response("ok", { status: 200 });
		},
		"https://example.test",
		{},
		{ attempts: 3, sleep: noSleep, onRetry: (info) => notices.push(info.reason) },
	);
	assert.equal(calls, 2);
	assert.equal(response.status, 200);
	assert.deepEqual(notices, ["HTTP 429"]);
});

test("an aborted turn stops immediately instead of waiting to retry", async () => {
	const controller = new AbortController();
	let calls = 0;
	await assert.rejects(
		fetchWithRetry(
			async () => {
				calls++;
				controller.abort();
				throw socketError();
			},
			"https://example.test",
			{},
			{ attempts: 5, signal: controller.signal, sleep: noSleep },
		),
	);
	// Cancelling is a decision, not a failure: it is not retried.
	assert.equal(calls, 1);
});

test("attempts of 1 disables retrying", async () => {
	let calls = 0;
	await assert.rejects(
		fetchWithRetry(
			async () => {
				calls++;
				throw socketError();
			},
			"https://example.test",
			{},
			{ attempts: 1, sleep: noSleep },
		),
	);
	assert.equal(calls, 1);
});

test("the server's own Retry-After wins over the backoff curve", () => {
	const response = new Response("", { status: 429, headers: { "retry-after": "2" } });
	assert.equal(retryDelay(1, response), 2000);
	// Capped, so one unlucky header cannot stall a turn for ten minutes.
	const long = new Response("", { status: 429, headers: { "retry-after": "600" } });
	assert.equal(retryDelay(1, long), 30_000);
	// Without a header the curve grows, and stays inside its ceiling.
	assert.ok(retryDelay(1) < retryDelay(3));
	assert.ok(retryDelay(9) <= 20_000);
});
