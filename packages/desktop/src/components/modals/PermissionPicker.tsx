import type { PermissionMode } from "@deepwise/core";
import { Check, CircleAlert, Hand, SquareTerminal } from "lucide-react";
import { MenuBody, MenuItem, MenuLabel, Popover, type Anchor } from "../Popover.tsx";
import { useApp } from "../../store.ts";

const MODES: { value: PermissionMode; icon: typeof Hand; title: string; detail: string; accent?: boolean }[] = [
	{
		value: "ask",
		icon: Hand,
		title: "请求批准",
		detail: "编辑文件和访问网络时始终询问",
	},
	{
		value: "auto",
		icon: SquareTerminal,
		title: "帮我批准",
		detail: "仅对检测到的风险操作请求批准",
	},
	{
		value: "full",
		icon: CircleAlert,
		title: "完全访问权限",
		detail: "可不受限制地访问网络和你电脑上的任何文件",
		accent: true,
	},
];

/**
 * Permission mode, anchored to the chip that shows it.
 *
 * It was a centred dialog, which read as a decision about the whole app rather than a setting
 * attached to the control right there in the composer — the same reason the model and effort
 * menus hang off their own chips.
 */
export function PermissionPicker({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const current = settings?.permissionMode ?? "auto";

	return (
		<Popover anchor={anchor} onClose={onClose} placement="top" align="start" width={276}>
			<MenuBody>
				<MenuLabel>应如何批准 DeepWise 操作？</MenuLabel>
				{MODES.map((mode) => (
					<MenuItem
						key={mode.value}
						icon={<mode.icon size={13} strokeWidth={1.8} className={mode.accent ? "text-accent" : undefined} />}
						detail={mode.detail}
						selected={current === mode.value}
						trailing={
							current === mode.value ? (
								<Check
									size={13}
									strokeWidth={2.2}
									className={`mt-[3px] shrink-0 ${mode.accent ? "text-accent" : ""}`}
								/>
							) : undefined
						}
						onClick={() => {
							if (settings) void saveSettings({ ...settings, permissionMode: mode.value });
							onClose();
						}}
					>
						{/* Full access keeps its colour even though every other row is plain ink: it is
						    the one setting that must never be quietly on. */}
						<span className={mode.accent ? "text-accent" : undefined}>{mode.title}</span>
					</MenuItem>
				))}
			</MenuBody>
		</Popover>
	);
}
