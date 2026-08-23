/**
 * 关于: which version this is, and the way back to an update that was waved off.
 *
 * This exists because the sidebar dot was the only door into the update dialog, and 以后再说 —
 * the button whose whole job is to make the dot go away — therefore also removed the only way to
 * change your mind. Nothing anywhere else in the app named the version, so the answer to "what am
 * I running, and what happened to that update?" was to quit and reopen and hope the dot returned.
 *
 * A download in flight is shown here as well, and it is genuinely the same download: the phase
 * comes from the main process through the same store the badge reads, so 检查更新 pressed here
 * cannot disagree with the ring in the corner. Two surfaces, one fact — the arrangement the whole
 * feature was rewritten for.
 */

import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { check, useUpdate } from "../../update/store.ts";
import { versionNote } from "../../update/view.ts";
import { UpdateDialog } from "../modals/UpdateDialog.tsx";
import { Card, GhostButton, PrimaryButton, Row, SectionTitle } from "./controls.tsx";

export function UpdateSection() {
	const { info, phase, checking } = useUpdate();
	const [open, setOpen] = useState(false);

	/*
	 * `available` is the only thing that decides whether there is anything to offer.
	 *
	 * Not `phase`: a download that failed, or one that was cancelled, leaves a phase that is not
	 * `idle` for an update that is still perfectly available — and a section that hid its button on
	 * that basis would be a dead end reached by pressing 重试 and losing.
	 */
	const available = Boolean(info?.available);

	return (
		<>
			<SectionTitle>关于</SectionTitle>
			<Card>
				{/* Three statements in one sentence — up to date, an update waiting, or a check that
				    never reached GitHub. The rules, and their tests, are in `update/view.ts`. */}
				<Row
					title="版本"
					detail={versionNote(info, phase)}
					control={
						<div className="flex items-center gap-2">
							<GhostButton
								onClick={() => void check(true)}
								disabled={checking}
								icon={<RefreshCw size={13} strokeWidth={2} className={checking ? "ly-spin" : ""} />}
							>
								{checking ? "检查中" : "检查更新"}
							</GhostButton>
							{/*
							 * Only when there is one. An update dialog for a version you already have would
							 * open onto a release note about the app you are reading it in.
							 */}
							{available && <PrimaryButton onClick={() => setOpen(true)}>查看更新</PrimaryButton>}
						</div>
					}
				/>
			</Card>

			{/*
			 * No `onDismiss`. 以后再说 hides the sidebar badge, which is not what the second button
			 * should do in a window someone opened on purpose to find this — so here it is 关闭.
			 */}
			{open && info && <UpdateDialog info={info} phase={phase} onClose={() => setOpen(false)} />}
		</>
	);
}
