/**
 * Whether a failure says anything useful.
 *
 * This is the code you cannot check by causing the failure — nobody is going to expire a token to
 * see what the message reads like — so it is checked here instead. Two rules are load-bearing:
 * a 403 means two opposite things depending on the body, and a message names the host it is about
 * once there is more than one account.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, describeStatus, ForgeError, networkMessage } from "../electron/forge/errors.ts";

test("401 names the token to go and replace, in that host's own words", () => {
	assert.match(describeStatus(401, "", "gitlab"), /GitLab 令牌/);
	assert.match(describeStatus(401, "", "gitee"), /Gitee 私人令牌/);
	assert.match(describeStatus(401, "", "github"), /设置/, "and says where to fix it");
});

test("403 is two opposite problems wearing one number", () => {
	// Waiting fixes one of them and will never fix the other, so telling them apart is the whole job.
	assert.match(describeStatus(403, "API rate limit exceeded for user", "github"), /限流/);
	assert.match(describeStatus(403, "Resource not accessible by personal access token", "github"), /没有权限/);
	assert.match(describeStatus(403, "", "github"), /scope/, "with nothing to go on, point at the likely cause");
});

test("404 mentions the scope, because a token without one 404s rather than 403s", () => {
	assert.match(describeStatus(404, "", "gitlab"), /scope/);
});

test("what the host said is appended, trimmed, and never the whole message", () => {
	const message = describeStatus(422, "Review cannot be requested from pull request author", "github");
	assert.match(message, /拒绝/);
	assert.match(message, /Review cannot be requested/);

	const long = describeStatus(422, "x".repeat(500), "github");
	assert.ok(long.length < 220, "a paragraph from an API is not a message");
});

test("HTML and empty bodies add nothing rather than adding noise", () => {
	assert.equal(describeStatus(500, "", "gitea"), "对方服务出错了（500）");
});

test("a connection that went nowhere says which host it was", () => {
	// With several accounts, "连不上" alone leaves somebody guessing which one — and the answer is
	// usually the self-hosted instance behind a VPN that is not connected.
	assert.match(networkMessage(new Error("getaddrinfo ENOTFOUND git.corp.example"), "https://git.corp.example"), /git\.corp\.example/);
	assert.match(networkMessage(new Error("getaddrinfo ENOTFOUND x"), "https://git.corp.example"), /解析不到/);
	assert.match(networkMessage(new Error("connect ECONNREFUSED 127.0.0.1:3000"), "http://git.internal:3000"), /拒绝连接/);
	assert.match(networkMessage(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }), "https://gitlab.com"), /超时/);
	assert.match(networkMessage(new Error("unable to verify the first certificate"), "https://git.internal"), /证书/);
	assert.match(networkMessage(new Error("something else entirely"), "https://gitee.com"), /连不上 gitee\.com/);
});

test("an already-described failure passes through untouched", () => {
	assert.equal(describe(new ForgeError("被限流了，过一会儿会自动恢复", 429)), "被限流了，过一会儿会自动恢复");
});

test("an unexpected failure is trimmed rather than dressed up", () => {
	// Inventing a friendly message for an unknown error is how the real one stops reaching anybody.
	assert.equal(describe(new Error("boom\nsecond line")), "boom");
	assert.equal(describe("plain string"), "plain string");
	assert.equal(describe(new Error("")), "出错了");
});
