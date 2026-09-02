/**
 * The `window.lyra` the phone hands the desktop's own interface.
 *
 * Everything the renderer does goes through this object, and it fails in the least helpful way
 * available: a missing method is a TypeError thrown inside a React render, which the error
 * boundary turns into a blank screen with a message about the renderer rather than about the
 * connection. So the shape matters as much as the behaviour, and the shape is what this checks.
 *
 * Run against the generated source in a sandbox rather than in a WebView, because what is being
 * tested is the script — that it parses, that it builds the object it claims to, and that the
 * floor under it answers in the way each kind of caller expects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeScript } from "../src/bridge.ts";
import type { Connection } from "../src/client.ts";

const LAN: Connection = { host: "192.168.1.5", port: 4517, token: "tok", platform: "darwin" };

/**
 * Run the bridge with a stubbed browser around it, and return what it installed.
 *
 * `WebSocket` and `fetch` are replaced so the script's own connect-on-load does not reach the
 * network; the calls it makes are recorded instead.
 */
function install(connection: Connection = LAN) {
	const calls: { url: string; body: unknown }[] = [];
	const sockets: string[] = [];

	const scope = {
		document: { documentElement: { setAttribute() {} }, addEventListener() {} },
		WebSocket: class {
			onopen: (() => void) | null = null;
			onmessage: ((event: { data: string }) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(url: string) {
				sockets.push(url);
			}
			close() {}
		},
		fetch: async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return { ok: true, json: async () => ({ ok: true, value: "答案" }) };
		},
		setTimeout: () => 0,
		navigator: { clipboard: { writeText() {} } },
	} as Record<string, unknown>;

	const window: Record<string, unknown> = scope;
	scope.window = window;

	// Evaluated with `window` and the browser globals in scope, which is what a WebView provides.
	const run = new Function("window", "document", "WebSocket", "fetch", "setTimeout", "navigator", bridgeScript(connection));
	run(window, scope.document, scope.WebSocket, scope.fetch, scope.setTimeout, scope.navigator);

	return { lyra: window.lyra as Record<string, never>, calls, sockets };
}

test("the script parses and installs an object", () => {
	const { lyra } = install();
	assert.equal(typeof lyra, "object");
	assert.equal((lyra as { platform: string }).platform, "darwin");
	assert.equal((lyra as { host: string }).host, "mobile");
});

test("the socket points at the desktop, carrying the token", () => {
	const { sockets } = install();
	assert.equal(sockets.length, 1);
	assert.match(sockets[0], /^ws:\/\/192\.168\.1\.5:4517\/ws\?token=tok$/);
});

test("a TLS connection speaks wss and https", () => {
	const { sockets, lyra } = install({ ...LAN, tls: true });
	assert.match(sockets[0], /^wss:\/\//);
	void (lyra as unknown as { settings: { get(): Promise<unknown> } }).settings.get();
});

test("a call becomes one RPC post, with the method and args intact", async () => {
	const { lyra, calls } = install();
	const api = lyra as unknown as { sessions: { transcript(a: string, b: string): Promise<unknown> } };
	const answer = await api.sessions.transcript("p1", "s1");

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://192.168.1.5:4517/api/rpc");
	assert.deepEqual(calls[0].body, { method: "sessions.transcript", args: ["p1", "s1"] });
	assert.equal(answer, "答案");
});

test("every group the renderer reaches for is present", () => {
	// Not an arbitrary list: these are the ones `store.ts` and its slices touch on the startup
	// path, and a missing one is a blank screen rather than a missing feature.
	const lyra = install().lyra as unknown as Record<string, unknown>;
	for (const group of ["settings", "sessions", "agent", "workspace", "subAgents", "sideChat", "git", "system", "clipboard"]) {
		assert.equal(typeof lyra[group], "object", `缺少 ${group}`);
	}
});

test("a method nobody wrote down still answers, rather than throwing", async () => {
	/*
	 * The interface is 177 methods and grows; the phone must degrade when the desktop gains one
	 * rather than break. `onSomething` gets an unsubscribe function because that is what its
	 * callers store and later call; everything else resolves to null, which is what every caller
	 * already handles as "no data".
	 */
	const lyra = install().lyra as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;

	const unsubscribe = lyra.updates.onProgress(() => {});
	assert.equal(typeof unsubscribe, "function", "订阅要返回退订函数");
	assert.doesNotThrow(() => (unsubscribe as () => void)());

	assert.equal(await lyra.updates.somethingNew(), null);
	assert.equal(await lyra.aWholeNewGroup.aWholeNewMethod(), null);
});

test("an unlisted method on the root is callable, not just reachable", async () => {
	/*
	 * Found on a real phone, not here: the interface carries methods and groups side by side at the
	 * top level — `setWindowTheme` is a method, `settings` is a group — and nothing in the name says
	 * which. A floor that assumed "group" handed back an object, and the app died on the first
	 * top-level method the desktop called, before anything had rendered.
	 */
	const lyra = install().lyra as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
	assert.equal(await lyra.setWindowTheme({ color: "#111", symbolColor: "#eee" }), null);
});

test("the same name works as a group if that is how it is used", async () => {
	// The other half of the same problem: one floor has to answer both ways, because the caller
	// decides which it is and the bridge finds out afterwards.
	const lyra = install().lyra as unknown as Record<string, Record<string, () => Promise<unknown>>>;
	assert.equal(await lyra.somethingNew.deeper.stillFine(), null);
});

test("awaiting something that fell through the floor settles", async () => {
	/*
	 * `await` looks for `.then`, and the floor answers every name — so without a carve-out it would
	 * hand back a function, `await` would call it expecting a resolver, and the turn would hang
	 * with no error to show for it.
	 */
	const lyra = install().lyra as unknown as Record<string, unknown>;
	const reached = await (lyra.neverHeardOfIt as Promise<unknown>);
	assert.equal(typeof reached, "function", "兜底节点本身是可调用的，await 它只会原样拿回来");
});

test("a subscription on the root still returns an unsubscribe", () => {
	// `onFullScreenChange` is read at mount and its result is stored to be called on unmount.
	const lyra = install().lyra as unknown as Record<string, (h: () => void) => unknown>;
	const off = lyra.onFullScreenChange(() => {});
	assert.equal(typeof off, "function");
	assert.doesNotThrow(() => (off as () => void)());
});

test("subscribing to agent events hands back a working unsubscribe", () => {
	const lyra = install().lyra as unknown as {
		agent: { onEvent(handler: (payload: unknown) => void): () => void };
	};
	let seen = 0;
	const off = lyra.agent.onEvent(() => {
		seen++;
	});
	assert.equal(typeof off, "function");
	off();
	assert.equal(seen, 0);
});

test("a refused method reads as nothing, not as an error", async () => {
	/*
	 * Half of what the renderer calls has no meaning on a phone and is absent from the desktop's
	 * allowlist. Throwing would turn a page that should quietly omit a feature into a crash.
	 */
	const calls: unknown[] = [];
	const scope = {
		document: { documentElement: { setAttribute() {} }, addEventListener() {} },
		WebSocket: class {
			close() {}
		},
		fetch: async () => ({ ok: true, json: async () => ({ ok: false, error: "method-not-allowed" }) }),
		setTimeout: () => 0,
		navigator: { clipboard: { writeText() {} } },
	} as Record<string, unknown>;
	const window: Record<string, unknown> = scope;
	scope.window = window;
	const run = new Function("window", "document", "WebSocket", "fetch", "setTimeout", "navigator", bridgeScript(LAN));
	run(window, scope.document, scope.WebSocket, scope.fetch, scope.setTimeout, scope.navigator);

	const lyra = window.lyra as unknown as { sessions: { transcript(a: string, b: string): Promise<unknown> } };
	// A method that does go over RPC, so the server's refusal is what is being read.
	assert.equal(await lyra.sessions.transcript("p", "s"), null);
	assert.equal(calls.length, 0);
});

test("a genuine failure does throw, so it is not mistaken for absence", async () => {
	const scope = {
		document: { documentElement: { setAttribute() {} }, addEventListener() {} },
		WebSocket: class {
			close() {}
		},
		fetch: async () => ({ ok: true, json: async () => ({ ok: false, error: "会话不存在" }) }),
		setTimeout: () => 0,
		navigator: { clipboard: { writeText() {} } },
	} as Record<string, unknown>;
	const window: Record<string, unknown> = scope;
	scope.window = window;
	const run = new Function("window", "document", "WebSocket", "fetch", "setTimeout", "navigator", bridgeScript(LAN));
	run(window, scope.document, scope.WebSocket, scope.fetch, scope.setTimeout, scope.navigator);

	const lyra = window.lyra as unknown as { sessions: { transcript(a: string, b: string): Promise<unknown> } };
	await assert.rejects(() => lyra.sessions.transcript("p", "s"), /会话不存在/);
});

test("the token is escaped into the socket URL", () => {
	const { sockets } = install({ ...LAN, token: "a b&c" });
	assert.match(sockets[0], /token=a%20b%26c$/);
});

test("the generated script has no stray backtick in it", () => {
	/*
	 * The bridge is one long template literal, so a backtick anywhere inside it — including inside a
	 * comment, which is where it keeps happening — ends the string early and the whole module stops
	 * parsing. It has cost two rounds of "why is the file failing rather than the test", both times
	 * from writing `inert` in prose out of habit.
	 *
	 * Checked on the *output* rather than the source, because that is what has to survive: an
	 * escaped backtick in the source is fine and appears here as a plain one.
	 */
	const script = bridgeScript(LAN);
	assert.doesNotThrow(() => new Function(script), "生成的脚本本身要能解析");

	// And it really is one template literal in the source, which is what makes the above a risk
	// rather than a curiosity.
	assert.ok(script.startsWith("(() => {"), "脚本应当是一整段立即执行函数");
});

/*
 * The half of Android's back button that lives in the page.
 *
 * There is no Android emulator on this machine, so this is the closest thing to running it: the
 * script is evaluated with a document that can be changed underneath it, and what it reports is
 * read back. `back.test.ts` covers what the native side does with those numbers.
 */

/** A document with a mutable set of elements, and a MutationObserver that fires on demand. */
function pageWith(elements: { attrs: string[] }[]) {
	const posted: string[] = [];
	let observer: (() => void) | null = null;
	const listeners: Record<string, (() => void)[]> = {};

	const element = (el: { attrs: string[] }) => ({ hasAttribute: (name: string) => el.attrs.includes(name) });
	const documentElement = { setAttribute() {} };
	const document = {
		documentElement,
		body: {},
		querySelectorAll(selector: string) {
			const wanted = selector === '[data-pane="drawer"]' ? "data-pane" : "aria-modal";
			return elements.filter((el) => el.attrs.includes(wanted)).map(element);
		},
		addEventListener(type: string, handler: () => void) {
			(listeners[type] ??= []).push(handler);
		},
		dispatchEvent: () => true,
	};

	const scope = {
		document,
		WebSocket: class {
			close() {}
		},
		fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }),
		setTimeout: () => 0,
		navigator: {},
		KeyboardEvent: class {
			type: string;
			constructor(type: string) {
				this.type = type;
			}
		},
		MutationObserver: class {
			constructor(handler: () => void) {
				observer = handler;
			}
			observe() {}
		},
	} as Record<string, unknown>;

	const window: Record<string, unknown> = scope;
	scope.window = window;
	window.ReactNativeWebView = { postMessage: (data: string) => posted.push(data) };

	const run = new Function(
		"window",
		"document",
		"WebSocket",
		"fetch",
		"setTimeout",
		"navigator",
		"KeyboardEvent",
		"MutationObserver",
		bridgeScript(LAN),
	);
	run(
		window,
		document,
		scope.WebSocket,
		scope.fetch,
		scope.setTimeout,
		scope.navigator,
		scope.KeyboardEvent,
		scope.MutationObserver,
	);

	return {
		window,
		posted,
		/** Change what is on the page, then let the observer notice. */
		change(next: { attrs: string[] }[]) {
			elements = next;
			observer?.();
		},
	};
}

test("the page reports how many layers it has open", () => {
	const page = pageWith([{ attrs: ["data-pane", "aria-modal", "inert"] }]);
	assert.deepEqual(JSON.parse(page.posted[0]), { type: "layers", depth: 0 }, "关着的抽屉不算一层");

	page.change([{ attrs: ["data-pane", "aria-modal"] }]);
	assert.deepEqual(JSON.parse(page.posted[1]), { type: "layers", depth: 1 }, "抽屉打开了要报上去");

	page.change([{ attrs: ["data-pane", "aria-modal"] }, { attrs: ["aria-modal"] }]);
	assert.deepEqual(JSON.parse(page.posted[2]), { type: "layers", depth: 2 });
});

test("an unchanged depth is not reported again", () => {
	/*
	 * The observer watches the whole document, and a streaming reply changes it constantly. Posting
	 * on every mutation would put a message across the bridge for every token.
	 */
	const page = pageWith([{ attrs: ["data-pane", "aria-modal", "inert"] }]);
	const before = page.posted.length;
	page.change([{ attrs: ["data-pane", "aria-modal", "inert"] }]);
	page.change([{ attrs: ["data-pane", "aria-modal", "inert"] }]);
	assert.equal(page.posted.length, before, "层数没变就不该再发");
});

test("closing a layer is offered as a function the native side can call", () => {
	// Android's back button reaches the page through this and nothing else.
	const page = pageWith([]);
	assert.equal(typeof page.window.__lyraBack, "function");
	assert.doesNotThrow(() => (page.window.__lyraBack as () => void)());
});
