/**
 * Deciding whether an action needs a person.
 *
 * Holds the pending questions and the "always allow" answers for this process. Separate from the
 * session because the policy question — is this safe to do unattended — has nothing to do with the
 * conversation it happens to arise in, and because a prompt that fires constantly is not a
 * safeguard but something you learn to click through.
 */

import { randomUUID } from "node:crypto";
import type { PermissionMode } from "../config/settings.ts";
import type { ApprovalDecision, ApprovalRequest } from "../types.ts";
import { approvalPolicy } from "./approval-policy.ts";

export interface PendingApproval {
	id: string;
	request: ApprovalRequest;
	resolve: (decision: ApprovalDecision) => void;
}

/** How long a question waits for a person before it is treated as refused. */
const UNATTENDED_TIMEOUT_MS = 5 * 60_000;

export interface ApprovalGateOptions {
	mode(): PermissionMode;
	cwd(): string;
	/** Ask the user. The gate does not know what a window is. */
	ask(pending: PendingApproval): Promise<void>;
	/** Remember an "always" answer beyond this process. */
	remember(subject: string): void;
	/** Overridable so a test does not have to wait five minutes to see the timeout work. */
	unattendedTimeoutMs?: number;
}

export class ApprovalGate {
	private readonly pending = new Map<string, PendingApproval>();
	/** Subjects the user chose "always allow" for, within this process. */
	private readonly allowList = new Set<string>();
	private readonly options: ApprovalGateOptions;

	constructor(options: ApprovalGateOptions, alwaysAllow: Iterable<string> = []) {
		this.options = options;
		for (const subject of alwaysAllow) this.allowList.add(subject);
	}

	allow(subject: string): void {
		this.allowList.add(subject);
	}

	list(): { id: string; request: ApprovalRequest }[] {
		return [...this.pending.values()].map(({ id, request }) => ({ id, request }));
	}

	resolve(requestId: string, decision: ApprovalDecision): boolean {
		const entry = this.pending.get(requestId);
		if (!entry) return false;
		entry.resolve(decision);
		return true;
	}

	/**
	 * Decide whether one action may proceed, asking the user if it may not.
	 *
	 * `full` never asks; `auto` asks only about what cannot be taken back, which is judged by the
	 * approval policy rather than here — that judgement is a matter of where the agent is running,
	 * and a plugin can replace it. Anything else asks.
	 */
	async request(request: ApprovalRequest): Promise<ApprovalDecision> {
		const mode = this.options.mode();
		if (mode === "full") return "once";
		if (this.allowList.has(request.subject)) return "once";

		if (mode === "auto") {
			const verdict = approvalPolicy().assess(request.kind, request.subject, this.options.cwd());
			if (!verdict.risky) return "once";
			if (verdict.reason) request.detail = `${verdict.reason}\n\n${request.detail ?? ""}`.trim();
		}

		const id = randomUUID();
		return new Promise<ApprovalDecision>((resolve) => {
			/*
			 * Nobody there is an answer too — and the answer is no.
			 *
			 * A question with no one to read it used to stop a run indefinitely: the agent waited,
			 * the window showed a spinner, and an overnight task was still on its first prompt in
			 * the morning. Expiring into a rejection is the only safe direction — it grants
			 * nothing that was not granted — and it lets the agent find another way, which is
			 * usually what it does with a refusal.
			 *
			 * Long enough that someone who stepped away for a coffee still gets to decide.
			 */
			let timer: ReturnType<typeof setTimeout> | undefined;
			const entry: PendingApproval = {
				id,
				request,
				resolve: (decision) => {
					if (timer) clearTimeout(timer);
					this.pending.delete(id);
					if (decision === "always") {
						this.allowList.add(request.subject);
						this.options.remember(request.subject);
					}
					// "always" is an answer about the future; this call still just proceeds.
					resolve(decision === "always" ? "once" : decision);
				},
			};
			timer = setTimeout(() => entry.resolve("reject"), this.options.unattendedTimeoutMs ?? UNATTENDED_TIMEOUT_MS);
			this.pending.set(id, entry);
			void this.options.ask(entry);
		});
	}

	/** Reject everything still waiting. Called when a run ends, so nothing hangs forever. */
	rejectAll(): void {
		for (const entry of this.pending.values()) entry.resolve("reject");
		this.pending.clear();
	}
}
