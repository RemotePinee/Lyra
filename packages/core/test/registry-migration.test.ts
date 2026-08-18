/**
 * Moving an existing install off the file-based index.
 *
 * The default changed, and a default only reaches somebody who has never saved a settings file.
 * Everyone else keeps whatever was written the first time they opened the app — which is the
 * `raw.githubusercontent.com` URL that returns 429. Rewriting it on read is what makes the fix
 * arrive; getting the boundary of that rewrite wrong is what would silently discard somebody's own
 * source, so the boundary is what these check.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_PLUGIN_REGISTRY,
	DEFAULT_SKILL_REGISTRY,
	migrateRegistries,
} from "../src/config/settings.ts";

const OLD_PLUGINS = "https://raw.githubusercontent.com/kittors/Lyra-Plugins/main/registry.json";
const OLD_SKILLS = "https://raw.githubusercontent.com/kittors/Lyra-Plugins/main/skills.json";

test("the presets we shipped move to the platform", () => {
	assert.deepEqual(migrateRegistries([OLD_PLUGINS]), [DEFAULT_PLUGIN_REGISTRY]);
	assert.deepEqual(migrateRegistries([OLD_SKILLS]), [DEFAULT_SKILL_REGISTRY]);
});

test("a source the user added is left exactly as it is", () => {
	// Somebody else's index is not ours to redirect, even to a better address.
	const theirs = "https://example.com/their-registry.json";
	assert.deepEqual(migrateRegistries([theirs]), [theirs]);
	assert.deepEqual(migrateRegistries([OLD_PLUGINS, theirs]), [DEFAULT_PLUGIN_REGISTRY, theirs]);
});

test("having both the old and the new does not produce the new twice", () => {
	assert.deepEqual(migrateRegistries([OLD_PLUGINS, DEFAULT_PLUGIN_REGISTRY]), [DEFAULT_PLUGIN_REGISTRY]);
});

test("an empty list stays empty", () => {
	// Removing every source is a deliberate act; re-adding one would override it.
	assert.deepEqual(migrateRegistries([]), []);
});

test("a URL that merely resembles the old one is not rewritten", () => {
	const lookalike = "https://raw.githubusercontent.com/someone-else/Lyra-Plugins/main/registry.json";
	assert.deepEqual(migrateRegistries([lookalike]), [lookalike]);
});

test("the new defaults point at the platform's compatibility endpoint", () => {
	// `/v1/index` answers in the old file format, which is what lets an un-upgraded app use it.
	assert.match(DEFAULT_PLUGIN_REGISTRY, /^https:\/\/.+\/v1\/index$/);
	assert.match(DEFAULT_SKILL_REGISTRY, /^https:\/\/.+\/v1\/index\?kind=skill$/);
});
