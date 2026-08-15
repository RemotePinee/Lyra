import { LocalSandbox } from "../../sandbox/local.ts";
import type { Context, Plugin } from "../context.ts";
import { SANDBOX, type Sandbox } from "../services.ts";

/**
 * Where commands run.
 *
 * On a personal machine the answer is "here, as me", which is what this provides. It is a seam
 * because that answer stops being obvious the moment the agent is not sitting on the user's laptop:
 * a container per session, a remote builder, a filesystem the agent may not actually reach. All of
 * those are the same interface with a different process on the other end.
 */
export const sandboxPlugin: Plugin = {
	name: "sandbox",
	apply(ctx: Context) {
		return ctx.provide<Sandbox>(SANDBOX, new LocalSandbox());
	},
};
