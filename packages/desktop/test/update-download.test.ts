/**
 * Downloading an update, paused and resumed against a real server.
 *
 * A real one, because every interesting thing here is a conversation with an HTTP server and none
 * of it can be reasoned about from a stub: whether the range came back as 206 or was ignored with a
 * 200, whether the bytes that arrive continue the bytes on disk or repeat them, what a socket cut
 * halfway leaves behind. `node:http` on a loopback port is a few lines and answers all of it.
 *
 * The failure this is really guarding against is the quiet one. Appending a 200 to a partial file
 * produces a file of plausible length made of the wrong bytes — the first half twice — which
 * unpacks into something that is not an app, and reports itself as a bad release rather than as a
 * bad resume. Nothing about that is visible without checking the actual contents, so these tests
 * check the actual contents.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";

import { describe, downloadDir, resumePlan, staleDownloads, sweepDownloads, UpdateDownload, type DownloadPhase } from "../electron/ipc/update-download.ts";

/** The payload every test downloads: big enough to arrive in several chunks, small enough to be quick. */
const BODY = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));

interface Harness {
	url: string;
	/** How many requests arrived, so "it resumed" can be told from "it started over". */
	requests: { range: string | undefined }[];
	close(): Promise<void>;
}

/**
 * A server that serves `BODY`, with the range behaviour dialled in per test.
 *
 * `hold` is what makes pausing testable: it sends the first slice, then waits, so there is a
 * download genuinely in flight rather than one that has already finished by the time the test's
 * next line runs.
 */
async function serve(options: { ranges?: boolean; hold?: boolean; cut?: boolean } = {}): Promise<Harness> {
	const requests: { range: string | undefined }[] = [];
	const sockets = new Set<import("node:net").Socket>();

	const server: Server = createServer((request, response) => {
		const range = request.headers.range;
		requests.push({ range: typeof range === "string" ? range : undefined });

		const from = options.ranges !== false && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
		const slice = BODY.subarray(from);

		if (from > 0 && options.ranges !== false) {
			response.writeHead(206, {
				"content-length": String(slice.length),
				"content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
			});
		} else {
			response.writeHead(200, { "content-length": String(slice.length) });
		}

		if (options.cut) {
			/*
			 * Half the bytes, then the socket goes — a dropped connection, not a refused one.
			 *
			 * The pause before destroying is what makes it that: destroying in the same tick as the
			 * write means the client's `fetch` rejects before a single byte has been handed to it, so
			 * nothing is written, nothing is kept, and the test would be about a connection that never
			 * delivered anything rather than one that died halfway.
			 */
			response.write(slice.subarray(0, Math.floor(slice.length / 2)), () => {
				setTimeout(() => response.destroy(), 60);
			});
			return;
		}

		if (options.hold) {
			/*
			 * A trickle rather than one write.
			 *
			 * The point is to be interruptible: writing it all at once means the response is complete
			 * before `pause()` is ever called, and the test would be measuring how fast the loopback
			 * is instead of whether pausing works.
			 */
			let sent = 0;
			const step = 20_000;
			const tick = setInterval(() => {
				if (sent >= slice.length) {
					clearInterval(tick);
					response.end();
					return;
				}
				response.write(slice.subarray(sent, sent + step));
				sent += step;
			}, 25);
			response.on("close", () => clearInterval(tick));
			return;
		}

		response.end(slice);
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/Lyra.zip`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

const dirs: string[] = [];
async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lyra-dl-"));
	dirs.push(dir);
	return dir;
}

after(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function downloadInto(dir: string, url: string): UpdateDownload {
	return new UpdateDownload({ url, file: join(dir, "Lyra.zip"), size: BODY.length, agent: "Lyra/test" });
}

/** Wait until the phase satisfies a predicate, so nothing here races the event loop. */
async function until(
	download: UpdateDownload,
	ok: (phase: DownloadPhase) => boolean,
	complaint: string,
): Promise<DownloadPhase> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (ok(download.state)) return download.state;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`${complaint} — 停在 ${JSON.stringify(download.state)}`);
}

test("a download that runs to the end leaves the whole file, byte for byte", async () => {
	const server = await serve();
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		const phase = await download.start();

		assert.equal(phase.at, "preparing");
		assert.deepEqual(await readFile(join(dir, "Lyra.zip")), BODY);
		// The partial is renamed, not left beside the finished file.
		assert.equal(await stat(`${join(dir, "Lyra.zip")}.part`).catch(() => null), null);
	} finally {
		await server.close();
	}
});

test("pausing keeps what came down, and resuming asks only for the rest", async () => {
	const server = await serve({ hold: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		void download.start();

		// Wait for real progress before pausing, or the pause lands before anything was received and
		// the resume would be an ordinary download wearing a resume's clothes.
		await until(download, (p) => p.at === "downloading" && p.received > 0, "下载没有开始");
		await download.pause();

		const paused = download.state;
		assert.equal(paused.at, "paused");
		assert.ok(paused.at === "paused" && paused.received > 0, "暂停时应当记得已经下了多少");
		const kept = paused.at === "paused" ? paused.received : 0;

		const resumed = await download.start();
		assert.equal(resumed.at, "preparing");
		assert.deepEqual(await readFile(join(dir, "Lyra.zip")), BODY, "续传拼出来的必须和原文件逐字节相同");

		assert.equal(server.requests.length, 2, "两次请求：一次原始，一次续传");
		assert.equal(server.requests[1].range, `bytes=${kept}-`, "第二次请求只要没下完的那段");
	} finally {
		await server.close();
	}
});

test("a server that ignores the range is not appended to, it is started over", async () => {
	/*
	 * The corruption this whole file exists for. The server answers 200 with the entire body while
	 * there are already bytes on disk; appending would produce a file of the right length whose
	 * first half is the head of the file twice.
	 */
	const server = await serve({ ranges: false, hold: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		void download.start();
		await until(download, (p) => p.at === "downloading" && p.received > 0, "下载没有开始");
		await download.pause();

		await download.start();

		assert.deepEqual(await readFile(join(dir, "Lyra.zip")), BODY, "忽略 Range 的服务器必须从头写，不能接在后面");
	} finally {
		await server.close();
	}
});

test("a connection that drops is a failure, and the partial survives for the retry", async () => {
	const cut = await serve({ cut: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, cut.url);
		const phase = await download.start();

		assert.equal(phase.at, "failed", "半个文件不是下载完成");
		/*
		 * And says so in words worth reading. What undici hands over is `terminated`, which on a
		 * 130MB download reads as "start over" — the one thing that is not true, since the bytes are
		 * right there and 继续 will resume from them.
		 */
		assert.ok(
			phase.at === "failed" && /继续会接着下/.test(phase.error),
			`应当说清楚已下的部分还在：${JSON.stringify(phase)}`,
		);
		// Not renamed into place: a short file must never look like a finished one.
		assert.equal(await stat(join(dir, "Lyra.zip")).catch(() => null), null);
		assert.ok(((await stat(`${join(dir, "Lyra.zip")}.part`).catch(() => null))?.size ?? 0) > 0, "已下的部分留着");
	} finally {
		await cut.close();
	}
});

test("a failed download resumes from what it kept rather than starting again", async () => {
	const cut = await serve({ cut: true });
	const dir = await workdir();
	const file = join(dir, "Lyra.zip");
	try {
		await downloadInto(dir, cut.url).start();
		const kept = (await stat(`${file}.part`)).size;
		assert.ok(kept > 0);
		await cut.close();

		// A second server, standing in for the network coming back.
		const good = await serve();
		try {
			const resumed = await downloadInto(dir, good.url).start();
			assert.equal(resumed.at, "preparing");
			assert.deepEqual(await readFile(file), BODY);
			assert.equal(good.requests[0].range, `bytes=${kept}-`, "接着上次断的地方要");
		} finally {
			await good.close();
		}
	} finally {
		await cut.close().catch(() => {});
	}
});

test("cancelling throws the partial away, so the next attempt is a clean one", async () => {
	const server = await serve({ hold: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		void download.start();
		await until(download, (p) => p.at === "downloading" && p.received > 0, "下载没有开始");

		await download.cancel();

		assert.equal(download.state.at, "idle");
		assert.equal(await stat(`${join(dir, "Lyra.zip")}.part`).catch(() => null), null, "取消把碎片也带走");
	} finally {
		await server.close();
	}
});

test("a file already downloaded in full is not fetched again", async () => {
	const server = await serve();
	const dir = await workdir();
	try {
		await writeFile(join(dir, "Lyra.zip"), BODY);

		const phase = await downloadInto(dir, server.url).start();

		assert.equal(phase.at, "preparing");
		assert.equal(server.requests.length, 0, "已经有了就不该再问服务器要一遍");
	} finally {
		await server.close();
	}
});

test("watchers hear the current phase the moment they subscribe", async () => {
	/*
	 * What lets a reopened window draw a paused download. A paused one emits nothing further by
	 * definition, so a subscriber that only heard future events would show it as idle for as long as
	 * it stayed paused — which is forever, since only the user resumes it.
	 */
	const server = await serve({ hold: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		void download.start();
		await until(download, (p) => p.at === "downloading" && p.received > 0, "下载没有开始");
		await download.pause();

		const heard: DownloadPhase[] = [];
		const stop = download.watch((phase) => heard.push(phase));

		assert.equal(heard.length, 1, "订阅时立刻收到一次");
		assert.equal(heard[0].at, "paused");
		stop();
	} finally {
		await server.close();
	}
});

test("two watchers both hear it, and unsubscribing stops only that one", async () => {
	const server = await serve({ hold: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		const first: DownloadPhase[] = [];
		const second: DownloadPhase[] = [];
		const stopFirst = download.watch((p) => first.push(p));
		download.watch((p) => second.push(p));

		void download.start();
		await until(download, (p) => p.at === "downloading" && p.received > 0, "下载没有开始");
		stopFirst();
		const frozen = first.length;
		await until(download, (p) => p.at === "downloading" && p.received > 40_000, "进度没有继续");
		await download.pause();

		assert.equal(first.length, frozen, "退订之后不再收到");
		assert.ok(second.length > frozen, "另一个还在收");
		assert.equal(second.at(-1)?.at, "paused");
	} finally {
		await server.close();
	}
});

test("starting an already-running download does not open a second one", async () => {
	/*
	 * Two writers appending to one file is the one corruption no length check would catch: the
	 * result is exactly the right size and interleaved. Reachable by double-clicking, which is not
	 * an exotic thing for someone to do to a button that does not visibly change on the first press.
	 */
	const server = await serve({ hold: true });
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		void download.start();
		await until(download, (p) => p.at === "downloading" && p.received > 0, "下载没有开始");

		await download.start();
		await until(download, (p) => p.at === "preparing", "下载没有走完");

		assert.equal(server.requests.length, 1, "第二次 start 不该再发一个请求");
		assert.deepEqual(await readFile(join(dir, "Lyra.zip")), BODY);
	} finally {
		await server.close();
	}
});

test("pausing something that is not downloading is not an error", async () => {
	const server = await serve();
	const dir = await workdir();
	try {
		const download = downloadInto(dir, server.url);
		// The button is drawn from a state that can be an event out of date; this must be harmless.
		await download.pause();
		assert.equal(download.state.at, "idle");
	} finally {
		await server.close();
	}
});

/*
 * `resumePlan` on its own: the decisions that are not worth standing up a server for, and the two
 * status codes that are hard to provoke from one.
 */

test("no bytes on disk means an ordinary download whatever the server answered", () => {
	assert.deepEqual(resumePlan(0, 200), { append: false, from: 0 });
	assert.deepEqual(resumePlan(0, 206), { append: false, from: 0 });
});

test("206 with bytes on disk continues them", () => {
	assert.deepEqual(resumePlan(1000, 206), { append: true, from: 1000 });
});

test("200 with bytes on disk starts over", () => {
	assert.deepEqual(resumePlan(1000, 200), { append: false, from: 0 });
});

test("416 means the partial does not belong to this file", () => {
	const plan = resumePlan(1000, 416);
	assert.ok("error" in plan && /对不上/.test(plan.error));
});

test("anything else is reported with its status", () => {
	const plan = resumePlan(1000, 503);
	assert.ok("error" in plan && /503/.test(plan.error));
});

test("each version downloads into its own directory", () => {
	assert.notEqual(downloadDir("/tmp", "0.3.1"), downloadDir("/tmp", "0.3.2"));
	assert.match(downloadDir("/tmp", "0.3.1"), /lyra-update-0\.3\.1$/);
});

/*
 * The wording of a failure, which is the part of it the user actually deals with.
 *
 * Worth its own tests because the mapping is where the useful sentence is decided, and because the
 * difference between "下载中断了" and "连不上" is the difference between pressing 继续 and going to
 * look at the wifi.
 */

test("a connection that died mid-body says the kept bytes are kept", () => {
	assert.match(describe(new Error("terminated"), 50_000), /继续会接着下/);
	assert.match(describe(new Error("read ECONNRESET"), 50_000), /继续会接着下/);
});

test("the same break with nothing down does not promise a resume there is nothing for", () => {
	const message = describe(new Error("terminated"), 0);
	assert.match(message, /可以重试/);
	assert.doesNotMatch(message, /接着下/);
});

test("a connection that never opened points at the network, not at the download", () => {
	assert.match(describe(new TypeError("fetch failed"), 0), /连不上/);
	assert.match(describe(new Error("getaddrinfo ENOTFOUND github.com"), 0), /连不上/);
});

test("our own messages are already specific and are passed through", () => {
	const mine = "下载不完整：拿到 100 字节，应为 200";
	assert.equal(describe(new Error(mine), 100), mine);
});

/*
 * Sweeping up after older versions.
 *
 * The bug this closes is invisible by construction: every update ever downloaded stayed in the
 * temp directory, as both the installer and the copy it unpacked to. Nobody looks in `/tmp`, so
 * nobody noticed until it was eight versions and several gigabytes.
 */

test("everything from an older version goes, and the current one stays", () => {
	const entries = ["lyra-update-0.2.9", "lyra-update-0.3.0", "lyra-update-0.3.1"];
	assert.deepEqual(staleDownloads(entries, "0.3.1"), ["lyra-update-0.2.9", "lyra-update-0.3.0"]);
});

test("nothing that is not ours is touched", () => {
	/*
	 * The directory being swept is the shared system temp directory, which is full of other
	 * programs' work — a prefix check is the whole of what makes this safe to point at `/tmp`.
	 */
	const entries = ["lyra-update-0.3.0", "com.apple.something", "TemporaryItems", "lyra-sessions", "update-0.3.0"];
	assert.deepEqual(staleDownloads(entries, "0.3.1"), ["lyra-update-0.3.0"]);
});

test("a version that merely starts the same way is not mistaken for the current one", () => {
	// `0.3.1` and `0.3.10` are different releases, and the prefix alone does not tell them apart.
	assert.deepEqual(staleDownloads(["lyra-update-0.3.10"], "0.3.1"), ["lyra-update-0.3.10"]);
	assert.deepEqual(staleDownloads(["lyra-update-0.3.1"], "0.3.1"), []);
});

test("sweeping really removes the directories, and leaves the current one alone", async () => {
	const root = await workdir();
	for (const version of ["0.2.9", "0.3.0", "0.3.1"]) {
		await mkdir(join(root, `lyra-update-${version}`), { recursive: true });
		await writeFile(join(root, `lyra-update-${version}`, "Lyra.zip"), "pretend installer");
	}
	await mkdir(join(root, "someone-elses-work"), { recursive: true });

	await sweepDownloads(root, "0.3.1");

	assert.deepEqual((await readdir(root)).sort(), ["lyra-update-0.3.1", "someone-elses-work"]);
});

test("sweeping a directory that does not exist is not an error", async () => {
	// Runs on every check, including the first one on a machine that has never downloaded anything.
	await sweepDownloads(join(await workdir(), "nope"), "0.3.1");
});
