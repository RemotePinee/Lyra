/**
 * Serving the desktop's own interface to the phone.
 *
 * The phone does not ship a copy of the UI — it loads this one, from the machine it is paired
 * with. Which means the two are the same build by construction: update the desktop and the phone
 * has the new interface on its next load, with no app store in between.
 *
 * Same origin as the API, and that is not incidental. The renderer's CSP is `connect-src 'self'`;
 * served from here, "self" *is* the sync server, so its fetches and its WebSocket are allowed
 * without loosening anything. A copy bundled into the app would have to be granted permission to
 * talk to an arbitrary host, which is a much wider door.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

/** Where `electron-vite` puts the renderer, relative to the main process bundle. */
const ROOT = resolve(import.meta.dirname, "..", "renderer");

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json; charset=utf-8",
};

/**
 * The file for a request path, or null if it is not one of ours.
 *
 * `normalize` then a prefix check, because the path arrives from the network: `/app/../../../etc/
 * passwd` is a request someone will make, and it is the whole reason this does not simply join.
 */
export function resolveAsset(pathname: string): string | null {
	const relative = pathname.replace(/^\/app\/?/, "") || "index.html";
	const full = resolve(ROOT, normalize(relative));
	if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
	return full;
}

/**
 * Send an asset, or answer false so the caller can 404 it.
 *
 * A directory or a missing file both fall back to `index.html` — the renderer routes on the hash,
 * so a deep link is a page this server has never heard of and the app sorts out on its own.
 */
export async function serveApp(pathname: string, res: ServerResponse): Promise<boolean> {
	const candidate = resolveAsset(pathname);
	if (!candidate) return false;

	let file = candidate;
	try {
		const info = await stat(file);
		if (info.isDirectory()) file = join(file, "index.html");
	} catch {
		// Unknown path: hand back the shell rather than a 404, so refreshing a route works.
		file = join(ROOT, "index.html");
	}

	try {
		await stat(file);
	} catch {
		return false;
	}

	res.writeHead(200, {
		"content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
		/*
		 * Hashed assets are immutable; the shell is not.
		 *
		 * Vite fingerprints every asset it emits, so those can be cached hard — which matters on a
		 * phone, where the alternative is re-downloading a four-megabyte bundle over mobile data
		 * every time the app is opened. `index.html` names those hashes, so it must never be held.
		 */
		"cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
	});
	createReadStream(file).pipe(res);
	return true;
}
