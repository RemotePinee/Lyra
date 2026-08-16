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

import { lyraHome } from "../session/store.ts";

const run = promisify(execFile);

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
	const list = Array.isArray(raw) ? raw : ((raw as { plugins?: unknown })?.plugins ?? []);
	if (!Array.isArray(list)) throw new Error("市场索引格式不对：应为数组或 { plugins: [] }");

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

/**
 * Install an entry by cloning it into the user's plugin directory.
 *
 * `git` rather than a tarball fetch: every one of these lives in a repository already, a shallow
 * clone is one command, and it leaves the user something they can `git pull` later without any
 * update mechanism of ours.
 *
 * `path` is what makes a collection possible. Without it every bundle needs a repository of its
 * own, which is a lot of ceremony for a manifest and one markdown file — and the field was in the
 * format from the start, declared and then quietly ignored, so an index that used it installed a
 * directory with no plugin in it. The clone lands somewhere temporary and the named subdirectory
 * is what gets kept; the rest, including the `.git` that would otherwise make a subdirectory look
 * like a checkout of the whole collection, is thrown away.
 */
export async function installEntry(entry: RegistryEntry): Promise<string> {
	const root = join(lyraHome(), "plugins");
	await mkdir(root, { recursive: true });

	const target = join(root, entry.id);
	if ((await readdir(root).catch((): string[] => [])).includes(entry.id)) {
		throw new Error(`已经装过 ${entry.id} 了`);
	}

	if (!entry.path) {
		try {
			await run("git", ["clone", "--depth", "1", entry.repository, target], { timeout: 60_000 });
		} catch (cause) {
			// A half-written directory would be picked up by the loader as a broken plugin.
			await rm(target, { recursive: true, force: true });
			throw new Error(`克隆失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		}
		return target;
	}

	const inner = subPath(entry.path);
	if (!inner) throw new Error(`插件路径不合法：${entry.path}`);

	// Beside the target rather than in the OS temp dir: same filesystem, so the move is a rename
	// rather than a copy, and a crash leaves the debris somewhere we already clean up.
	const staging = join(root, `.${entry.id}.staging`);
	await rm(staging, { recursive: true, force: true });
	try {
		await run("git", ["clone", "--depth", "1", entry.repository, staging], { timeout: 60_000 });
		const source = join(staging, inner);
		if (!(await stat(source).catch(() => null))?.isDirectory()) {
			throw new Error(`仓库里没有 ${entry.path} 这个目录`);
		}
		await rename(source, target);
	} catch (cause) {
		await rm(target, { recursive: true, force: true });
		throw new Error(`安装失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return target;
}

/** A repo-relative directory, or null for anything absolute or climbing out of the checkout. */
function subPath(raw: string): string | null {
	const trimmed = raw.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return null;
	const parts = trimmed.split("/");
	if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
	return parts.join("/");
}

/** Drop an installed bundle from the user's plugin directory. */
export async function uninstallEntry(id: string): Promise<void> {
	if (!id || id.includes("/") || id.includes("..")) throw new Error("非法的插件 id");
	await rm(join(lyraHome(), "plugins", id), { recursive: true, force: true });
}

function normalise(item: unknown): RegistryEntry | null {
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
