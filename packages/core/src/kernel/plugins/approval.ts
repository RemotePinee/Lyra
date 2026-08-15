import { assessCommand, assessNetwork, assessWrite } from "../../tools/risk.ts";
import type { Context, Plugin } from "../context.ts";
import { APPROVAL, type ApprovalPolicy, type ApprovalVerdict } from "../services.ts";

/**
 * Which actions may proceed without a person.
 *
 * A seam because the answer is a matter of policy, not of fact: a personal machine, a shared
 * build box and a locked-down deployment want three different lines, and they should differ by
 * which policy is loaded rather than by branches inside one function.
 *
 * The built-in policy is a blacklist. Asking about everything that writes turns the prompt into
 * something people learn to click through, which is worse than not having it — so it asks about
 * what cannot be taken back, and nothing else.
 */
class DefaultPolicy implements ApprovalPolicy {
	assess(kind: string, subject: string, cwd: string): ApprovalVerdict {
		if (kind === "bash") return assessCommand(subject, cwd);
		if (kind === "edit" || kind === "write") return assessWrite(subject, cwd);
		if (kind === "network") return assessNetwork(subject);
		// An unfamiliar kind is one this policy was not written for, so it defers to a person.
		return { risky: true };
	}
}

export const approvalPlugin: Plugin = {
	name: "approval",
	apply(ctx: Context) {
		return ctx.provide<ApprovalPolicy>(APPROVAL, new DefaultPolicy());
	},
};
