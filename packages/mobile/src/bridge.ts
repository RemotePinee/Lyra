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
			} else if (message.type === "settings_changed") {
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
	const isSubscription = (name) => name.startsWith("on") && name.length > 2 && name[2] === name[2].toUpperCase();

	/*
	 * An unknown name has to work both ways, because nothing about the name says which it is.
	 *
	 * window.lyra carries methods and groups side by side — setWindowTheme is a method, settings is
	 * a group — so a floor that guesses is wrong half the time, and being wrong either way is the
	 * blank screen this exists to prevent. (It was: guessing "group" turned every unlisted
	 * top-level *method* into a TypeError the moment the desktop called one.) So the floor is a
	 * callable Proxy instead of a guess: call it and it resolves to null, reach through it and you
	 * get another one, to any depth.
	 */
	const floorGet = (_target, prop) => {
		if (typeof prop === "symbol") return undefined;
		const name = String(prop);
		// Without this, awaiting anything that fell through here would find a "then" that is a
		// function, and the await would never settle.
		if (name === "then") return undefined;
		// An \`onSomething\` is subscribed to, and its return value is stored and later called to
		// unsubscribe — a promise there is a TypeError one navigation later.
		return isSubscription(name) ? () => () => {} : floorNode();
	};
	const floorNode = () => new Proxy(function () {}, { get: floorGet, apply: () => Promise.resolve(null) });

	const withFloor = (group) => new Proxy(group, {
		get(target, prop) {
			if (prop in target) return target[prop];
			return floorGet(target, prop);
		},
	});

	/*
	 * Marked on the document too, so stylesheets can reach it.
	 *
	 * The touch adjustments below are CSS, not props: they are about hit areas and hover states,
	 * which are the stylesheet's business, and threading a flag through fifty components to say
	 * the same thing would be fifty places to forget it.
	 */
	const markHost = () => document.documentElement?.setAttribute("data-lyra-host", "mobile");
	markHost();
	if (!document.documentElement) document.addEventListener("readystatechange", markHost, { once: true });

	/*
	 * How many layers are open, reported outward for Android's back button.
	 *
	 * The native side has to answer BackHandler on the spot and cannot wait for a round trip in
	 * here, so it keeps a mirror of this number instead of asking. Read off attributes the renderer
	 * already maintains — see layerDepth in back.ts, which this is the other half of.
	 */
	const layerDepth = () => {
		let depth = 0;
		for (const el of document.querySelectorAll('[data-pane="drawer"]')) {
			if (!el.hasAttribute("inert")) depth++;
		}
		for (const el of document.querySelectorAll('[aria-modal="true"]')) {
			// The drawer is itself aria-modal while it is one, and must not be counted twice.
			if (!el.hasAttribute("inert") && !el.hasAttribute("data-pane")) depth++;
		}
		return depth;
	};

	let lastDepth = -1;
	const reportDepth = () => {
		const depth = layerDepth();
		if (depth === lastDepth) return;
		lastDepth = depth;
		window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "layers", depth }));
	};

	/**
	 * Close one layer, by pressing Escape on the page's behalf.
	 *
	 * The renderer already closes its topmost layer on Escape — the drawer, a dialog, a menu — so
	 * back reuses that rather than reaching into React state it has no handle on.
	 */
	window.__lyraBack = () => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	};

	/*
	 * The page's own theme, reported outward so the phone's chrome can match it.
	 *
	 * The interface can be switched between light and dark from the desktop, and the parts of the
	 * screen that are not the WebView — the status bar, the strips behind the notch and the home
	 * indicator — are painted by the native side, which has no way to know. Left alone they stay
	 * dark: white status text on a white page, and a dark border around a light one.
	 */
	let lastTheme = "";
	const reportTheme = () => {
		const root = document.documentElement;
		if (!root) return;
		const dark = root.classList.contains("dark");
		// The variable rather than a hardcoded pair, so a new theme is carried across without this
		// needing to know about it.
		const shell = getComputedStyle(root).getPropertyValue("--color-shell").trim();
		const theme = JSON.stringify({ type: "theme", dark, shell });
		if (theme === lastTheme) return;
		lastTheme = theme;
		window.ReactNativeWebView?.postMessage(theme);
	};

	const watchLayers = () => {
		if (!document.body) return;
		reportDepth();
		reportTheme();
		// Only this element and only its class: the theme is one attribute in one place, and
		// watching the subtree for it would fire on every row that toggles a class.
		new MutationObserver(reportTheme).observe(document.documentElement, { attributeFilter: ["class"] });
		// Attributes only: inert going on and off a drawer is the signal, and watching characterData
		// as well would fire this on every token of a streaming reply.
		new MutationObserver(reportDepth).observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["inert", "aria-modal"],
		});
	};
	if (document.body) watchLayers();
	else document.addEventListener("DOMContentLoaded", watchLayers, { once: true });

	const api = {
		platform: ${JSON.stringify(connection.platform ?? "darwin")},
		host: "mobile",

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
	// The root gets the same floor as the groups: it holds both kinds of name, and so does the
	// floor. onFullScreenChange and setWindowTheme both live up here, and both used to throw.
	window.lyra = withFloor(api);
})();`;
}
