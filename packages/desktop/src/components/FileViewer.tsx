import { Braces, Check, ExternalLink, Eye, FileWarning, Pencil, Save, WrapText } from "lucide-react";
import { useEffect, useState } from "react";
import type { FileContents } from "../../electron/ipc-types.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { Markdown } from "./Markdown.tsx";
import { Scroller } from "./Scroller.tsx";
import { useApp } from "../store.ts";
import { RollingText } from "./RollingText.tsx";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO = new Set(["mp4", "webm", "mov", "mkv", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);

function extensionOf(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	return dot > 0 ? lower.slice(dot + 1) : "";
}

export type FileKind = "image" | "video" | "audio" | "markdown" | "json" | "text" | "binary";

function kindOf(name: string, contents: FileContents | null): FileKind {
	const ext = extensionOf(name);
	if (IMAGE.has(ext)) return "image";
	if (VIDEO.has(ext)) return "video";
	if (AUDIO.has(ext)) return "audio";
	// A media extension wins over the NUL-byte check: a PNG is "binary" and still viewable.
	if (contents?.binary) return "binary";
	if (ext === "md" || ext === "mdx") return "markdown";
	if (ext === "json" || ext === "jsonc") return "json";
	return "text";
}

/**
 * One file, shown the way that file wants to be shown.
 *
 * A single "file contents" pane that renders everything as text is wrong for most of what is
 * actually in a project: an image becomes a wall of mojibake, a video becomes nothing at all,
 * and Markdown becomes the one thing it is least useful as. Each kind gets the treatment that
 * makes it legible, and the text kinds all get a real editor rather than a read-only dump.
 */
export function FileViewer({
	path,
	name,
	contents,
	draft,
	onDraft,
	onSaved,
}: {
	path: string;
	name: string;
	contents: FileContents;
	/** Unsaved edits, held by the browser so switching files does not discard them. */
	draft: string | undefined;
	onDraft: (text: string | undefined) => void;
	onSaved: () => void;
}) {
	const kind = kindOf(name, contents);
	const [saving, setSaving] = useState(false);
	const [justSaved, setJustSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Markdown opens rendered; the source is a click away. */
	const [showSource, setShowSource] = useState(false);
	/*
	 * Off by default, which is what a file of code wants.
	 *
	 * Wrapping keeps every character on screen at the cost of the one thing indentation is for:
	 * with a line broken in three, the shape of a nested block stops meaning anything. A minified
	 * bundle or a long prose line is the other way round, so it is a toggle rather than a policy.
	 */
	const [wrap, setWrap] = useState(false);
	const openTarget = useApp((s) => s.settings?.editor.defaultOpenTarget) ?? "Finder";

	const text = draft ?? contents.text;
	const dirty = draft !== undefined && draft !== contents.text;
	// Truncated files must not be saved: writing back the head would delete the rest.
	const readOnly = contents.truncated;

	useEffect(() => setShowSource(false), [path]);

	useEffect(() => {
		if (!justSaved) return;
		const timer = setTimeout(() => setJustSaved(false), 1600);
		return () => clearTimeout(timer);
	}, [justSaved]);

	async function save() {
		if (!dirty || saving || readOnly) return;
		setSaving(true);
		setError(null);
		const result = await window.lyra.files.write(path, text);
		setSaving(false);
		if (!result.ok) {
			setError(result.error ?? "写入失败");
			return;
		}
		onDraft(undefined);
		onSaved();
		setJustSaved(true);
	}

	/** Re-indent JSON in place; the result is an edit like any other, undoable and unsaved. */
	function formatJson() {
		try {
			onDraft(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
			setError(null);
		} catch (cause) {
			setError(`不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	const media = window.lyra.files.mediaUrl(path);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{(kind === "markdown" || kind === "json" || kind === "text" || dirty || readOnly || error) && (
				<div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
					{kind === "markdown" && (
						<Toggle
							active={showSource}
							onClick={() => setShowSource((v) => !v)}
							icon={showSource ? <Eye size={12} strokeWidth={1.9} /> : <Pencil size={12} strokeWidth={1.9} />}
							label={showSource ? "预览" : "编辑源码"}
						/>
					)}
					{/*
					 * Opens in whatever "默认文件打开目标" names.
					 *
					 * That setting existed and was saved, but nothing anywhere read it — the IPC to
					 * open a path in a named app was already there with no caller. This is the one
					 * place a file is on screen with a path in hand, so it is where it belongs.
					 */}
					<Toggle
						onClick={() => void window.lyra.system.openIn(openTarget, path)}
						icon={<ExternalLink size={12} strokeWidth={1.9} />}
						label={`在 ${openTarget} 中打开`}
					/>
					{kind === "json" && !readOnly && (
						<Toggle onClick={formatJson} icon={<Braces size={12} strokeWidth={1.9} />} label="格式化" />
					)}
					{/* Not for the markdown preview, which is prose and wraps regardless. */}
					{!(kind === "markdown" && !showSource) && (
						<Toggle
							active={wrap}
							onClick={() => setWrap((v) => !v)}
							icon={<WrapText size={12} strokeWidth={1.9} />}
							label="自动换行"
						/>
					)}

					<div className="min-w-2 flex-1" />

					{readOnly && <span className="shrink-0 text-caption text-ink-faint">文件过大，只读</span>}
					{error && (
						<span data-ly-tip={error} className="min-w-0 truncate text-caption text-danger">
							{error}
						</span>
					)}
					{dirty && !readOnly && (
						<button
							type="button"
							onClick={() => void save()}
							disabled={saving}
							data-ly-tip="保存 ⌘S"
							className="ly-item flex h-[22px] shrink-0 items-center gap-1 rounded-md px-1.5 text-detail"
						>
							<Save size={11.5} strokeWidth={1.9} />
							<RollingText>{saving ? "保存中…" : "未保存"}</RollingText>
						</button>
					)}
					{justSaved && !dirty && (
						<span className="ly-pop flex shrink-0 items-center gap-1 text-caption text-ok">
							<Check size={11.5} strokeWidth={2.2} />
							已保存
						</span>
					)}
				</div>
			)}

			{kind === "image" ? (
				<Scroller className="flex-1">
					{/* Checkerboard, so transparent images do not read as white ones. */}
					<div className="ly-checker flex min-h-full items-center justify-center p-3">
						<img src={media} alt={name} className="max-w-full rounded-md object-contain" />
					</div>
				</Scroller>
			) : kind === "video" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center bg-black/85 p-2">
					{/* biome-ignore lint/a11y/useMediaCaption: a file preview has no caption track. */}
					<video src={media} controls className="max-h-full max-w-full rounded-md" />
				</div>
			) : kind === "audio" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center p-4">
					{/* biome-ignore lint/a11y/useMediaCaption: a file preview has no caption track. */}
					<audio src={media} controls className="w-full max-w-[420px]" />
				</div>
			) : kind === "binary" ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<FileWarning size={26} strokeWidth={1.4} className="text-ink-faint" />
					<p className="text-label text-ink-muted">二进制文件，无法以文本显示。</p>
					<p className="text-detail text-ink-faint">{formatBytes(contents.bytes)}</p>
				</div>
			) : kind === "markdown" && !showSource ? (
				<Scroller className="flex-1" contentClassName="px-3">
					<div className="py-3">
						<Markdown text={text} />
					</div>
				</Scroller>
			) : (
				<CodeEditor
					path={path}
					text={text}
					readOnly={readOnly}
					wrap={wrap}
					onChange={(next) => onDraft(next === contents.text ? undefined : next)}
					onSave={() => void save()}
				/>
			)}
		</div>
	);
}

function Toggle({
	active,
	onClick,
	icon,
	label,
}: {
	active?: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-selected={active ? "true" : undefined}
			className="ly-item flex h-[22px] shrink-0 items-center gap-1 rounded-md px-1.5 text-detail"
		>
			{icon}
			{label}
		</button>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
