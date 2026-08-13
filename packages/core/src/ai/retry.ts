/**
 * Retrying the request, but never the stream.
 *
 * A turn can spend a minute assembling its context — reading files, running tools, packing a
 * hundred thousand tokens of history — and then lose all of it to one closed socket. That is
 * what `fetch failed (UND_ERR_SOCKET)` is: the far end hung up before answering, which relays
 * and proxies do routinely under load. It says nothing about whether the request was wrong.
 *
 * Only the connection attempt is retried. Once the response body starts arriving the model is
 * already emitting text, and re-sending would either duplicate what was shown or bill for a
 * second generation — so from that point a failure is reported as it happens.
 */

/** Transport-level failures, none of which mean the request itself was bad. */
const RETRYABLE_CAUSES = new Set([
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
]);

/**
 * Status codes worth a second attempt.
 *
 * 429 is the server asking to be asked later. The 5xx range here is the set that means "not
 * right now" rather than "not ever" — a 500 from a relay is usually one bad upstream node, and
 * 501 or 505 are excluded because repeating them changes nothing.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export interface RetryOptions {
	/** Total attempts, including the first. */
	attempts?: number;
	signal?: AbortSignal;
	/** Called before each wait, so a caller can tell the user what is happening. */
	onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
	/** Injected in tests so they do not sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export function isRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const cause = (error as { cause?: { code?: string } }).cause;
	if (cause?.code && RETRYABLE_CAUSES.has(cause.code)) return true;
	// undici reports a bare "fetch failed" with the cause attached; some runtimes lose the cause.
	return error.message === "fetch failed" || error.message.includes("socket hang up");
}

export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUS.has(status);
}

/**
 * How long to wait, honouring the server's own answer when it gives one.
 *
 * `Retry-After` comes as either seconds or an HTTP date. A server under rate limiting knows
 * better than any backoff curve we could pick, so its number wins — capped, because a relay
 * asking us to wait ten minutes is not something to do silently inside one turn.
 */
export function retryDelay(attempt: number, response?: Response): number {
	const header = response?.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
		if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 30_000);
	}
	// 600ms, 1.8s, 5.4s — with jitter, so a fleet of clients does not return in lockstep.
	// The ceiling is applied *after* the jitter: capping first lets the ±25% push the result
	// back over the limit, which is what the test caught.
	const base = 600 * 3 ** (attempt - 1);
	return Math.min(base * (0.75 + Math.random() * 0.5), 20_000);
}

/**
 * Perform a request, retrying only what is safe to retry.
 *
 * Returns the response as soon as one arrives with a status worth keeping — including a 4xx,
 * which the caller reports as-is. Throws the last transport error if every attempt failed.
 */
export async function fetchWithRetry(
	doFetch: typeof globalThis.fetch,
	url: string,
	init: RequestInit,
	options: RetryOptions = {},
): Promise<Response> {
	const attempts = Math.max(1, options.attempts ?? 3);
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (options.signal?.aborted) break;
		try {
			const response = await doFetch(url, init);
			if (attempt < attempts && isRetryableStatus(response.status)) {
				// The body is not read: nothing has been shown to anyone, and a fresh attempt
				// replaces it entirely.
				const delay = retryDelay(attempt, response);
				options.onRetry?.({ attempt, delayMs: delay, reason: `HTTP ${response.status}` });
				await sleep(delay);
				continue;
			}
			return response;
		} catch (error) {
			lastError = error;
			// A cancelled turn is not a failed one; stop immediately rather than waiting to retry.
			if (options.signal?.aborted || !isRetryableError(error) || attempt === attempts) throw error;
			const delay = retryDelay(attempt);
			options.onRetry?.({ attempt, delayMs: delay, reason: describeCause(error) });
			await sleep(delay);
		}
	}

	throw lastError ?? new Error("请求已取消");
}

function describeCause(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as { cause?: { code?: string } }).cause;
	return cause?.code ?? error.message;
}
