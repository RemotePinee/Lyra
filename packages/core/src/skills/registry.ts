/**
 * Which skill registry the runtime reads.
 *
 * Bound by the host at boot, as with the other seams. Unbound, there are simply no code-provided
 * skills — the session still loads everything on disk, so a host that never builds a kernel is not
 * missing anything it had before.
 */

import type { SkillRegistry } from "../kernel/services.ts";
import type { Skill } from "./loader.ts";

let bound: SkillRegistry | null = null;

export function useSkillRegistry(next: SkillRegistry | null): void {
	bound = next;
}

export function registeredSkills(): Skill[] {
	return bound?.all() ?? [];
}
