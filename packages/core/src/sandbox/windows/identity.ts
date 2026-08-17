/**
 * Who a confined Windows process is allowed to be, and how a command line is spelled.
 *
 * The whole Windows backend rests on two ideas that can be stated without touching Win32 at all,
 * which is why they live here on their own: a *capability SID* that names one directory's write
 * permission, and a *command line* that survives being parsed back into arguments. Both are pure
 * string work, both are places where a mistake is silent and severe, and both are testable on any
 * machine — including the one this was written on, which is not a Windows machine.
 */

import { createHash } from "node:crypto";

/**
 * The write identity for one workspace.
 *
 * `S-1-4-x-y` is the "non-unique authority" range: SIDs nobody issues, which is exactly what is
 * wanted. This one is *derived*, not registered — its entire power comes from the ACE that names
 * it on the workspace directory, and it means nothing anywhere else. Deriving it from the path
 * rather than minting a random one is what makes it stable: the same workspace gets the same SID
 * across sessions and restarts, so the directory's ACE is written once instead of once per run.
 *
 * The path must already be canonical. Two spellings of one directory would otherwise derive two
 * identities, and the second one would need its own pass over the tree to mean anything.
 *
 * Subauthorities are kept under 2^30 and never zero: the values ride in a SID's 32-bit fields, and
 * a zero subauthority is a shape Windows tooling treats inconsistently.
 */
export function workspaceWriteSid(workspaceRoot: string): string {
	const digest = createHash("sha256").update(workspaceRoot, "utf8").digest();
	const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
	const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
	return `S-1-4-${first}-${second}`;
}

/**
 * The write identity for one private temp directory.
 *
 * Separate from the workspace identity on purpose. Sharing one would let any session write any
 * other session's temp tree — they would all be carrying the same capability. The extra trailing
 * subauthority also keeps these from ever colliding with a two-part workspace SID, and the domain
 * separator in the hash keeps the two derivations from agreeing by accident.
 */
export function tempWriteSid(tempDir: string): string {
	const digest = createHash("sha256").update("temp\0", "utf8").update(tempDir, "utf8").digest();
	const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
	const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
	return `S-1-4-${first}-${second}-1`;
}

/**
 * One argument, quoted the way the C runtime parses it back.
 *
 * Windows has no argv. `CreateProcess` takes a single string and every program splits it again
 * itself, almost all of them by the CRT's rules — so this is the inverse of that splitting, and
 * getting it wrong does not produce a quoting error, it produces different arguments.
 *
 * The backslash rule is the part that surprises people: a backslash is only an escape when a quote
 * follows it. `C:\dir\` is literal, but the same string before a closing quote would escape that
 * quote and swallow the rest of the command line — so a trailing run is doubled, and a run before
 * a literal quote is doubled plus one.
 */
export function quoteArg(argument: string): string {
	if (argument === "") return '""';
	if (!/[\s"]/u.test(argument)) return argument;

	let quoted = '"';
	for (let index = 0; index < argument.length; index++) {
		let backslashes = 0;
		while (index < argument.length && argument.charAt(index) === "\\") {
			backslashes++;
			index++;
		}
		if (index === argument.length) {
			quoted += "\\".repeat(backslashes * 2);
		} else if (argument.charAt(index) === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1) + '"';
		} else {
			quoted += "\\".repeat(backslashes) + argument.charAt(index);
		}
	}
	return `${quoted}"`;
}

/** The single string `CreateProcess` takes, built from a program and its arguments. */
export function buildCommandLine(program: string, args: readonly string[]): string {
	return [program, ...args].map(quoteArg).join(" ");
}

/**
 * Which identities a confined token may still write as.
 *
 * This is the sandbox. A `WRITE_RESTRICTED` token checks every write twice — once against the
 * object's DACL as usual, and once against *this* list — and grants only what passes both. So the
 * list is the complete answer to "what can this process change".
 *
 * Two entries are always present and are the reason this is `partial` rather than `full`
 * enforcement:
 *
 * - The **logon SID** and **Everyone** have to be here or the process does not start. Windows
 *   loader initialisation and CNG both need to write to per-logon objects, and a token without
 *   them dies at `0xC0000142` before any of our code runs. Everyone being present means any object
 *   whose DACL grants Everyone write access stays writable — the documented hole, and not one that
 *   can be closed while still having a process.
 *
 * - `Authenticated Users`, `INTERACTIVE` and `LOCAL` are deliberately **absent**. Each of them is
 *   granted write access somewhere on a default Windows install (the `C:\` root, the Public tree),
 *   so including any of them would hand back most of what the sandbox took away.
 *
 * Under `read-only` no write capability is added at all — which also means an ACE left on a
 * workspace from an earlier `workspace-write` session is simply inert, rather than something that
 * has to be found and revoked.
 */
export function restrictingSidNames(
	mode: "read-only" | "workspace-write",
	writeSids: readonly string[],
): { logon: true; world: true; write: readonly string[] } {
	if (mode === "read-only") return { logon: true, world: true, write: [] };
	if (writeSids.length === 0) {
		throw new Error("workspace-write 至少需要一个可写能力 SID，否则这个令牌什么都写不了");
	}
	return { logon: true, world: true, write: [...new Set(writeSids)] };
}
