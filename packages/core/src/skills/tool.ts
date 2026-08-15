import { errorResult } from "../agent/tool-run.ts";
import type { Tool, ToolResult } from "../types.ts";
import { formatSkillInvocation, type Skill } from "./loader.ts";

export const SKILLS_KEY = "skills";

interface SkillArgs {
	name: string;
	args?: string;
}

/**
 * Loading a skill returns its instructions as the tool result, which places them in context
 * as data the model then follows. This is why the body is not in the system prompt: only the
 * skills actually used cost tokens.
 */
export const skillTool: Tool<SkillArgs> = {
	name: "skill",
	snippet: "Load a skill's instructions",
	guidelines: ["When a task matches a listed skill, load it before starting your own approach."],
	description:
		"Load a skill's instructions into the conversation. Call this when the task matches a skill listed in the " +
		"system prompt. The instructions come back as the tool result and take precedence over your default approach.",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Exact skill name from the skill list." },
			args: { type: "string", description: "Optional arguments or context to pass to the skill." },
		},
		required: ["name"],
		additionalProperties: false,
	},
	summarize: (args) => `Skill: ${args.name}`,

	async execute(args, ctx): Promise<ToolResult> {
		const skills = (ctx.state.get(SKILLS_KEY) as Skill[] | undefined) ?? [];
		const skill = skills.find((s) => s.name === args.name);
		if (!skill) {
			const available = skills.filter((s) => !s.disableModelInvocation).map((s) => s.name);
			return errorResult(
				available.length > 0
					? `No skill named "${args.name}". Available: ${available.join(", ")}.`
					: `No skill named "${args.name}", and no skills are installed.`,
			);
		}

		return {
			content: [{ type: "text", text: formatSkillInvocation(skill, args.args) }],
			details: { kind: "skill", name: skill.name, source: skill.source, path: skill.path },
		};
	},
};
