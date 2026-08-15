import type { Skill } from "../../skills/loader.ts";
import type { Context, Plugin } from "../context.ts";
import { SKILLS, type SkillRegistry } from "../services.ts";

class Registry implements SkillRegistry {
	private readonly sets: Skill[][] = [];

	register(skills: Skill[]): () => void {
		this.sets.push(skills);
		return () => {
			const at = this.sets.indexOf(skills);
			if (at >= 0) this.sets.splice(at, 1);
		};
	}

	all(): Skill[] {
		// Same rule as tools: the later registration wins, so a plugin can override one it
		// inherited rather than having to prevent it from loading.
		const byName = new Map<string, Skill>();
		for (const set of this.sets) for (const skill of set) byName.set(skill.name, skill);
		return [...byName.values()];
	}
}

/**
 * Skills that come from code rather than from disk.
 *
 * Empty by default — the app ships no built-in skills, because a procedure worth naming is usually
 * one a particular team wrote. The registry exists so a plugin has somewhere to put one.
 */
export const skillsPlugin: Plugin = {
	name: "skills",
	apply(ctx: Context) {
		return ctx.provide<SkillRegistry>(SKILLS, new Registry());
	},
};
