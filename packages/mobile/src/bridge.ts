/**
 * `window.lyra`, spoken over the network instead of over Electron IPC.
 *
 * The phone shows the desktop's own renderer — the same React app, the same settings pages, the
 * same conversation. That app knows how to talk to exactly one thing: `window.lyra`. On the
 * desktop the preload builds it out of IPC channels; here it is built out of HTTP calls and one
 * WebSocket, and the app cannot tell the difference. That is the whole design: nothing about the
 * interface is duplicated, so nothing about it can drift.
 *
 * Generated as a script that runs in the WebView *before* the renderer's bundle, because the very
 * first thing the app does is read this object.
 */

import type { Connection } from "./client";

/**
 * The script to inject, as source.
 *
 * A string rather than a module because it runs inside the WebView's world, not this one — the two
 * share no scope, and the only way across is text.
 *
 * The token is interpolated in. That is a secret in a string, which is worth being deliberate
 * about: it is the same secret the WebView needs to make any call at all, the WebView loads only
 * this app's own origin, and the alternative — a handshake to fetch it — would put it in the same
 * place one round trip later.
 */
export function bridgeScript(connection: Connection): string {
	const scheme = connection.tls ? "https" : "http";
	const wsScheme = connection.tls ? "wss" : "ws";
	const origin = `${scheme}://${connection.host}:${connection.port}`;
	const socketUrl = `${wsScheme}://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`;

	return `(() => {
	const ORIGIN = ${JSON.stringify(origin)};
	const SOCKET = ${JSON.stringify(socketUrl)};
	const TOKEN = ${JSON.stringify(connection.token)};

	/** Listeners for each kind of push the desktop sends. */
	const subscribers = { agent: new Set(), sideChat: new Set(), settings: new Set(), sync: new Set() };

	/*
	 * One socket, reopened for as long as the page lives.
	 *
	 * The renderer subscribes once at startup and assumes the channel stays; a phone's does not —
	 * it drops every time the screen locks. Reconnecting under it keeps that assumption true, and
	 * the desktop replays from the session log on the next read, so nothing is lost by the gap.
	 */
	let socket = null;
	let backoff = 500;
	function connect() {
		try {
			socket = new WebSocket(SOCKET);
		} catch {
			setTimeout(connect, backoff);
			return;
		}
		socket.onopen = () => { backoff = 500; };
		socket.onmessage = (event) => {
			let message;
			try { message = JSON.parse(event.data); } catch { return; }
			if (message.type === "agent_event") {
				for (const fn of subscribers.agent) fn({ sessionId: message.sessionId, event: message.event });
			} else if (message.type === "settings") {
				for (const fn of subscribers.settings) fn(message.settings);
			}
		};
		socket.onclose = () => {
			socket = null;
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 10000);
		};
		socket.onerror = () => { try { socket && socket.close(); } catch {} };
	}
	connect();

	async function rpc(method, args) {
		const response = await fetch(ORIGIN + "/api/rpc", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
			body: JSON.stringify({ method, args }),
		});
		if (!response.ok) throw new Error("同步服务返回 " + response.status);
		const body = await response.json();
		/*
		 * A refused method is not an error to throw at the UI.
		 *
		 * Half of what the renderer calls has no meaning on a phone — a terminal, the screenshot
		 * tool, writing files. Those are not on the allowlist, and the honest answer to the caller
		 * is "nothing", which every one of them already handles: an empty list, a null, a section
		 * that does not render. Throwing would turn a page that should quietly omit a feature into
		 * a crash.
		 */
		if (!body.ok) {
			if (body.error === "method-not-allowed") return null;
			throw new Error(body.error || "调用失败");
		}
		return body.value;
	}

	const call = (method) => (...args) => rpc(method, args);
	const subscribe = (set) => (handler) => { set.add(handler); return () => set.delete(handler); };
	/** For the many methods that exist only on the desktop: answer nothing, immediately. */
	const absent = () => Promise.resolve(null);
	const absentList = () => Promise.resolve([]);

	/*
	 * Named where it matters, with a floor under the rest.
	 *
	 * The renderer's interface is 177 methods and it grows; writing every one out by hand means
	 * the phone breaks each time the desktop gains a feature, and it breaks *hard* — a missing
	 * method is a TypeError inside a React render, which the error boundary turns into a blank
	 * screen. So the ones that matter are named below (that list is the phone's real surface, and
	 * worth reading), and anything not named falls through to a stub that behaves like the shape
	 * of its name: an \`onSomething\` returns an unsubscribe function, everything else resolves to
	 * null. Both are answers the callers already handle, because both are what an absent feature
	 * looks like.
	 *
	 * This is not the security boundary. The allowlist on the desktop is — a stub here that
	 * resolves to null cannot reach the machine even if something calls it.
	 */
	const stub = (name) => (name.startsWith("on") && name.length > 2 && name[2] === name[2].toUpperCase()
		? () => () => {}
		: () => Promise.resolve(null));
	const withFloor = (group) => new Proxy(group, {
		get(target, prop) {
			if (prop in target) return target[prop];
			if (typeof prop === "symbol") return undefined;
			return stub(String(prop));
		},
	});

	const api = {
		platform: ${JSON.stringify(connection.platform ?? "darwin")},

		settings: {
			get: call("settings.get"),
			save: call("settings.save"),
			onChanged: subscribe(subscribers.settings),
		},
		workspace: {
			info: call("workspace.info"),
			pick: absent,
			reveal: absent,
		},
		sessions: {
			list: call("sessions.list"),
			create: call("sessions.create"),
			open: call("sessions.open"),
			transcript: call("sessions.transcript"),
			trajectory: absentList,
			fork: absent,
			remove: call("sessions.remove"),
			setArchived: call("sessions.setArchived"),
			removeArchived: absentList,
			capabilities: call("sessions.capabilities"),
			rename: call("sessions.rename"),
			compact: absent,
			contextBreakdown: absent,
		},
		agent: {
			prompt: call("agent.prompt"),
			editMessage: call("agent.editMessage"),
			abort: call("agent.abort"),
			approve: call("agent.approve"),
			setModel: call("agent.setModel"),
			setThinking: call("agent.setThinking"),
			onEvent: subscribe(subscribers.agent),
		},
		subAgents: {
			list: call("subAgents.list"),
			detail: absent,
			steer: absent,
			abort: absent,
			dismiss: absent,
			dismissFinished: absent,
		},
		sideChat: {
			state: absent,
			ask: absent,
			editAndResend: absent,
			abort: absent,
			reset: absent,
			onEvent: subscribe(subscribers.sideChat),
		},
		tasks: { list: absentList, cancel: absent, dismiss: absent, resume: absent },
		git: {
			scratchRoots: absentList,
			generalScratch: absent,
			repos: absentList,
			status: absent,
			worktrees: absentList,
		},
		sync: { status: absent, start: absent, stop: absent, rotateToken: absent },
		system: { platform: () => Promise.resolve(window.lyra.platform), openPath: absent, openExternal: absent },
		clipboard: {
			writeText: (text) => { try { navigator.clipboard.writeText(text); } catch {} return Promise.resolve(null); },
			readText: () => Promise.resolve(""),
		},

		/*
		 * Everything below is a desktop capability with no phone equivalent, present so the
		 * renderer's calls resolve rather than throw. They are absent from the allowlist too, so
		 * this is defence in depth rather than the only gate.
		 */
		files: { list: absentList, read: absent, document: absent, bytes: absent, write: absent, mediaUrl: () => "" },
		terminal: { list: absentList, attach: absent, detach: absent, write: absent, resize: absent, close: absent },
		screenshot: { start: absent, cancel: absent },
		plugins: { list: absentList, install: absent, remove: absent },
		updates: { check: absent, download: absent, install: absent },
		format: { external: absent, available: absent, config: absent },
		index: { status: absent, rebuild: absent },
		scheduler: { list: absentList, save: absent, remove: absent },
		forge: { accounts: absentList, add: absent, remove: absent, rename: absent },
		memory: { list: absentList, remove: absent },
		diff: { workspaceDiff: absentList },
		commands: { list: () => Promise.resolve({ commands: [], skills: [] }) },
		providers: { test: absent, models: absentList },
		usage: { summary: absent, sessions: absentList },
		documents: { open: absent },

		onMainError: subscribe(new Set()),
		onTrayCommand: subscribe(new Set()),
	};

	// Each group gets the same floor, so a new method anywhere degrades instead of throwing.
	for (const key of Object.keys(api)) {
		if (api[key] && typeof api[key] === "object") api[key] = withFloor(api[key]);
	}
	window.lyra = withFloor(api);
})();`;
}
