import type { PermissionMode } from "@deepwise/core";
import { useEffect, useState } from "react";
import { useApp } from "../../store.ts";
import { Card, InlineSelect, Row, SectionTitle, Segmented, Toggle } from "./controls.tsx";

const EDITORS = ["Zed", "Cursor", "Visual Studio Code", "Finder", "Terminal", "Ghostty", "Xcode"];

export function GeneralSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const [platform, setPlatform] = useState("darwin");

	useEffect(() => {
		void window.deepwise.system.platform().then(setPlatform);
	}, []);

	if (!settings) return null;

	const mode = settings.permissionMode;
	const patch = (next: Partial<typeof settings>) => void saveSettings({ ...settings, ...next });
	const setMode = (permissionMode: PermissionMode) => patch({ permissionMode });

	return (
		<div className="pt-8">
			<h1 className="pb-7 text-[26px] leading-tight font-semibold tracking-tight text-ink">常规</h1>

			<SectionTitle>权限</SectionTitle>
			<Card className="mb-9">
				<Row
					title="默认权限"
					detail="DeepWise 始终可以读取和编辑当前工作区内的文件。需要时它会请求额外的访问权限。"
					control={<Toggle checked onChange={() => undefined} />}
				/>
				<Row
					title="自动审核"
					detail="只读命令（git status、ls、grep 等）自动放行，写入和未知命令仍会请求批准。"
					control={<Toggle checked={mode !== "ask"} onChange={(on) => setMode(on ? "auto" : "ask")} />}
				/>
				<Row
					title="完整访问权限"
					detail="开启后 DeepWise 无需批准即可修改文件、执行命令并访问网络。这会显著提高数据丢失或意外行为的风险。"
					control={<Toggle checked={mode === "full"} onChange={(on) => setMode(on ? "full" : "auto")} />}
				/>
			</Card>

			<SectionTitle>常规</SectionTitle>
			<Card>
				<Row
					title="默认文件打开目标"
					detail="点击文件路径时用哪个应用打开"
					control={
						<InlineSelect
							value={settings.editor.defaultOpenTarget}
							onChange={(defaultOpenTarget) => patch({ editor: { ...settings.editor, defaultOpenTarget } })}
							options={EDITORS.map((name) => ({ value: name, label: name }))}
						/>
					}
				/>
				<Row
					title="语言"
					detail="界面语言"
					control={
						<InlineSelect
							value={settings.language}
							onChange={(language) => patch({ language })}
							options={[
								{ value: "auto", label: "自动检测" },
								{ value: "zh-CN", label: "简体中文" },
								{ value: "en-US", label: "English" },
							]}
						/>
					}
				/>
				<Row
					title="主题"
					detail="应用配色"
					control={
						<Segmented
							value={settings.theme}
							onChange={(theme) => patch({ theme })}
							options={[
								{ value: "dark", label: "深色" },
								{ value: "light", label: "浅色" },
								{ value: "system", label: "跟随系统" },
							]}
						/>
					}
				/>
				<Row
					title="默认推理强度"
					detail="新会话使用的思考预算，可在输入框右侧随时切换"
					control={
						<Segmented
							value={settings.thinking}
							onChange={(thinking) => patch({ thinking })}
							options={[
								{ value: "off", label: "关" },
								{ value: "low", label: "低" },
								{ value: "medium", label: "中" },
								{ value: "high", label: "高" },
							]}
						/>
					}
				/>
				<Row
					title="底部面板"
					detail="在会话底部显示用量与状态信息"
					control={
						<Toggle
							checked={settings.editor.showBottomPanel}
							onChange={(showBottomPanel) => patch({ editor: { ...settings.editor, showBottomPanel } })}
						/>
					}
				/>
				<Row title="平台" detail="当前运行环境" control={<span className="text-[12.5px] text-ink-faint">{platform}</span>} />
			</Card>
		</div>
	);
}
