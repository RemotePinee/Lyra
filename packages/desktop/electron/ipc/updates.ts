/**
 * Finding out whether there is a newer release, fetching it, and handing it to the installer.
 *
 * The download happens here rather than in a browser. Sending someone to a web page to find the
 * right file among four is not an update mechanism, it is an apology for not having one — and the
 * page cannot know whether they are on Apple silicon or Intel, while this can.
 *
 * What is deliberately *not* here is replacing the app in place. This build is unsigned, and an
 * updater that swaps the binary itself would be granting an unsigned download the trust the user
 * gave the copy they installed. The last step is the installer the platform already has: the disk
 * image is opened, and the user drags it across as they did the first time.
 */

import { app, ipcMain, shell } from "electron";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installedAppBundle, scheduleSwap } from "./install-update.ts";

const execFileAsync = promisify(execFile);

/**
 * Unpack with `ditto`, not a library.
 *
 * A `.app` is a directory of symlinks, code signatures and extended attributes, and most zip
 * implementations quietly drop some of that — producing a bundle that unpacks without complaint
 * and then refuses to launch. `ditto` is what macOS itself uses, and `-x -k` is its zip mode.
 */
const unzip = (archive: string, into: string) => execFileAsync("ditto", ["-x", "-k", archive, into]);

import { isNewer } from "../../src/update/version.ts";

/** Where releases are published. */
const REPO = "kittors/Lyra";
/** GitHub answers in a second or so; anything longer means it is not going to. */
const TIMEOUT_MS = 8000;
/** Checked at most this often, however many times the window asks. */
const CACHE_MS = 30 * 60 * 1000;

export interface UpdateInfo {
	current: string;
	latest: string;
	available: boolean;
	/** The release body, as written. Markdown, shown as text. */
	notes: string;
	url: string;
	publishedAt: number | null;
	/** The installer for this machine, when the release has one. */
	asset: { name: string; url: string; size: number } | null;
}

interface Asset {
	name?: string;
	browser_download_url?: string;
	size?: number;
}

/**
 * The one file this machine can install.
 *
 * macOS gets the disk image for its own architecture — an Intel build runs on Apple silicon through
 * Rosetta but is the wrong answer when a native one is sitting beside it. Windows takes the setup
 * executable, Linux the AppImage. A release without a matching asset simply has none, and the window
 * falls back to showing what changed without offering to fetch it.
 */
function pickAsset(assets: Asset[]): UpdateInfo["asset"] {
	const arm = process.arch === "arm64";
	const named = assets.filter((a): a is Required<Asset> =>
		Boolean(a.name && a.browser_download_url && typeof a.size === "number"),
	);
	const find = (test: (name: string) => boolean) => named.find((a) => test(a.name.toLowerCase()));

	/*
	 * macOS takes the zip, not the disk image.
	 *
	 * A .dmg can only be *opened* — the user mounts it and drags the app across, which is a manual
	 * install wearing the clothes of an automatic one. The zip contains `Lyra.app` directly, so it
	 * can be unpacked and swapped in place, and the update becomes what it should be: download,
	 * relaunch, done. The dmg stays in the release for people installing by hand the first time.
	 */
	const match =
		process.platform === "darwin"
			? (find((n) => n.endsWith(".zip") && (arm ? n.includes("arm64") : !n.includes("arm64"))) ??
				find((n) => n.endsWith(".zip")))
			: process.platform === "win32"
				? (find((n) => n.endsWith(".exe")) ?? find((n) => n.endsWith(".msi")))
				: (find((n) => n.endsWith(".appimage")) ?? find((n) => n.endsWith(".deb")));

	return match ? { name: match.name, url: match.browser_download_url, size: match.size } : null;
}

let cached: { at: number; info: UpdateInfo } | null = null;

/** An unpacked update waiting for the user to say when. Cleared once it has been used. */
let pending: { staged: string; target: string } | null = null;

async function fetchLatest(current: string): Promise<UpdateInfo> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": `Lyra/${current}` },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`GitHub said ${response.status}`);
		const release = (await response.json()) as {
			tag_name?: string;
			name?: string;
			body?: string;
			html_url?: string;
			published_at?: string;
			draft?: boolean;
			prerelease?: boolean;
			assets?: Asset[];
		};

		const latest = (release.tag_name ?? release.name ?? "").replace(/^v/i, "");
		// A draft is not published and a pre-release is not for people who did not ask for one.
		const offerable = Boolean(latest) && !release.draft && !release.prerelease;
		return {
			current,
			latest: latest || current,
			available: offerable && isNewer(latest, current),
			notes: (release.body ?? "").trim(),
			url: release.html_url ?? `https://github.com/${REPO}/releases/latest`,
			publishedAt: release.published_at ? Date.parse(release.published_at) : null,
			asset: pickAsset(release.assets ?? []),
		};
	} finally {
		clearTimeout(timer);
	}
}

const nothing = (current: string): UpdateInfo => ({
	current,
	latest: current,
	available: false,
	notes: "",
	url: `https://github.com/${REPO}/releases`,
	publishedAt: null,
	asset: null,
});

export function registerUpdateIpc(): void {
	ipcMain.handle("updates:check", async (_event, force?: boolean): Promise<UpdateInfo> => {
		const current = app.getVersion();

		if (!force && cached && Date.now() - cached.at < CACHE_MS && cached.info.current === current) {
			return cached.info;
		}
		try {
			const info = await fetchLatest(current);
			cached = { at: Date.now(), info };
			return info;
		} catch {
			/*
			 * Offline, rate-limited, or the repository has no releases yet.
			 *
			 * All three mean the same thing to the window: nothing to offer. Reporting them would put
			 * an error in front of someone who never asked a question — the check is something the app
			 * does on its own, and its failure is the app's business, not theirs.
			 */
			return nothing(current);
		}
	});

	/**
	 * Fetch the installer, then let the platform open it.
	 *
	 * Progress is pushed rather than polled, because a download is the one operation where a
	 * percentage is the whole of the feedback. It is written to a temp directory keyed by version so
	 * a second attempt after a failure does not append to half a file.
	 */
	ipcMain.handle(
		"updates:download",
		async (event, version: string): Promise<{ ok: boolean; error?: string; relaunch?: boolean }> => {
		const info = cached?.info;
		const asset = info?.asset;
		if (!asset || info?.latest !== version) return { ok: false, error: "没有找到适用于这台机器的安装包" };

		const dir = join(tmpdir(), `lyra-update-${version}`);
		const file = join(dir, asset.name);
		const send = (payload: { received: number; total: number; done?: boolean }) => {
			if (!event.sender.isDestroyed()) event.sender.send("updates:progress", payload);
		};

		try {
			// Already fetched and complete — skip straight to opening it.
			const existing = await stat(file).catch(() => null);
			if (!existing || existing.size !== asset.size) {
				await rm(dir, { recursive: true, force: true });
				await mkdir(dir, { recursive: true });

				const response = await fetch(asset.url, { headers: { "User-Agent": `Lyra/${info.current}` } });
				if (!response.ok || !response.body) throw new Error(`下载失败：${response.status}`);
				const total = Number(response.headers.get("content-length")) || asset.size;

				let received = 0;
				const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
				body.on("data", (chunk: Buffer) => {
					received += chunk.length;
					send({ received, total });
				});
				await pipeline(body, createWriteStream(file));
			}

			send({ received: asset.size, total: asset.size, done: true });

			/*
			 * A zip on macOS is an update we can actually perform; everything else is an installer.
			 *
			 * Unpacking here rather than at relaunch means any failure — a truncated download, a
			 * bundle that is not what we expected — is reported while the window is still up and
			 * able to say so. By the time the user presses 立即重启 there is nothing left that can
			 * go wrong except the swap itself.
			 */
			if (process.platform === "darwin" && file.endsWith(".zip")) {
				const target = installedAppBundle(app.getPath("exe"));
				if (!target) return { ok: false, error: "这个副本不是从「应用程序」运行的，无法就地更新" };

				const staged = join(dir, "unpacked");
				await mkdir(staged, { recursive: true });
				await unzip(file, staged);
				const bundle = join(staged, `${app.getName()}.app`);
				if (!(await stat(bundle).catch(() => null))?.isDirectory()) {
					return { ok: false, error: "下载的更新包里没有找到应用" };
				}

				pending = { staged: bundle, target };
				return { ok: true, relaunch: true };
			}

			// Windows and Linux still hand the file to the OS: those are installers, and on Linux
			// a .deb needs a privilege this process does not have.
			await shell.openPath(file);
			return { ok: true };
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
			return { ok: false, error: error instanceof Error ? error.message : "下载失败" };
		}
	});

	/**
	 * Swap in the update and come back up on it.
	 *
	 * Separate from `download` so the person decides when: a relaunch in the middle of a turn would
	 * take the conversation with it. Nothing here can fail in a way worth reporting — the app is
	 * about to exit — so a scheduling failure simply leaves the update staged for next time.
	 */
	ipcMain.handle("updates:relaunch", async () => {
		if (!pending) return false;
		await scheduleSwap(pending);
		pending = null;
		// `exit`, not `quit`: quitting runs the window-close handlers, and one of them keeps the
		// app alive in the tray — which would leave the swap script waiting on a pid that never goes.
		app.exit(0);
		return true;
	});

	// Kept for the case where there is no installer for this platform: then the release page is the
	// only thing left to offer.
	ipcMain.handle("updates:open", async (_event, url: string) => {
		if (!url.startsWith("https://github.com/")) return false;
		await shell.openExternal(url);
		return true;
	});
}
