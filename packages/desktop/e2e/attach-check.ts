/** Ask a running dev instance what it is actually rendering. Scratch — delete after use. */

const port = process.argv[2] ?? "9345";
const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as {
	type: string;
	webSocketDebuggerUrl?: string;
}[];
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page?.webSocketDebuggerUrl) throw new Error("no page");

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(page!.webSocketDebuggerUrl!);
		socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id !== 1) return;
			socket.close();
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result as T);
		});
		socket.addEventListener("error", reject);
		setTimeout(() => reject(new Error("timeout")), 15_000);
	});
}

const result = await call<{ result: { value: unknown } }>("Runtime.evaluate", {
	expression: `(() => {
		const view = document.querySelector(".ly-sidebar-fill .ly-scroll-view");
		if (!view) return { error: "no sidebar scroller" };
		const head = view.querySelector("[data-ly-head]");
		const strip = view.querySelector("[data-ly-rail]");
		const fold = view.querySelector(".grid");
		return {
			// Present only in the old hand-placed version.
			staleOverlay: Boolean(document.querySelector("[data-ly-band], [data-ly-pin]")),
			rail: getComputedStyle(view).getPropertyValue("--ly-rail").trim(),
			stripPosition: strip ? getComputedStyle(strip).position : null,
			stripTop: strip ? getComputedStyle(strip).top : null,
			headPosition: head ? getComputedStyle(head).position : null,
			headTop: head ? getComputedStyle(head).top : null,
			foldColumns: fold ? getComputedStyle(fold).gridTemplateColumns : null,
		};
	})()`,
	returnByValue: true,
});
process.stdout.write(`${JSON.stringify(result.result.value, null, 1)}\n`);
