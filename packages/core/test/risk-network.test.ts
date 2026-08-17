/**
 * Where the agent may connect.
 *
 * Most of this file is about spellings. `192.168.1.1` has at least four textual forms and an
 * IPv6 disguise, and a check that compares strings catches one of them — so each variant gets its
 * own case, and each is a hole somebody could otherwise walk through.
 *
 * The other half is the rebinding case: a perfectly public hostname that resolves somewhere
 * internal. No amount of looking at the name answers it, which is why the caller resolves first
 * and the verdict is made about the address.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assessNetwork, isPrivateAddress } from "../src/tools/risk-network.ts";

const decide = (url: string, extra: Parameters<typeof assessNetwork>[0] extends infer T ? Partial<T> : never = {}) =>
	assessNetwork({ url, ...extra }).decision;

test("reading a public page is allowed without asking anyone", () => {
	assert.equal(decide("https://example.com/docs"), "allow");
	assert.equal(decide("http://example.com/a?b=c"), "allow");
	assert.equal(decide("https://api.github.com/repos/x/y", { method: "GET" }), "allow");
});

test("a request that changes something at the other end is asked about", () => {
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		assert.equal(decide("https://example.com/x", { method }), "ask", method);
	}
});

// ---------------------------------------------------------------------------
// Refused outright — the cases a prompt is worst at
// ---------------------------------------------------------------------------

test("cloud metadata is refused, not asked about", () => {
	// Shown this URL, almost nobody sees a credential theft. A question a person cannot answer
	// should be decided, not asked.
	const verdict = assessNetwork({ url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
	assert.equal(verdict.decision, "refuse");
	assert.match(verdict.decision === "refuse" ? verdict.reason : "", /元数据/);
});

test("every private range is refused", () => {
	for (const host of [
		"10.0.0.1",
		"10.255.255.255",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.1.1",
		"100.64.0.1",
		"0.0.0.0",
	]) {
		assert.equal(decide(`http://${host}/`), "refuse", host);
	}
});

test("a public range that looks adjacent is not refused", () => {
	// 172.15 and 172.32 are outside 172.16/12; 100.128 is outside carrier-grade NAT.
	for (const host of ["172.15.0.1", "172.32.0.1", "100.128.0.1", "11.0.0.1", "192.169.0.1"]) {
		assert.equal(decide(`http://${host}/`), "allow", host);
	}
});

test("IPv6 private and link-local are refused", () => {
	for (const host of ["[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::]"]) {
		assert.equal(decide(`http://${host}/`), "refuse", host);
	}
});

test("an IPv4 address wearing an IPv6 spelling is still that address", () => {
	assert.ok(isPrivateAddress("::ffff:192.168.1.1"));
	assert.ok(isPrivateAddress("::ffff:169.254.169.254"));
	assert.ok(!isPrivateAddress("::ffff:93.184.216.34"));
});

test("exotic integer spellings do not slip through", () => {
	// `0300.0250.1.1` and `3232235777` are 192.168.1.1 in octal and decimal. `isIP` rejects both
	// as addresses, so they are treated as hostnames — and a hostname is settled by what it
	// resolves to, which is what the next test covers.
	assert.ok(!isPrivateAddress("0300.0250.1.1"));
	assert.ok(!isPrivateAddress("3232235777"));
	// The point being: they must not be mistaken for *public addresses* either.
	assert.equal(decide("http://3232235777/", { addresses: ["192.168.1.1"] }), "refuse");
	assert.equal(decide("http://0300.0250.1.1/", { addresses: ["192.168.1.1"] }), "refuse");
});

test("a public name that resolves inward is refused", () => {
	// DNS rebinding. The name passes every check there is; the address does not.
	assert.equal(decide("https://evil.example.com/", { addresses: ["192.168.1.50"] }), "refuse");
	assert.equal(decide("https://evil.example.com/", { addresses: ["169.254.169.254"] }), "refuse");
});

test("one private answer among several is enough to refuse", () => {
	// The socket reaches whichever address the resolver hands it.
	assert.equal(decide("https://x.example.com/", { addresses: ["93.184.216.34", "10.0.0.1"] }), "refuse");
});

test("an allow-list cannot open a private address", () => {
	// Otherwise allowing a host by name would be a way to reach anything it resolves to.
	assert.equal(decide("https://internal.example.com/", { addresses: ["10.1.2.3"], allowHosts: ["internal.example.com"] }), "refuse");
});

test("an allow-listed public host skips the question even when it writes", () => {
	assert.equal(decide("https://api.example.com/x", { method: "POST", allowHosts: ["api.example.com"] }), "allow");
});

// ---------------------------------------------------------------------------
// Loopback: the one exception, and why it is narrow
// ---------------------------------------------------------------------------

test("the machine's own dev server is not the internet", () => {
	assert.equal(decide("http://localhost:3000/"), "allow");
	assert.equal(decide("http://127.0.0.1:5173/"), "allow");
	assert.equal(decide("http://app.localhost:3000/"), "allow");
	assert.equal(decide("http://[::1]:8080/"), "allow");
});

test("but changing something on it is still worth a question", () => {
	assert.equal(decide("http://localhost:3000/admin", { method: "DELETE" }), "ask");
});

test("a public name that merely points at loopback does not get the exception", () => {
	// `127.0.0.1.nip.io` resolves to loopback and is somebody else's DNS pointing inward. The
	// exception is for names this machine owns, not for every name that ends up there.
	assert.equal(decide("http://127.0.0.1.nip.io/", { addresses: ["127.0.0.1"] }), "refuse");
});

// ---------------------------------------------------------------------------
// Transport hygiene
// ---------------------------------------------------------------------------

test("only http and https", () => {
	for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]) {
		assert.equal(decide(url), "refuse", url);
	}
});

test("credentials in the URL are refused", () => {
	assert.equal(decide("https://user:pass@example.com/"), "refuse");
	assert.equal(decide("https://user@example.com/"), "refuse");
});

test("an unparseable address is refused rather than guessed at", () => {
	assert.equal(decide("not a url"), "refuse");
	assert.equal(decide(""), "refuse");
});

test("the host comparison is case-insensitive", () => {
	assert.equal(decide("https://API.Example.COM/x", { method: "POST", allowHosts: ["api.example.com"] }), "allow");
});
