/**
 * The open file, as a pane of its own.
 *
 * It used to be the right-hand half of the file browser, which meant it could only ever be beside
 * the tree, at whatever width was left over, and it disappeared the moment you put the tree away.
 * As a pane it goes wherever the file does: under the tree, across the window, full screen while
 * you read something long, or in the corner while the conversation has the room.
 *
 * All it does is choose between four states. What a file *looks like* is `FileViewer`'s problem,
 * and what is open is the store's.
 */

import { FileText } from "lucide-react";
import { FileViewer } from "./FileViewer.tsx";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { useOpenFile } from "../store/openFile.ts";

export function FilePanel() {
	const path = useOpenFile((s) => s.path);
	const name = useOpenFile((s) => s.name);
	const contents = useOpenFile((s) => s.contents);
	const loading = useOpenFile((s) => s.loading);
	const draft = useOpenFile((s) => (s.path ? s.drafts[s.path] : undefined));

	if (!path) {
		return (
			<PanelEmpty icon={FileText} title="文件内容">
				在文件面板里选一个文件，这里显示它的内容。
			</PanelEmpty>
		);
	}

	if (loading) return <p className="ly-pulse p-6 text-center text-detail text-ink-faint">读取中…</p>;
	if (!contents) return <p className="p-6 text-center text-detail text-ink-faint">读不到这个文件</p>;

	return (
		<FileViewer
			// Keyed on the path so a different file gets a fresh editor rather than inheriting the
			// previous one's undo history and scroll position.
			key={path}
			path={path}
			name={name ?? path}
			contents={contents}
			draft={draft}
			onDraft={(text) => useOpenFile.getState().setDraft(path, text)}
			onSaved={() => void useOpenFile.getState().reread(path)}
		/>
	);
}
