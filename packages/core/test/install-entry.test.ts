/**
 * Installing something, for real: a git repository on disk, cloned, sorted and filed.
 *
 * Everything under test here was previously covered only in the negative — `uninstallEntry` had
 * tests, `inspectBundle` had tests, and the step between them, which is the one that writes to the
 * user's home directory, had none. That is the step where the interesting things happen: which of
 * the three directories a bundle lands in is decided by reading its contents rather than by
 * believing the index, a second install of the same id has to be refused, and a `path` that climbs
 * out of the checkout has to be refused before anything is cloned.
 *
 * Nothing is stubbed. `installEntry` shells out to `git clone`, so these build actual repositories
 * in a temporary directory and let it clone them — `git` treats a local path as a remote, which is
 * what makes a real test of the real code path possible without a network. The one thing that
 * cannot be reached this way is the tarball route, which insists on https; its verification half is
 * exercised directly in `fetch-bundle.test.ts`, and the fallback *to* git is exercised below.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { RegistryEntry } from "@lyra/registry-shared";

import { bundleRoot, installEntry, uninstallEntry } from "../src/plugins/registry.ts";

const run = promisify(execFile);

/** A home of our own, so the tests never look at, or write to, the machine's real `~/.lyra`. */
async function withHome(body: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "lyra-install-"));
	const previous = process.env.LYRA_HOME;
	process.env.LYRA_HOME = home;
	try {
		await body(home);
	} finally {
		if (previous === undefined) delete process.env.LYRA_HOME;
		else process.env.LYRA_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
}

/**
 * A git repository holding the given files, committed once.
 *
 * Returned as a path, which is what goes into `entry.repository`. `git clone` accepts a local
 * directory as a remote and warns that `--depth` is meaningless for one — a warning on stderr,
 * not a failure, so the code under test runs exactly as it does against GitHub.
 */
async function repoWith(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lyra-repo-"));
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, content);
	}
	await run("git", ["init", "-q", "."], { cwd: dir });
	await run("git", ["add", "-A"], { cwd: dir });
	await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

function entryFor(id: string, repository: string, extra: Partial<RegistryEntry> = {}): RegistryEntry {
	return { id, name: id, repository, kind: "plugin", ...extra };
}

/** One skill, in the layout the loader expects: a directory with a `SKILL.md` in it. */
function skillFiles(prefix: string, ...names: string[]): Record<string, string> {
	return Object.fromEntries(
		names.map((name) => [
			`${prefix}${name}/SKILL.md`,
			`---\nname: ${name}\ndescription: 测试用的技能。\n---\n\n做点什么。\n`,
		]),
	);
}

test("a directory of skills installs as a plugin, into the plugins directory", async () => {
	await withHome(async () => {
		const repo = await repoWith({
			"plugin.json": JSON.stringify({ name: "demo", version: "1.0.0", skills: "skills" }),
			...skillFiles("skills/", "review"),
		});

		const installed = await installEntry(entryFor("demo", repo));

		assert.equal(installed.kind, "plugin");
		assert.equal(installed.dir, join(bundleRoot("plugin"), "demo"));
		assert.deepEqual(installed.servers, []);
		// The files are actually there, which is the only thing the user cares about.
		const manifest = await readFile(join(installed.dir, "plugin.json"), "utf8");
		assert.match(manifest, /"name": ?"demo"/);
		assert.ok((await stat(join(installed.dir, "skills", "review", "SKILL.md"))).isFile());
	});
});

test("the clone's `.git` does not come with it", async () => {
	await withHome(async () => {
		/*
		 * A `.git` inside `~/.lyra/plugins/demo` is a checkout of somebody else's repository sitting
		 * in the user's home directory: it makes the plugin directory a git working tree, so anything
		 * that walks upward looking for one — an editor, a status line, `git status` run one directory
		 * too high — finds it and reports on it.
		 */
		const repo = await repoWith({
			"plugin.json": JSON.stringify({ name: "demo", skills: "skills" }),
			...skillFiles("skills/", "review"),
		});

		const installed = await installEntry(entryFor("demo", repo));

		assert.equal(await stat(join(installed.dir, ".git")).catch(() => null), null);
	});
});

test("a directory holding only a server declaration installs as MCP, whatever the index called it", async () => {
	await withHome(async () => {
		/*
		 * Exactly the case that forced the plugin/MCP split: the registry in the wild lists every one
		 * of its MCP servers as `kind: "plugin"`. Believing it put seven servers in the plugins
		 * directory, where the MCP settings page — which reads the settings file — could not see them.
		 */
		const repo = await repoWith({
			".mcp.json": JSON.stringify({
				mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
			}),
		});

		const installed = await installEntry(entryFor("context7", repo, { kind: "plugin" }), "Lyra Registry");

		assert.equal(installed.kind, "mcp", "read off the contents, not taken from the index");
		assert.equal(installed.dir, join(bundleRoot("mcp"), "context7"));
		// And nothing was left in the plugins directory it was listed under.
		assert.deepEqual(await readdir(bundleRoot("plugin")).catch(() => []), []);
	});
});

test("an installed server carries where it came from, which is what uninstalling looks for", async () => {
	await withHome(async () => {
		const repo = await repoWith({
			".mcp.json": JSON.stringify({ mcpServers: { c7: { command: "npx", args: [] } } }),
		});

		const installed = await installEntry(entryFor("context7", repo, { kind: "mcp" }), "Lyra Registry");

		assert.equal(installed.servers.length, 1);
		assert.deepEqual(installed.servers[0].origin, {
			bundle: "context7",
			registry: "Lyra Registry",
			version: undefined,
		});
	});
});

test("a skill collection is flattened in among the loose skills, prefixed with its id", async () => {
	await withHome(async () => {
		/*
		 * A collection has no directory of its own, and that is not an oversight: `loadSkills` reads
		 * one level, so a collection dropped in whole would be invisible to the agent. The prefix is
		 * what keeps two collections that both ship a `review` from overwriting each other.
		 */
		const repo = await repoWith(skillFiles("skills/", "check", "hunt"));

		const installed = await installEntry(entryFor("waza", repo, { kind: "skill", path: "skills" }));

		assert.equal(installed.kind, "skill");
		assert.equal(installed.dir, bundleRoot("skill"), "the skills directory, not one of its own");
		assert.match(installed.name, /2 个技能/, "the count is the fact worth reporting back");
		assert.deepEqual((await readdir(bundleRoot("skill"))).sort(), ["waza-check", "waza-hunt"]);
	});
});

test("a collection that installs and then uninstalls leaves nothing behind", async () => {
	await withHome(async () => {
		const repo = await repoWith(skillFiles("skills/", "check", "hunt"));
		await mkdir(bundleRoot("skill"), { recursive: true });
		await writeFile(join(bundleRoot("skill"), "keep-me"), "not a directory, and not ours");

		await installEntry(entryFor("waza", repo, { kind: "skill", path: "skills" }));
		await uninstallEntry("waza");

		assert.deepEqual(await readdir(bundleRoot("skill")), ["keep-me"]);
	});
});

test("installing the same id twice is refused rather than merged", async () => {
	await withHome(async () => {
		const repo = await repoWith({
			"plugin.json": JSON.stringify({ name: "demo", skills: "skills" }),
			...skillFiles("skills/", "review"),
		});
		const entry = entryFor("demo", repo);

		await installEntry(entry);

		await assert.rejects(() => installEntry(entry), /已经装过/);
	});
});

test("a collection already on disk is recognised by its prefix, not by a directory", async () => {
	await withHome(async () => {
		/*
		 * The check a collection needs is different from the one a bundle needs, and getting it wrong
		 * is silent: a second install overwrites every skill the collection still ships and leaves
		 * behind the ones it has since dropped, which is a worse state than either version.
		 */
		const repo = await repoWith(skillFiles("skills/", "check"));
		const entry = entryFor("waza", repo, { kind: "skill", path: "skills" });

		await installEntry(entry);

		await assert.rejects(() => installEntry(entry), /已经装过/);
	});
});

test("a path that climbs out of the checkout is refused before anything is fetched", async () => {
	await withHome(async () => {
		const entry = entryFor("evil", "https://github.com/x/y.git", { path: "../../../etc" });

		await assert.rejects(() => installEntry(entry), /路径不合法/);
	});
});

test("a sub-path the repository does not have is a message, not a directory of nothing", async () => {
	await withHome(async () => {
		const repo = await repoWith({ "readme.md": "# nothing installable here" });

		await assert.rejects(
			() => installEntry(entryFor("demo", repo, { path: "plugins/demo" })),
			/仓库里没有 plugins\/demo 这个目录/,
		);
	});
});

test("a repository with nothing installable in it says so, and leaves nothing behind", async () => {
	await withHome(async (home) => {
		const repo = await repoWith({ "readme.md": "# just a readme" });

		await assert.rejects(() => installEntry(entryFor("demo", repo)), /安装失败/);

		// The staging directory is the debris a failed install would leave in `~/.lyra/plugins`.
		assert.deepEqual(await readdir(join(home, "plugins")).catch(() => []), []);
	});
});

test("a sub-path is what gets kept; the rest of the repository is not", async () => {
	await withHome(async () => {
		/*
		 * One repository, many bundles — which is how the default registry is laid out, and the whole
		 * reason `path` exists. Installing Context7 out of it must not also install Filesystem.
		 */
		const repo = await repoWith({
			"plugins/context7/.mcp.json": JSON.stringify({ mcpServers: { c7: { command: "npx", args: [] } } }),
			"plugins/filesystem/.mcp.json": JSON.stringify({ mcpServers: { fs: { command: "npx", args: [] } } }),
			"readme.md": "# the collection itself",
		});

		const installed = await installEntry(entryFor("context7", repo, { kind: "mcp", path: "plugins/context7" }));

		assert.deepEqual((await readdir(installed.dir)).sort(), [".mcp.json"]);
		assert.deepEqual(await readdir(bundleRoot("mcp")), ["context7"]);
	});
});

test("a tarball that cannot be had falls back to cloning, and the install still works", async () => {
	await withHome(async () => {
		/*
		 * The download is the fast path, not the only path. A registry entry can outlive the archive
		 * it advertises — a platform redeploying, a URL retired — and when it does, the git URL beside
		 * it is still good. Falling back is what keeps a stale index installable.
		 */
		const repo = await repoWith({
			"plugin.json": JSON.stringify({ name: "demo", skills: "skills" }),
			...skillFiles("skills/", "review"),
		});

		const installed = await installEntry(
			entryFor("demo", repo, {
				// Resolves nowhere: `.invalid` is reserved by RFC 2606 precisely so it never will.
				tarball: "https://lyra-registry.invalid/v1/download/demo/1.0.0",
				sha256: "0".repeat(64),
			}),
		);

		assert.equal(installed.kind, "plugin");
		assert.ok((await stat(join(installed.dir, "skills", "review", "SKILL.md"))).isFile());
	});
});
