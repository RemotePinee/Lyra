/**
 * Message grouping for mobile transcript, aligned with Desktop grouping.ts.
 * Groups consecutive tool calls across multi-turn assistant messages & intermediate tool results
 * into a single cohesive ToolGroup block.
 */

import type { AssistantContent, AssistantMessage, Message, SessionMeta } from "./protocol";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

export type MobileCall = { block: ToolCallBlock; stopReason: AssistantMessage["stopReason"] };

export type MobileRun =
	| { kind: "message"; message: Message; index: number; upTo: number }
	| { kind: "tools"; id: string; calls: MobileCall[] };

function isNudge(message: Message | undefined): boolean {
	if (message?.role !== "user") return false;
	return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
}

function spoken(content: AssistantContent[]): number {
	let end = 0;
	for (const [index, block] of content.entries()) {
		if (block.type === "text" && block.text.trim()) end = index + 1;
	}
	return end;
}

export function groupMessages(messages: Message[]): MobileRun[] {
	const out: MobileRun[] = [];
	let calls: MobileCall[] = [];

	const work = (calls: MobileCall[]) => {
		if (calls.length === 0) return;
		const last = out[out.length - 1];
		if (last?.kind === "tools") {
			last.calls.push(...calls);
		} else {
			const firstId = calls[0]?.block.id ?? `tools-${out.length}`;
			out.push({ kind: "tools", id: firstId, calls });
		}
	};

	for (const [index, message] of messages.entries()) {
		// ToolResult messages are rendered inside tool cards, not as standalone rows
		if (message.role === "toolResult") continue;

		// Synthetic continuation nudges are ignored in transcript flow
		if (message.role === "user" && (message.synthetic || isNudge(message))) continue;

		if (message.role !== "assistant") {
			// Flush any pending tool calls before rendering a new user/system message
			work(calls);
			calls = [];
			out.push({ kind: "message", message, index, upTo: message.content.length });
			continue;
		}

		const said = spoken(message.content);
		for (const block of message.content.slice(said)) {
			if (block.type === "toolCall") {
				calls.push({ block, stopReason: message.stopReason });
			}
		}

		if (said > 0) {
			// Flush calls that preceded this speech, if any
			work(calls);
			calls = [];
			out.push({ kind: "message", message, index, upTo: said });
		} else if (message.content.length === 0 && message.stopReason !== "pending") {
			work(calls);
			calls = [];
			out.push({ kind: "message", message, index, upTo: message.content.length });
		}
	}

	work(calls);

	return out;
}

export function groupByProject(
	sessions: SessionMeta[],
	projects: { id: string; name: string; path: string; pinned?: boolean }[] = [],
) {
	const normalize = (p: string) => p.replace(/[/\\]+/g, "/").replace(/\/$/, "").toLowerCase();
	const projectByPath = new Map<string, { id: string; name: string; path: string }>();
	for (const p of projects) {
		projectByPath.set(normalize(p.path), p);
		if (p.id) projectByPath.set(normalize(p.id), p);
	}

	const map = new Map<string, { projectId: string; projectName: string; sessions: SessionMeta[] }>();
	for (const session of sessions) {
		const matched = projectByPath.get(normalize(session.cwd)) ?? projectByPath.get(normalize(session.projectId));
		const projectName = matched?.name ?? session.projectName;
		const groupKey = matched?.path ? normalize(matched.path) : session.projectId;

		const group = map.get(groupKey) ?? {
			projectId: session.projectId,
			projectName,
			sessions: [],
		};
		group.projectName = projectName;
		group.sessions.push(session);
		map.set(groupKey, group);
	}

	const order = new Map(projects.map((p, i) => [normalize(p.path), i]));
	return [...map.values()].sort((a, b) => {
		const matchA = projectByPath.get(normalize(a.projectId)) ?? projects.find((p) => p.name === a.projectName);
		const matchB = projectByPath.get(normalize(b.projectId)) ?? projects.find((p) => p.name === b.projectName);
		const orderA = matchA ? (order.get(normalize(matchA.path)) ?? 999) : 999;
		const orderB = matchB ? (order.get(normalize(matchB.path)) ?? 999) : 999;
		return orderA - orderB;
	});
}
