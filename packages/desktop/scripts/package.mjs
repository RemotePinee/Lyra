/**
 * Packaging, and the one decision it has to make: what to sign with.
 *
 * `electron-builder.yml` pins `mac.identity: "-"` so that no path ever leaves a bundle unsigned.
 * This overrides that pin — and only that pin — when a real signing identity is available.
 *
 * Why it matters is in `electron-builder.yml` and `make-signing-cert.sh`: ad-hoc signing ties the
 * app's identity to a hash of its own executable, so every update is a different application to
 * macOS and every permission granted to the previous one is revoked. Signing with a certificate —
 * any certificate, including a self-signed one — ties it to the certificate instead.
 *
 * **Why the identity is looked up rather than handed over.** electron-builder can import a `.p12`
 * itself from `CSC_LINK`, and that path is broken in 26.15.3: it creates the temporary keychain
 * with a random password
 *
 *     const keychainPassword = randomBytes(32).toString("base64")
 *
 * and then unlocks it with the *certificate's* password
 *
 *     ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]
 *
 * which fails with "The user name or passphrase you entered is not correct" — about a password
 * that is correct. So the keychain is prepared by whoever is calling (see `release.yml`), and all
 * that is needed here is the name to sign under.
 */

import { spawnSync } from "node:child_process";

/** The name in the certificate `make-signing-cert.sh` generates. */
const DEFAULT_IDENTITY = "Lyra Code Signing";

const mac = process.platform === "darwin";
const identity = process.env.MAC_SIGNING_IDENTITY?.trim() || DEFAULT_IDENTITY;

/**
 * Whether that identity is actually usable for signing right now.
 *
 * Asked of the system rather than inferred from an environment variable, because the thing that
 * can go wrong is precisely that a variable was set and the keychain was not prepared — and the
 * result of guessing wrong is a build that silently signs ad-hoc and ships with permissions that
 * reset. `-v` restricts the answer to valid identities: an untrusted certificate is listed by
 * `find-identity` but refused by `codesign`, and this must agree with `codesign`.
 */
function identityAvailable() {
	const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
	return found.status === 0 && found.stdout.includes(identity);
}

const args = process.argv.slice(2);
if (mac && identityAvailable()) {
	args.push(`-c.mac.identity=${identity}`);
	console.log(`[package] signing as "${identity}" — updates will keep their permissions`);
} else if (mac) {
	console.log(`[package] no "${identity}" in the keychain: signing ad-hoc`);
	console.log("[package] macOS will treat this build as a new app and reset its permissions");
	console.log("[package] see packages/desktop/scripts/make-signing-cert.sh");
}

const result = spawnSync("electron-builder", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
