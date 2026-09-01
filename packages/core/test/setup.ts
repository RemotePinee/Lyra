/**
 * Forgetting the repository this process was started from, before any test runs.
 *
 * The same guard as `packages/desktop/test/setup.ts`, for the same reason: a git hook exports
 * `GIT_DIR` naming the real repository, and it outranks the `cwd` a test passes when it builds a
 * fixture repository in a temporary directory. Tests then commit to the checkout they were
 * launched from.
 *
 * See that file for what it looked like when it happened.
 */

for (const key of Object.keys(process.env)) {
	if (key.startsWith("GIT_")) delete process.env[key];
}
