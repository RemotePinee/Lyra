/**
 * Screenshot settings page (macOS only).
 *
 * Allows customizing screen capture shortcut, default save directory,
 * clipboard copy preference, and whether to open the annotator immediately.
 */

import { Camera, FolderOpen } from "lucide-react";
import { useApp } from "../../store.ts";
import {
	Card,
	GhostButton,
	Row,
	SectionTitle,
	TextInput,
	Toggle,
} from "./controls.tsx";

export function ScreenshotSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);

	if (!settings) return null;

	const config = settings.screenshot ?? {
		shortcut: "Alt+A",
		saveLocation: "",
		copyToClipboard: true,
		insertIntoComposer: true,
		openEditor: true,
	};

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

			<SectionTitle>快捷键与触发</SectionTitle>
			<Card className="mb-9">
				<Row
					title="截图全局快捷键"
					detail="在任意界面按下该快捷键即可触发系统交互式区域截图"
					control={
						<div className="w-[200px]">
							<TextInput
								value={config.shortcut ?? "Alt+A"}
								onChange={(val) => patch({ shortcut: val })}
								placeholder="如 Alt+A 或 Option+A"
								mono
							/>
						</div>
					}
				/>
				<Row
					title="测试截图"
					detail="立即触发一次屏幕区域截图"
					control={
						<GhostButton icon={<Camera size={14} />} onClick={() => void window.lyra.screenshot.capture()}>
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
					title="截图后打开图片编辑/标注"
					detail="截取屏幕后立即打开图片标注工具，支持箭头、矩形、文字和画笔"
					control={
						<Toggle
							checked={config.openEditor !== false}
							onChange={(openEditor) => patch({ openEditor })}
						/>
					}
				/>
				<Row
					title="自动插入到对话框"
					detail="截图完成后将截图作为图片附件添加到当前的对话输入框"
					control={
						<Toggle
							checked={config.insertIntoComposer !== false}
							onChange={(insertIntoComposer) => patch({ insertIntoComposer })}
						/>
					}
				/>
				<Row
					title="复制到剪贴板"
					detail="截图完成后自动将图片写入系统剪贴板，方便随时 ⌘V 粘贴到其他应用"
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
