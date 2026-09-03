/**
 * e2e teardown must return even when the thing being stopped does not.
 *
 * A suite that had already passed hung GitHub Actions for six hours because `after()` waited
 * on `server.close()` and on stdio pipes to a detached Electron that SIGTERM never reaped.
 * `--test-timeout` does not apply to hooks, so the only defence is that these two helpers
 * themselves bound the wait. This file is that contract, without booting the app.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { closeListeningServer, stopProcessGroup } from "../e2e/app.ts";

test("stopProcessGroup kills a detached child instead of waiting forever", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	assert.ok(child.pid);
	const pid = child.pid;
	const started = Date.now();
	await stopProcessGroup(child, 400);
	assert.ok(Date.now() - started < 3_000, `stopProcessGroup took ${Date.now() - started}ms`);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("closeListeningServer returns even if a client is still connected", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.write("hold");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	assert.ok(addr && typeof addr === "object");
	const socket = connect(addr.port, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
	await new Promise<void>((resolve) => socket.once("data", () => resolve()));
	const started = Date.now();
	await closeListeningServer(server, 400);
	assert.ok(Date.now() - started < 2_000, `closeListeningServer took ${Date.now() - started}ms`);
	socket.destroy();
});
