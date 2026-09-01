/**
 * Screenshot settings page.
 *
 * Allows customizing screen capture shortcut, default save directory,
 * clipboard copy preference, and whether to open the annotator immediately.
 */

import { Camera, FolderOpen, AlertCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { useApp } from "../../store.ts";
import {
	Card,
	GhostButton,
	Row,
	SectionTitle,
	ShortcutRecorder,
	Toggle,
} from "./controls.tsx";

export function ScreenshotSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const [shortcutError, setShortcutError] = useState<string | null>(null);

	const config = settings?.screenshot ?? {
		shortcut: "Alt+A",
		saveLocation: "",
		showInComposer: false,
		copyToClipboard: true,
		insertIntoComposer: false,
	};

	// Check if the current configured shortcut has conflict in the OS
	useEffect(() => {
		let active = true;
		if (config.shortcut && window.lyra?.screenshot?.validateShortcut) {
			void window.lyra.screenshot.validateShortcut(config.shortcut).then((res) => {
				if (active) {
					if (!res.ok) {
						setShortcutError(res.error || "快捷键冲突或已被占用");
					} else {
						setShortcutError(null);
					}
				}
			});
		} else {
			setShortcutError(null);
		}
		return () => {
			active = false;
		};
	}, [config.shortcut]);

	if (!settings) return null;

	const patch = (patchObj: Partial<typeof config>) => {
		void saveSettings({
			...settings,
			screenshot: {
				...config,
				...patchObj,
			},
		});
	};

	const pickDirectory = async () => {
		const dir = await window.lyra.screenshot.pickDirectory();
		if (dir) {
			patch({ saveLocation: dir });
		}
	};

	return (
		<div className="pt-8">
			<h1 className="pb-7 text-display leading-tight font-semibold tracking-tight text-ink">
				截图设置
			</h1>

			<SectionTitle>快捷键与入口</SectionTitle>
			<Card className="mb-9">
				<Row
					title="截图全局快捷键"
					detail={
						<div className="flex flex-col gap-1.5">
							<span>在任意界面按下该快捷键即可触发系统交互式区域截图（点击后直接按键盘设置）</span>
							{shortcutError && (
								<div className="flex items-center gap-1.5 text-xs text-danger">
									<AlertCircle size={13} className="shrink-0" />
									<span>{shortcutError}，请更换其他快捷键组合（如 Ctrl+Shift+S / Alt+Shift+A）</span>
								</div>
							)}
						</div>
					}
					control={
						<div className="flex items-center gap-2">
							<ShortcutRecorder
								value={config.shortcut ?? "Alt+A"}
								onChange={(val) => {
									setShortcutError(null);
									patch({ shortcut: val });
								}}
								onError={(err) => setShortcutError(err)}
							/>
							{config.shortcut && (
								<GhostButton onClick={() => {
									setShortcutError(null);
									patch({ shortcut: "" });
								}}>
									清除
								</GhostButton>
							)}
						</div>
					}
				/>
				<Row
					title="在对话输入框中显示截图按钮"
					detail="开启后，输入框左侧附件加号旁将常驻截图相机图标"
					control={
						<Toggle
							checked={config.showInComposer === true}
							onChange={(showInComposer) => patch({ showInComposer })}
						/>
					}
				/>
				<Row
					title="测试截图"
					detail="立即触发一次屏幕区域截图"
					control={
						<GhostButton icon={<Camera size={14} />} onClick={() => void window.lyra.screenshot.start()}>
							立即截屏
						</GhostButton>
					}
				/>
			</Card>

			<SectionTitle>保存与动作</SectionTitle>
			<Card className="mb-9">
				<Row
					title="截图保存位置"
					detail={
						config.saveLocation?.trim()
							? `已保存至: ${config.saveLocation}`
							: "未指定目录（仅保留在内存与剪贴板中，不占用磁盘文件）"
					}
					control={
						<div className="flex items-center gap-2">
							{config.saveLocation?.trim() && (
								<GhostButton onClick={() => patch({ saveLocation: "" })}>
									清除
								</GhostButton>
							)}
							<GhostButton icon={<FolderOpen size={14} />} onClick={() => void pickDirectory()}>
								{config.saveLocation?.trim() ? "更改目录" : "选择保存目录"}
							</GhostButton>
						</div>
					}
				/>
				<Row
					title="自动插入到对话框"
					detail="截图完成后将截图作为图片附件添加到当前的对话输入框（默认关闭）"
					control={
						<Toggle
							checked={config.insertIntoComposer === true}
							onChange={(insertIntoComposer) => patch({ insertIntoComposer })}
						/>
					}
				/>
				<Row
					title="完成编辑后复制到剪贴板"
					detail="点击完成/保存标注时将图片写入系统剪贴板，方便随时 ⌘V 粘贴到其他应用"
					control={
						<Toggle
							checked={config.copyToClipboard !== false}
							onChange={(copyToClipboard) => patch({ copyToClipboard })}
						/>
					}
				/>
			</Card>
		</div>
	);
}
