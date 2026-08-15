/**
 * Which approval policy is in force.
 *
 * Bound by the host at boot like the other seams. The fallback is the built-in blacklist, so the
 * CLI and the tests judge risk the same way the app does without having to build a kernel.
 */

import type { ApprovalPolicy } from "../kernel/services.ts";
import { assessCommand, assessNetwork, assessWrite } from "../tools/risk.ts";

const BUILT_IN: ApprovalPolicy = {
	assess(kind, subject, cwd) {
		if (kind === "bash") return assessCommand(subject, cwd);
		if (kind === "edit" || kind === "write") return assessWrite(subject, cwd);
		if (kind === "network") return assessNetwork(subject);
		// An unfamiliar kind is one this policy was not written for, so it defers to a person.
		return { risky: true };
	},
};

let bound: ApprovalPolicy | null = null;

export function useApprovalPolicy(next: ApprovalPolicy | null): void {
	bound = next;
}

export function approvalPolicy(): ApprovalPolicy {
	return bound ?? BUILT_IN;
}
