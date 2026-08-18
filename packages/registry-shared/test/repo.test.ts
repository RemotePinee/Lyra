/**
 * Reading a repository URL, and refusing to build one out of something that is not a name.
 *
 * `normalisePath` is checked hardest because both sides run it: the platform to decide what to put
 * in an archive, the app to decide what to keep out of a clone. A disagreement there is a path
 * traversal on one of the two.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalisePath, ownerAvatar, parseRepo, tarballUrl } from "../src/repo.ts";

test("every form a repository is written in reaches the same pair", () => {
	for (const raw of [
		"https://github.com/kittors/Lyra",
		"https://github.com/kittors/Lyra.git",
		"https://github.com/kittors/Lyra/",
		"http://github.com/kittors/Lyra",
		"https://www.github.com/kittors/Lyra",
		"git@github.com:kittors/Lyra.git",
		"github.com/kittors/Lyra",
		"kittors/Lyra",
	]) {
		const ref = parseRepo(raw);
		assert.equal(ref?.owner, "kittors", raw);
		assert.equal(ref?.repo, "Lyra", raw);
		assert.equal(ref?.url, "https://github.com/kittors/Lyra.git", raw);
		assert.equal(ref?.homepage, "https://github.com/kittors/Lyra", raw);
	}
});

test("anything that is not a GitHub repository is refused here rather than in a queue", () => {
	// The fetch path is built on GitHub's tarball endpoint, so a GitLab URL that parsed would
	// produce an entry that can never be built. Better a sentence at submission than a failed job.
	assert.equal(parseRepo("https://gitlab.com/o/r"), null);
	assert.equal(parseRepo("https://example.com/o/r.git"), null);
	assert.equal(parseRepo(""), null);
	assert.equal(parseRepo("   "), null);
});

test("a segment that could climb out of a URL is not a segment", () => {
	assert.equal(parseRepo("https://github.com/../etc"), null);
	assert.equal(parseRepo("https://github.com/o/.."), null);
});

test("a tarball URL escapes its ref, because a branch name is user input", () => {
	const ref = parseRepo("kittors/Lyra")!;
	assert.equal(tarballUrl(ref, "main"), "https://codeload.github.com/kittors/Lyra/tar.gz/main");
	// Slashes are legal in branch names (`feat/x`) and must not become path segments.
	assert.equal(tarballUrl(ref, "feat/x"), "https://codeload.github.com/kittors/Lyra/tar.gz/feat%2Fx");
});

test("the owner avatar is derived, not stored", () => {
	assert.equal(ownerAvatar(parseRepo("kittors/Lyra")!), "https://github.com/kittors.png?size=128");
});

test("a sub-path is kept when it stays inside the checkout", () => {
	assert.equal(normalisePath("plugins/waza"), "plugins/waza");
	assert.equal(normalisePath("/plugins/waza/"), "plugins/waza");
});

test("no sub-path and an empty sub-path both mean the repository root", () => {
	// The distinction matters to the caller and not to the answer: "" is the root, null is refusal.
	assert.equal(normalisePath(undefined), "");
	assert.equal(normalisePath(""), "");
	assert.equal(normalisePath("/"), "");
});

test("a sub-path that climbs out is refused", () => {
	assert.equal(normalisePath("../secrets"), null);
	assert.equal(normalisePath("plugins/../../etc"), null);
	assert.equal(normalisePath("./plugins"), null);
	assert.equal(normalisePath("plugins//waza"), null, "an empty segment is not a segment");
});
