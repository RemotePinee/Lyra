/** Minimal SSE reader. Yields one parsed frame per `data:` payload. */

export interface SseFrame {
	event?: string;
	data: string;
}

export async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<SseFrame> {
	const body = response.body;
	if (!body) throw new Error("Response has no body");

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const onAbort = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// Frames are separated by a blank line. \r\n is tolerated for proxies that rewrite line endings.
			let sep: number;
			while ((sep = findFrameBoundary(buffer)) !== -1) {
				const raw = buffer.slice(0, sep);
				buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");
				const frame = parseFrame(raw);
				if (frame) yield frame;
			}
		}
		const tail = parseFrame(buffer);
		if (tail) yield tail;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock?.();
	}
}

function findFrameBoundary(buffer: string): number {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf === -1) return crlf;
	if (crlf === -1) return lf;
	return Math.min(lf, crlf);
}

function parseFrame(raw: string): SseFrame | null {
	const lines = raw.split(/\r?\n/);
	let event: string | undefined;
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}

/**
 * Parse tool-call arguments that may be truncated mid-stream.
 *
 * A model that hits the output limit leaves `{"path": "/a/b` on the wire. Returning `{}` there
 * would hand the tool a silently empty argument set, so callers get `null` and fail the call
 * instead of executing something wrong.
 */
export function parseToolArguments(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
