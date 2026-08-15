/**
 * Line diff used for edit previews and approval prompts.
 *
 * Implements Myers' shortest-edit-script over lines. The UI needs hunks with context
 * (not just counts) to render a proper side-by-side view, so the LCS backtrace is kept.
 */

export interface DiffLine {
	type: "context" | "add" | "remove";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface FileDiff {
	added: number;
	removed: number;
	hunks: DiffHunk[];
}

const CONTEXT_LINES = 3;

export function computeDiff(before: string, after: string, contextLines = CONTEXT_LINES): FileDiff {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	const ops = diffLines(oldLines, newLines);

	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.type === "add") added++;
		else if (op.type === "remove") removed++;
	}

	return { added, removed, hunks: groupHunks(ops, contextLines) };
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Longest common subsequence via dynamic programming, then a backtrace into edit ops. */
function diffLines(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;

	// Trim the common prefix/suffix first: real edits touch a few lines in a large file,
	// and the O(n*m) table would otherwise be built over the entire file for no reason.
	let prefix = 0;
	while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

	const midA = a.slice(prefix, n - suffix);
	const midB = b.slice(prefix, m - suffix);

	const table: number[][] = Array.from({ length: midA.length + 1 }, () => Array.from<number>({ length: midB.length + 1 }).fill(0));
	for (let i = midA.length - 1; i >= 0; i--) {
		for (let j = midB.length - 1; j >= 0; j--) {
			table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const out: DiffLine[] = [];
	let oldLine = 1;
	let newLine = 1;

	for (let i = 0; i < prefix; i++) {
		out.push({ type: "context", text: a[i], oldLine: oldLine++, newLine: newLine++ });
	}

	let i = 0;
	let j = 0;
	while (i < midA.length && j < midB.length) {
		if (midA[i] === midB[j]) {
			out.push({ type: "context", text: midA[i], oldLine: oldLine++, newLine: newLine++ });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			out.push({ type: "remove", text: midA[i], oldLine: oldLine++ });
			i++;
		} else {
			out.push({ type: "add", text: midB[j], newLine: newLine++ });
			j++;
		}
	}
	while (i < midA.length) out.push({ type: "remove", text: midA[i++], oldLine: oldLine++ });
	while (j < midB.length) out.push({ type: "add", text: midB[j++], newLine: newLine++ });

	for (let k = 0; k < suffix; k++) {
		out.push({ type: "context", text: a[n - suffix + k], oldLine: oldLine++, newLine: newLine++ });
	}

	return out;
}

function groupHunks(ops: DiffLine[], contextLines: number): DiffHunk[] {
	const changedIndexes = ops.map((op, index) => (op.type === "context" ? -1 : index)).filter((i) => i !== -1);
	if (changedIndexes.length === 0) return [];

	const hunks: DiffHunk[] = [];
	let start = Math.max(0, changedIndexes[0] - contextLines);
	let end = Math.min(ops.length - 1, changedIndexes[0] + contextLines);

	for (const index of changedIndexes.slice(1)) {
		if (index - contextLines <= end + 1) {
			end = Math.min(ops.length - 1, index + contextLines);
			continue;
		}
		hunks.push(makeHunk(ops.slice(start, end + 1)));
		start = Math.max(0, index - contextLines);
		end = Math.min(ops.length - 1, index + contextLines);
	}
	hunks.push(makeHunk(ops.slice(start, end + 1)));
	return hunks;
}

function makeHunk(lines: DiffLine[]): DiffHunk {
	return {
		oldStart: lines.find((l) => l.oldLine !== undefined)?.oldLine ?? 1,
		newStart: lines.find((l) => l.newLine !== undefined)?.newLine ?? 1,
		lines,
	};
}

/** Render a diff as unified text for approval prompts and tool output. */
export function formatDiff(diff: FileDiff, path: string, maxLines = 200): string {
	if (diff.hunks.length === 0) return `${path}: no changes`;
	const out: string[] = [`--- ${path}`, `+++ ${path}`];
	let emitted = 0;
	for (const hunk of diff.hunks) {
		out.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`);
		for (const line of hunk.lines) {
			if (emitted >= maxLines) {
				out.push(`… diff truncated (+${diff.added} / -${diff.removed} total)`);
				return out.join("\n");
			}
			out.push(`${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`);
			emitted++;
		}
	}
	return out.join("\n");
}
