/**
 * The platform's API, stated once for the three things that speak it.
 *
 * The worker implements these, the site calls them, and the app calls a subset. Writing them as
 * types rather than as documentation means a route that changes its answer breaks the site's build
 * instead of the site — which is the only kind of API documentation that stays true.
 *
 * Versioned in the path (`/v1/...`) rather than by a header. An app that shipped a year ago keeps
 * calling v1 forever, and v1 has to keep answering; putting that in the URL makes the promise
 * visible to whoever is about to change a handler.
 */

import type { BundleKind, EntryStatus, RegistryEntry } from "./entry.ts";

/** Every list endpoint answers this shape, so one component can render any of them. */
export interface Page<T> {
	items: T[];
	/** How many match the query in total, not how many are in `items`. */
	total: number;
	/** Zero-based. */
	page: number;
	pageSize: number;
}

export interface EntryQuery {
	/** Free text, matched against name, id and description. */
	q?: string;
	kind?: BundleKind;
	category?: string;
	author?: string;
	sort?: EntrySort;
	page?: number;
	pageSize?: number;
}

/**
 * `downloads` is the default rather than `updated`.
 *
 * A catalogue sorted by recency shows whatever was touched last, which on a quiet day is a typo
 * fix. Neither is a judgement we make ourselves — see the deliberate absence of a "featured" sort.
 */
export type EntrySort = "downloads" | "updated" | "created" | "name";

export function isEntrySort(value: unknown): value is EntrySort {
	return value === "downloads" || value === "updated" || value === "created" || value === "name";
}

/** A catalogue row: an index entry plus what only the platform knows about it. */
export interface EntrySummary extends RegistryEntry {
	status: EntryStatus;
	/** GitHub login of whoever claimed it here — not necessarily the code's author. */
	publisher?: string;
	publisherAvatar?: string;
	createdAt: string;
	/** Installs in the trailing week, which is what "popular" should mean. */
	recentDownloads?: number;
}

/** Everything the detail page shows, which is the summary plus history and prose. */
export interface EntryDetail extends EntrySummary {
	versions: VersionInfo[];
	/** The README the build found in the bundle, as raw markdown. Rendered by the client. */
	readme?: string;
	/** Present only for the entry's own publisher or an admin. */
	reviewNote?: string;
}

export interface VersionInfo {
	version: string;
	createdAt: string;
	tarball: string;
	sha256: string;
	size: number;
	commit?: string;
	skillCount?: number;
	serverCount?: number;
	/**
	 * Withdrawn, but still downloadable.
	 *
	 * A version people already installed cannot be made to have never existed, and breaking their
	 * lockfile-equivalent to express disapproval helps nobody. Yanking hides it from resolution and
	 * says why; it does not delete the bytes.
	 */
	yanked?: boolean;
	yankedReason?: string;
}

/** What an author submits. The platform works out everything else by reading the repository. */
export interface SubmitRequest {
	repository: string;
	/** Sub-path within the repository, when one repo ships several bundles. */
	path?: string;
	/** Optional overrides; anything omitted is read from the bundle itself. */
	id?: string;
	name?: string;
	description?: string;
	category?: string;
	kind?: BundleKind;
}

/** The outcome of a submission or a re-fetch, which is a build and therefore can fail loudly. */
export interface BuildResult {
	ok: boolean;
	entryId?: string;
	version?: string;
	/** Why it failed, in the language the author submitted from. Never a stack trace. */
	error?: string;
	/** Non-fatal things worth telling the author — an empty description, no README, no license. */
	warnings?: string[];
	skillCount?: number;
	serverCount?: number;
}

export interface Viewer {
	id: number;
	login: string;
	name?: string;
	avatarUrl?: string;
	isAdmin: boolean;
}

export interface ReviewRequest {
	action: "approve" | "reject" | "delist" | "restore";
	note?: string;
}

/** Counts for the admin dashboard, and for the site's own front page. */
export interface RegistryStats {
	entries: number;
	byKind: Record<BundleKind, number>;
	skills: number;
	servers: number;
	downloads: number;
	pending: number;
	publishers: number;
}

/**
 * Every error the API returns, in one shape.
 *
 * `code` is for the caller to branch on and never changes; `message` is for a person to read and is
 * allowed to. A client that switches on the prose is a client that breaks when we fix a typo.
 */
export interface ApiError {
	code: ApiErrorCode;
	message: string;
}

export type ApiErrorCode =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "conflict"
	| "invalid"
	| "rate_limited"
	| "upstream_failed"
	| "internal";

/** HTTP status for each, kept beside the codes so the two cannot disagree. */
export const ERROR_STATUS: Record<ApiErrorCode, number> = {
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	invalid: 422,
	rate_limited: 429,
	upstream_failed: 502,
	internal: 500,
};

/** How many rows a list endpoint returns when nobody said, and the most it will ever return. */
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;
