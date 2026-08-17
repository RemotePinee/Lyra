/**
 * Plugin registries: a URL that lists installable bundles.
 *
 * Deliberately the plainest thing that works — one JSON document, fetched over HTTPS, listing
 * entries with a name, a description and a git URL. There is no protocol to implement and no
 * server to run: a registry can be a file in a GitHub repo, which is what the existing skill
 * collections already are.
 *
 * Nothing is executed at browse time. An entry is a description of where a bundle lives; it
 * becomes code on disk only when the user installs it, and even then a plugin is data — skills
 * are markdown, MCP servers are declarations the user still has to enable.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { McpServerConfig } from "../mcp/client.ts";
import { lyraHome } from "../session/store.ts";
import { inspectBundle } from "./loader.ts";

const run = promisify(execFile);

/**
 * Which of the two things an entry is.
 *
 * A registry may declare it, and the catalogue shows what it declared — but the word is only ever
 * a claim until the bundle is on disk, so `installEntry` reads the clone and files it by what it
 * found. An index that says "plugin" about a directory holding one `.mcp.json` is wrong, and
 * seven of the nine entries in the collection this was built against said exactly that.
 */
/**
 * The three things a registry can offer, distinguished by where they land and what starts them.
 *
 * A plugin is a directory of skills the app loads. An MCP bundle is a server declaration that also
 * has to be written into settings and launched. A skill collection is a directory of `SKILL.md`
 * folders and nothing else — no manifest, no process, so it goes straight into the skills directory
 * where loose skills already live rather than being wrapped in a bundle that would say nothing.
 */
export type BundleKind = "plugin" | "mcp" | "skill";

/** How long a registry has to answer before we give up on it. */
const FETCH_TIMEOUT_MS = 10_000;
/** A registry index has no business being larger than this; anything more is a mistake or an attack. */
const MAX_INDEX_BYTES = 2_000_000;

export interface RegistryEntry {
	/** Directory name it installs as; also its identity within a registry. */
	id: string;
	name: string;
	description?: string;
	/** Git URL the bundle is cloned from. */
	repository: string;
	/** Sub-path within the repository, for registries that ship many bundles in one repo. */
	path?: string;
	author?: string;
	homepage?: string;
	/** Absolute URL; the browser renders it directly, so it must be http(s) or a data URL. */
	logo?: string;
	brandColor?: string;
	category?: string;
	/**
	 * What the index says this is; corrected against the clone at install time.
	 *
	 * Inferred where it is absent, because no existing index declares it: an entry naming an npm
	 * `package` is how an MCP server is distributed, and nothing else in the format implies one.
	 */
	kind: BundleKind;
	/** The npm package an MCP server is published as, when the bundle wraps one. */
	package?: string;
	version?: string;
}

export interface Registry {
	url: string;
	name: string;
	entries: RegistryEntry[];
}

/**
 * Read a registry index.
 *
 * Accepts either `{ name, plugins: [...] }` or a bare array, because the collections in the
 * wild are split roughly evenly between the two and requiring one would rule out half of them
 * for no benefit.
 */
export async function fetchRegistry(url: string, signal?: AbortSignal): Promise<Registry> {
	if (!/^https:\/\//i.test(url)) throw new Error("插件市场地址必须是 https");

	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(url, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		headers: { accept: "application/json" },
	});
	if (!response.ok) throw new Error(`市场返回 ${response.status}`);

	const size = Number(response.headers.get("content-length") ?? 0);
	if (size > MAX_INDEX_BYTES) throw new Error("市场索引过大");

	const raw: unknown = await response.json();
	/*
	 * `plugins` or `collections`, whichever the index used.
	 *
	 * A skill index lists collections and a plugin index lists plugins, and the two are different
	 * enough to deserve different words in the file — but identical from here: a list of things with
	 * an id, a name and somewhere to clone from. Accepting both keeps one fetcher rather than two
	 * that would drift.
	 */
	const container = raw as { plugins?: unknown; collections?: unknown };
	const list = Array.isArray(raw) ? raw : (container?.plugins ?? container?.collections ?? []);
	if (!Array.isArray(list)) throw new Error("市场索引格式不对：应为数组或 { plugins: [] } / { collections: [] }");

	return {
		url,
		name: (!Array.isArray(raw) && typeof (raw as { name?: unknown }).name === "string"
			? (raw as { name: string }).name
			: hostOf(url)) as string,
		entries: list.flatMap((item) => {
			const entry = normalise(item);
			return entry ? [entry] : [];
		}),
	};
}

/** Where each kind of bundle lives once installed. */
export function bundleRoot(kind: BundleKind): string {
	if (kind === "mcp") return join(lyraHome(), "mcp");
	// Skills go where loose skills already are, so nothing has to know they came from a registry.
	if (kind === "skill") return join(lyraHome(), "skills");
	return join(lyraHome(), "plugins");
}

export interface Installed {
	dir: string;
	/** Decided by reading the clone, not by what the index claimed. */
	kind: BundleKind;
	/** For an MCP bundle: what it declares, stamped with where it came from. */
	servers: McpServerConfig[];
	name: string;
}

/**
 * Install an entry by cloning it, then filing it by what it turned out to be.
 *
 * `git` rather than a tarball fetch: every one of these lives in a repository already, a shallow
 * clone is one command, and it leaves the user something they can `git pull` later without any
 * update mechanism of ours.
 *
 * Everything lands in staging first — including the case with no `path`, which used to clone
 * straight to its destination. It cannot go straight there any more, because where it belongs is
 * a question about its contents: a directory holding nothing but a `.mcp.json` is an MCP server,
 * and putting it among the plugins is how the catalogue ended up advertising seven MCP servers as
 * plugins. `kind` on the entry is only what the index *claims*; this is what it is.
 *
 * `path` is what makes a collection possible. Without it every bundle needs a repository of its
 * own, which is a lot of ceremony for a manifest and one markdown file. The named subdirectory is
 * what gets kept; the rest, including the `.git` that would otherwise make a subdirectory look
 * like a checkout of the whole collection, is thrown away.
 */
export async function installEntry(entry: RegistryEntry, registryName?: string): Promise<Installed> {
	const inner = entry.path ? subPath(entry.path) : "";
	if (inner === null) throw new Error(`插件路径不合法：${entry.path}`);

	for (const kind of ["plugin", "mcp"] as const) {
		const root = bundleRoot(kind);
		if ((await readdir(root).catch((): string[] => [])).includes(entry.id)) {
			throw new Error(`已经装过 ${entry.id} 了`);
		}
	}

	// Beside the eventual target rather than in the OS temp dir: same filesystem, so the move is a
	// rename rather than a copy, and a crash leaves the debris somewhere we already clean up.
	const staging = join(lyraHome(), "plugins", `.${entry.id}.staging`);
	await mkdir(join(lyraHome(), "plugins"), { recursive: true });
	await rm(staging, { recursive: true, force: true });

	try {
		await run("git", ["clone", "--depth", "1", entry.repository, staging], { timeout: 60_000 });

		const source = inner ? join(staging, inner) : staging;
		if (inner && !(await stat(source).catch(() => null))?.isDirectory()) {
			throw new Error(`仓库里没有 ${entry.path} 这个目录`);
		}

		const found = await inspectBundle(source);
		if (found.kind === "none") {
			throw new Error(found.error ?? "这个仓库里没有可安装的技能或 MCP 服务");
		}

		const root = bundleRoot(found.kind);
		await mkdir(root, { recursive: true });
		const target = join(root, entry.id);
		await rm(target, { recursive: true, force: true });
		await rename(source, target);

		return {
			dir: target,
			kind: found.kind,
			name: found.manifest.interface?.displayName ?? found.manifest.name ?? entry.name,
			servers:
				found.kind === "mcp"
					? found.servers.map((server) => ({
							...server,
							origin: { bundle: entry.id, registry: registryName, version: found.manifest.version },
						}))
					: [],
		};
	} catch (cause) {
		throw new Error(`安装失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** A repo-relative directory, or null for anything absolute or climbing out of the checkout. */
function subPath(raw: string): string | null {
	const trimmed = raw.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return null;
	const parts = trimmed.split("/");
	if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
	return parts.join("/");
}

/**
 * Drop an installed bundle, whichever of the two directories it lives in.
 *
 * Both are cleared rather than asking the caller which kind it was: an id is unique across the
 * pair (installing checks both), and a bundle that predates the split may still be filed under
 * the other one. Removing what its servers left in settings is the caller's half — see
 * `McpOrigin`.
 */
export async function uninstallEntry(id: string): Promise<void> {
	if (!id || id.includes("/") || id.includes("..")) throw new Error("非法的插件 id");
	await rm(join(bundleRoot("plugin"), id), { recursive: true, force: true });
	await rm(join(bundleRoot("mcp"), id), { recursive: true, force: true });
}

/**
 * One entry of an index, or null if it is not one.
 *
 * Exported for the tests: what an index is allowed to say is a contract with people who do not have
 * this codebase, and a contract that is only exercised over the network is a contract nobody checks
 * until it is already broken in production.
 */
export function normalise(item: unknown): RegistryEntry | null {
	if (!item || typeof item !== "object") return null;
	const raw = item as Record<string, unknown>;

	const repository = pick(raw, "repository", "repo", "url", "git");
	const name = pick(raw, "name", "title", "displayName");
	if (!repository || !name) return null;
	// Only ever cloned from, never opened in a browser, but a non-git scheme has no business here.
	if (!/^(https:\/\/|git@)/i.test(repository)) return null;

	const id = pick(raw, "id", "slug") ?? slugOf(name);
	if (!/^[a-z0-9._-]+$/i.test(id)) return null;

	const logo = pick(raw, "logo", "icon", "iconUrl");
	const declared = pick(raw, "kind", "type");
	const packageName = pick(raw, "package", "npm");
	return {
		id,
		name,
		repository,
		description: pick(raw, "description", "summary", "shortDescription"),
		path: pick(raw, "path", "subpath"),
		author: pick(raw, "author", "developerName", "owner"),
		homepage: pick(raw, "homepage", "websiteURL", "website"),
		// A logo is rendered as an <img src>; anything but http(s) could be a `javascript:` URL.
		logo: logo && /^https?:\/\//i.test(logo) ? logo : undefined,
		brandColor: pick(raw, "brandColor", "color"),
		category: pick(raw, "category"),
		/*
		 * Declared if the index bothered to; otherwise inferred from the npm package.
		 *
		 * Publishing an MCP server means publishing an npm package and naming it in a `.mcp.json`
		 * — a plugin, which is markdown in a directory, has no package to name. The guess is only
		 * for the browsing view; the clone settles it.
		 */
		/*
		 * Taken from the index when it says, inferred only when it does not.
		 *
		 * The inference is a fallback for indexes written before `kind` existed: naming an npm
		 * `package` is how an MCP server is distributed, and nothing else in the format implies one.
		 * A skill collection is never inferred — it has no distinguishing field, so an index that
		 * wants one has to say so.
		 */
		kind:
			declared === "mcp" || declared === "plugin" || declared === "skill"
				? declared
				: packageName
					? "mcp"
					: "plugin",
		package: packageName,
		version: pick(raw, "version"),
	};
}

function pick(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function slugOf(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
