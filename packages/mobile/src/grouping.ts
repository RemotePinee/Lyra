/**
 * Message grouping for mobile transcript, aligned with Desktop grouping.ts.
 * Groups consecutive tool calls across multi-turn assistant messages & intermediate tool results
 * into a single cohesive ToolGroup block.
 */

import type { AssistantContent, AssistantMessage, Message, SessionMeta } from "./protocol";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

export type MobileCall = { block: ToolCallBlock; stopReason: AssistantMessage["stopReason"] };

export type MobileRun =
	| { kind: "message"; message: Message; index: number; upTo: number; from?: number }
	| { kind: "tools"; id: string; calls: MobileCall[]; live?: boolean };

function isNudge(message: Message | undefined): boolean {
	if (message?.role !== "user") return false;
	return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
}

function leadingThinking(content: AssistantContent[]): number {
	let count = 0;
	for (const block of content) {
		if (block.type !== "thinking") break;
		count++;
	}
	return count;
}

function spoken(content: AssistantContent[]): number {
	let end = 0;
	for (const [index, block] of content.entries()) {
		if (block.type === "text" && block.text.trim()) end = index + 1;
	}
	return end;
}

function reasoning(content: AssistantContent[]): boolean {
	return content.some((block) => block.type === "thinking" && block.thinking.length > 0);
}

function liveReasoning(messages: Message[], live: number): number {
	if (live < 0) return -1;
	const last = messages[live];
	if (last.role !== "assistant") return -1;
	if (spoken(last.content) > 0) return leadingThinking(last.content) > 0 ? live : -1;
	for (let at = live; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user") {
			if (message.synthetic || isNudge(message)) continue;
			return -1;
		}
		if (message.role !== "assistant") continue;
		if (spoken(message.content) > 0) return -1;
		const calls = message.content.some((block) => block.type === "toolCall");
		if (reasoning(message.content) && (calls || message.stopReason === "pending")) return at;
		if (!calls && message.stopReason !== "pending") return -1;
	}
	return -1;
}

function liveWork(messages: Message[], live: number, rowOfCalls: Map<number, number>): number {
	if (live < 0) return -1;
	const latest = messages[live];
	const inFlight = latest.role === "assistant" && latest.stopReason === "pending";
	for (let at = inFlight ? live : messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user") {
			if (message.synthetic || isNudge(message)) continue;
			return -1;
		}
		if (message.role !== "assistant") continue;
		const row = rowOfCalls.get(at);
		if (row !== undefined) return row;
		if (spoken(message.content) > 0) return -1;
	}
	return -1;
}

function turnWork(messages: Message[], live: number, rowOfCalls: Map<number, number>): number {
	for (let at = live; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user") {
			if (message.synthetic || isNudge(message)) continue;
			return -1;
		}
		if (message.role !== "assistant") continue;
		const row = rowOfCalls.get(at);
		if (row !== undefined) return row;
	}
	return -1;
}

export function groupMessages(messages: Message[]): MobileRun[] {
	const out: MobileRun[] = [];

	let live = -1;
	for (let at = messages.length - 1; at >= 0 && live < 0; at--) {
		if (messages[at].role === "assistant") live = at;
	}
	const reasoningRow = liveReasoning(messages, live);
	const rowOfCalls = new Map<number, number>();
	const seenToolGroupIds = new Set<string>();

	const work = (calls: MobileCall[], from: number) => {
		if (calls.length === 0) return;
		const last = out[out.length - 1];
		if (last?.kind === "tools") {
			for (const call of calls) {
				if (!last.calls.some((c) => c.block.id === call.block.id)) {
					last.calls.push(call);
				}
			}
		} else {
			const baseId = calls[0]?.block.id ?? `tools-${out.length}`;
			let id = baseId;
			if (seenToolGroupIds.has(id)) {
				id = `${baseId}_${out.length}`;
			}
			seenToolGroupIds.add(id);
			out.push({ kind: "tools", id, calls });
		}
		rowOfCalls.set(from, out.length - 1);
	};

	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult") continue;
		if (message.role === "user" && (message.synthetic || isNudge(message))) continue;

		if (message.role !== "assistant") {
			out.push({ kind: "message", message, index, upTo: message.content.length });
			continue;
		}

		const said = spoken(message.content);
		const calls: MobileCall[] = [];
		for (const block of message.content.slice(said)) {
			if (block.type === "toolCall") calls.push({ block, stopReason: message.stopReason });
		}

		if (said > 0) {
			out.push({ kind: "message", message, index, from: 0, upTo: said });
		} else if (calls.length === 0 && message.stopReason !== "pending") {
			out.push({ kind: "message", message, index, from: 0, upTo: message.content.length });
		}
		work(calls, index);
	}

	let working = liveWork(messages, live, rowOfCalls);

	if (reasoningRow >= 0) {
		const shown = messages[reasoningRow] as AssistantMessage;
		const think = leadingThinking(shown.content);
		const workIndex = turnWork(messages, live, rowOfCalls);
		const own = out.findIndex((row) => row.kind === "message" && row.index === reasoningRow);
		if (think > 0 && (workIndex >= 0 || own < 0)) {
			const at = workIndex >= 0 ? workIndex : out.length;
			out.splice(at, 0, { kind: "message", message: shown, index: reasoningRow, upTo: think });
			if (working >= at) working += 1;
			if (own >= 0) {
				const row = out[own >= at ? own + 1 : own];
				if (row.kind === "message") row.from = think;
			}
		}
	}

	if (working >= 0) {
		const row = out[working];
		if (row?.kind === "tools") row.live = true;
	}

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
