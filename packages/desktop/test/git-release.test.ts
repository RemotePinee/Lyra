import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bumpSemver, getRepoInfo } from "../electron/git-release.ts";

describe("git release bumpSemver", () => {
	it("bumps patch versions correctly", () => {
		assert.equal(bumpSemver("0.7.3", "patch"), "0.7.4");
		assert.equal(bumpSemver("v0.7.3", "patch"), "0.7.4");
		assert.equal(bumpSemver("1.0.0", "patch"), "1.0.1");
	});

	it("bumps minor versions correctly", () => {
		assert.equal(bumpSemver("0.7.3", "minor"), "0.8.0");
		assert.equal(bumpSemver("v0.7.3", "minor"), "0.8.0");
		assert.equal(bumpSemver("1.2.9", "minor"), "1.3.0");
	});

	it("bumps major versions correctly", () => {
		assert.equal(bumpSemver("0.7.3", "major"), "1.0.0");
		assert.equal(bumpSemver("v0.7.3", "major"), "1.0.0");
		assert.equal(bumpSemver("1.2.9", "major"), "2.0.0");
	});

	it("resolves repo owner and name correctly for current repo", async () => {
		const repoInfo = await getRepoInfo(process.cwd());
		assert.ok(repoInfo);
		assert.equal(repoInfo.owner, "kittors");
		assert.equal(repoInfo.name, "Lyra");
	});
});
