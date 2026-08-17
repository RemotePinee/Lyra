/**
 * GitHub avatars, fetched here rather than by the page.
 *
 * The renderer's Content-Security-Policy allows `self`, `data:` and `blob:` — deliberately, since
 * it is the one thing standing between a rendered comment body and an arbitrary remote request.
 * Adding `avatars.githubusercontent.com` to it to show a 20px circle would widen that policy for
 * every element on every screen, permanently, for a decoration.
 *
 * So the main process fetches them and hands back a data URL. The page never makes the request,
 * the policy stays as narrow as it was, and two useful things fall out: the result is cached
 * across a session, and a failure is a value rather than a broken image element.
 */

/**
 * Cached by login, including the failures.
 *
 * A null is worth keeping: an account with no avatar, or a network that is not there, should be
 * asked about once. Without that, every re-render of a list of comments is another round trip
 * that is going to fail again.
 */
const cache = new Map<string, string | null>();

/** Bounded, because a long triage session sees a lot of bots. Roughly 30KB each at this size. */
const MAX = 200;

/**
 * A data URL for this account's avatar, or null.
 *
 * `?s=80` because these are drawn at 20pt and the full-size image is several hundred KB of
 * something nobody will ever look closely at. GitHub resizes server-side, so this is smaller on
 * the wire as well as in memory.
 */
export async function githubAvatar(login: string): Promise<string | null> {
	const name = login.trim();
	if (!name || name.includes("/")) return null;

	const hit = cache.get(name);
	if (hit !== undefined) return hit;

	const url = `https://github.com/${encodeURIComponent(name)}.png?s=80`;
	let result: string | null = null;

	try {
		// Bounded: a hung connection must not leave a comment row waiting forever on a picture.
		const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "follow" });
		const type = response.headers.get("content-type") ?? "";
		if (response.ok && type.startsWith("image/")) {
			const bytes = Buffer.from(await response.arrayBuffer());
			// A guard against something that answers 200 with a megabyte of anything.
			if (bytes.byteLength > 0 && bytes.byteLength < 512 * 1024) {
				result = `data:${type};base64,${bytes.toString("base64")}`;
			}
		}
	} catch {
		result = null;
	}

	if (cache.size >= MAX) cache.delete(cache.keys().next().value as string);
	cache.set(name, result);
	return result;
}

/**
 * Any remote image, as a data URL.
 *
 * Same reasoning as the avatars above and the same machinery, one step more general: a registry
 * entry's logo is a URL somebody else chose, and letting the page fetch it would mean widening
 * `img-src` to the whole web for every element on every screen. Instead the main process fetches
 * it and the policy stays as narrow as it was.
 *
 * Restricted to https, and to a size that is plausibly an icon. A registry is a list of URLs the
 * user chose to trust for *installing software*, so this is not the boundary that matters — but a
 * loose end here would still be a main-process fetch driven by a remote file.
 */
export async function remoteImage(url: string): Promise<string | null> {
	if (!url.startsWith("https://")) return null;

	const hit = images.get(url);
	if (hit !== undefined) return hit;

	let result: string | null = null;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "follow" });
		const type = response.headers.get("content-type") ?? "";
		if (response.ok && type.startsWith("image/")) {
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.byteLength > 0 && bytes.byteLength < 512 * 1024) {
				result = `data:${type};base64,${bytes.toString("base64")}`;
			}
		}
	} catch {
		result = null;
	}

	if (images.size >= MAX) images.delete(images.keys().next().value as string);
	images.set(url, result);
	return result;
}

/** Keyed by URL, failures included — see the note on `cache`. */
const images = new Map<string, string | null>();
