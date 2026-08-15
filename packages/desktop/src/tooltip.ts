/**
 * One tooltip for the whole window, driven by an attribute.
 *
 * The React `<Tooltip>` wrapper could only reach elements React renders. CodeMirror builds its
 * search panel itself, so its buttons were stuck with the native `title` — a different shape, a
 * different delay, and the wrong colour against the rest of the app.
 *
 * An attribute works on anything: `data-ly-tip="下一个"` on a React node or on a DOM node
 * CodeMirror just created behaves identically, because the thing that shows the bubble is a
 * single listener on the document rather than a component per target.
 */

const DELAY_MS = 420;
const GAP = 6;
const MARGIN = 6;

let host: HTMLElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;

function ensureHost(): HTMLElement {
	if (host) return host;
	host = document.createElement("div");
	host.className = "ly-tooltip";
	host.setAttribute("role", "tooltip");
	host.style.position = "fixed";
	host.style.zIndex = "200";
	host.style.pointerEvents = "none";
	host.hidden = true;
	document.body.appendChild(host);
	return host;
}

/** The nearest ancestor carrying a tip, so an icon inside a button still counts as the button. */
function targetOf(node: EventTarget | null): HTMLElement | null {
	if (!(node instanceof Element)) return null;
	const el = node.closest<HTMLElement>("[data-ly-tip]");
	return el && el.dataset.dwTip ? el : null;
}

function place(el: HTMLElement) {
	const tip = ensureHost();
	tip.textContent = el.dataset.dwTip ?? "";
	tip.hidden = false;

	const a = el.getBoundingClientRect();
	const b = tip.getBoundingClientRect();
	const preferred = el.dataset.dwTipSide === "top" ? "top" : "bottom";

	const below = a.bottom + GAP;
	const above = a.top - b.height - GAP;
	// Flip rather than run off the edge of the window.
	const fits = preferred === "bottom" ? below + b.height < window.innerHeight - MARGIN : above > MARGIN;
	const top = (preferred === "bottom") === fits ? (preferred === "bottom" ? below : above) : preferred === "bottom" ? above : below;

	const left = Math.min(Math.max(MARGIN, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - MARGIN);
	tip.style.left = `${Math.round(left)}px`;
	tip.style.top = `${Math.round(top)}px`;
}

function hide() {
	window.clearTimeout(timer);
	current = null;
	if (host) host.hidden = true;
}

/**
 * Deliberately not shown on focus.
 *
 * Keyboard users get the accessible name from the label, and a bubble that appears while
 * tabbing through a toolbar is noise rather than help.
 */
export function installTooltips() {
	document.addEventListener(
		"pointerover",
		(event) => {
			const el = targetOf(event.target);
			if (el === current) return;
			hide();
			if (!el) return;
			current = el;
			timer = window.setTimeout(() => {
				// Still under the pointer, and still in the document, by the time the delay is up.
				if (current === el && el.isConnected) place(el);
			}, DELAY_MS);
		},
		true,
	);

	// Any of these means the target is gone or no longer the thing being pointed at.
	for (const type of ["pointerdown", "pointerout", "wheel", "keydown"] as const) {
		document.addEventListener(type, hide, true);
	}
	window.addEventListener("blur", hide);
	window.addEventListener("scroll", hide, true);
}
