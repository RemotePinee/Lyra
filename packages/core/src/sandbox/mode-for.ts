/**
 * What each permission mode means once there is a sandbox to mean it with.
 *
 * These three modes have always been about one thing — how often you get asked — and that made
 * them a preference rather than a boundary. `auto` meant "ask me less", which is a description of
 * the prompts, not of what the agent can reach. With confinement behind them each one is also a
 * fact about the filesystem:
 *
 * - `ask` runs read-only. Nothing is written without somebody saying so, and the sandbox is what
 *   makes that true rather than a promise that every risky command was correctly guessed at.
 * - `auto` runs workspace-write: the project and the temp areas, nothing else. This is the mode
 *   the app is used in, and it is where the change is felt — the agent edits the project freely
 *   and cannot touch `~/.ssh`, whether or not anybody predicted that it might try.
 * - `full` is the absence of a sandbox, which is what the name has always said.
 *
 * Kept apart from `settings.ts` because it is a statement about enforcement, and `settings.ts`
 * should not have to know that a sandbox exists.
 */

import type { PermissionMode } from "../config/settings.ts";
import type { SandboxMode } from "./policy.ts";

const BY_PERMISSION: Record<PermissionMode, SandboxMode> = {
	ask: "read-only",
	auto: "workspace-write",
	full: "danger-full-access",
};

/**
 * The sandbox mode a permission mode implies.
 *
 * Total over the three modes on purpose: a new permission mode should not silently inherit the
 * loosest confinement because a lookup missed, and TypeScript will point at this table the moment
 * one is added.
 */
export function sandboxModeFor(permission: PermissionMode): SandboxMode {
	return BY_PERMISSION[permission];
}
