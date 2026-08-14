import assert from "node:assert/strict";
import { test } from "node:test";
import { retryStream } from "../src/ai/retry.ts";

/** A socket dying mid-stream, exactly as undici reports it. */
function socketError(): Error {
	const error = new Error("terminated");
	(error as Error & { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
	return error;
}

async function collect<T>(stream: AsyncGenerator<T, void>): Promise<T[]> {
	const seen: T[] = [];
	for await (const value of stream) seen.push(value);
	return seen;
}

const noSleep = async () => {};

test("a stream that completes is passed straight through", async () => {
	let resets = 0;
	const seen = await collect(
		retryStream(
			async function* () {
				yield "a";
				yield "b";
			},
			{ reset: () => resets++, sleep: noSleep },
		),
	);
	assert.deepEqual(seen, ["a", "b"]);
	assert.equal(resets, 1, "reset runs once per attempt, including the first");
});

test("a stream that dies part way through starts over", async () => {
	const attempts: number[] = [];
	const retries: { attempt: number; reason: string }[] = [];
	const seen = await collect(
		retryStream(
			async function* (attempt) {
				attempts.push(attempt);
				yield `start-${attempt}`;
				if (attempt === 1) throw socketError();
				yield "finished";
			},
			{ reset: () => {}, sleep: noSleep, onRetry: (info) => retries.push(info) },
		),
	);

	assert.deepEqual(attempts, [1, 2]);
	// The failed attempt's output was still emitted; the caller replaces rather than appends.
	assert.deepEqual(seen, ["start-1", "start-2", "finished"]);
	assert.equal(retries.length, 1);
	assert.equal(retries[0].reason, "UND_ERR_SOCKET", "the cause is named, not just 'terminated'");
});

test("state is cleared before every attempt", async () => {
	const content: string[] = [];
	await collect(
		retryStream(
			async function* (attempt) {
				content.push(`chunk-${attempt}`);
				if (attempt < 3) throw socketError();
				yield "ok";
			},
			{ reset: () => (content.length = 0), sleep: noSleep },
		),
	);
	assert.deepEqual(content, ["chunk-3"], "only the successful attempt's output survives");
});

test("it gives up after the last attempt and rethrows", async () => {
	await assert.rejects(
		collect(
			retryStream(
				async function* () {
					yield "x";
					throw socketError();
				},
				{ attempts: 2, reset: () => {}, sleep: noSleep },
			),
		),
		/terminated/,
	);
});

test("an error that is not worth retrying is not retried", async () => {
	let attempts = 0;
	await assert.rejects(
		collect(
			retryStream(
				async function* () {
					attempts++;
					throw new Error("400 Bad Request");
					// biome-ignore lint/correctness/noUnreachable: the yield types the generator
					yield "never";
				},
				{ reset: () => {}, sleep: noSleep },
			),
		),
		/400/,
	);
	assert.equal(attempts, 1);
});

test("an aborted stream stops rather than starting over", async () => {
	const controller = new AbortController();
	let attempts = 0;
	await assert.rejects(
		collect(
			retryStream(
				async function* () {
					attempts++;
					controller.abort();
					throw socketError();
				},
				{ reset: () => {}, sleep: noSleep, signal: controller.signal },
			),
		),
		/terminated/,
	);
	assert.equal(attempts, 1, "the user stopping it is not a failure to recover from");
});
