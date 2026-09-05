import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, View, Pressable } from "react-native";
import { haptic } from "../src/haptics";
import type { RemoteSettings } from "../src/protocol";

interface SettingsAgentSectionProps {
	settings: RemoteSettings | null;
	updateRemoteSettings: (patch: Partial<RemoteSettings>) => Promise<boolean>;
}

export function SettingsAgentSection({ settings, updateRemoteSettings }: SettingsAgentSectionProps) {
	const [instructions, setInstructions] = useState(settings?.personalization?.customInstructions ?? "");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		if (settings?.personalization?.customInstructions !== undefined) {
			setInstructions(settings.personalization.customInstructions);
		}
	}, [settings?.personalization?.customInstructions]);

	const currentMode = settings?.permissionMode ?? "auto";
	const currentThinking = settings?.thinking ?? "medium";
	const currentCommitLang = settings?.commitLanguage ?? "zh";

	async function saveInstructions() {
		haptic.tap();
		setSaving(true);
		const ok = await updateRemoteSettings({
			personalization: {
				...settings?.personalization,
				customInstructions: instructions.trim(),
			},
		});
		setSaving(false);
		if (ok) {
			haptic.success();
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		}
	}

	return (
		<>
			{/* 1. Execution Defaults */}
			<View className="mb-5 rounded-2xl bg-card p-4">
				<Text className="mb-3 text-[14px] font-semibold text-ink">Agent 默认执行偏好</Text>

				{/* Permission Mode */}
				<Text className="mb-2 text-[12px] font-medium text-ink-muted">权限审批模式</Text>
				<View className="mb-4 flex-row items-center gap-2">
					{[
						{ id: "auto", label: "自动执行" },
						{ id: "ask", label: "严格审批" },
						{ id: "full", label: "完全信任" },
					].map((item) => {
						const active = currentMode === item.id;
						return (
							<Pressable
								key={item.id}
								onPress={() => {
									haptic.tap();
									void updateRemoteSettings({ permissionMode: item.id });
								}}
								className={`flex-1 items-center justify-center rounded-xl py-2.5 px-1 ${
									active ? "bg-accent" : "bg-elevated active:opacity-80"
								}`}
							>
								<Text className={`text-[12.5px] font-semibold ${active ? "text-white" : "text-ink"}`}>
									{item.label}
								</Text>
							</Pressable>
						);
					})}
				</View>

				{/* Thinking Budget */}
				<Text className="mb-2 text-[12px] font-medium text-ink-muted">默认推理强度 (Thinking Budget)</Text>
				<View className="mb-4 flex-row items-center gap-1.5">
					{[
						{ id: "off", label: "关闭" },
						{ id: "low", label: "低" },
						{ id: "medium", label: "中" },
						{ id: "high", label: "高" },
						{ id: "max", label: "最大" },
					].map((item) => {
						const active = currentThinking === item.id;
						return (
							<Pressable
								key={item.id}
								onPress={() => {
									haptic.tap();
									void updateRemoteSettings({ thinking: item.id });
								}}
								className={`flex-1 items-center justify-center rounded-lg py-2 ${
									active ? "bg-accent" : "bg-elevated active:opacity-80"
								}`}
							>
								<Text className={`text-[12px] font-medium ${active ? "text-white" : "text-ink-muted"}`}>
									{item.label}
								</Text>
							</Pressable>
						);
					})}
				</View>

				{/* Commit Language */}
				<Text className="mb-2 text-[12px] font-medium text-ink-muted">Git 提交生成语言</Text>
				<View className="flex-row items-center gap-2">
					{[
						{ id: "zh", label: "中文 (Chinese)" },
						{ id: "en", label: "英文 (English)" },
					].map((item) => {
						const active = currentCommitLang.toLowerCase().startsWith(item.id);
						return (
							<Pressable
								key={item.id}
								onPress={() => {
									haptic.tap();
									void updateRemoteSettings({ commitLanguage: item.id });
								}}
								className={`flex-1 items-center justify-center rounded-xl py-2.5 ${
									active ? "bg-accent" : "bg-elevated active:opacity-80"
								}`}
							>
								<Text className={`text-[12.5px] font-medium ${active ? "text-white" : "text-ink-muted"}`}>
									{item.label}
								</Text>
							</Pressable>
						);
					})}
				</View>
			</View>

			{/* 2. Personalization & Instructions */}
			<View className="mb-5 rounded-2xl bg-card p-4">
				<Text className="mb-1 text-[14px] font-semibold text-ink">自定义指令</Text>
				<Text className="mb-3 text-[12px] leading-4 text-ink-faint">
					向 Agent 提供适用于此主机上所有聊天的额外说明和全局规则
				</Text>
				<TextInput
					value={instructions}
					onChangeText={setInstructions}
					placeholder="例如：请简洁回答；默认使用中文；只给出关键结论与代码。"
					placeholderTextColor="#6e6e6e"
					multiline
					textAlignVertical="top"
					className="min-h-[80px] rounded-xl bg-input p-3 text-[13.5px] leading-5 text-ink"
				/>
				<View className="mt-3 flex-row items-center justify-end gap-3">
					{saved && <Text className="text-[12px] text-ok">已同步到桌面端 ✓</Text>}
					<Pressable
						disabled={saving}
						onPress={() => void saveInstructions()}
						className="rounded-xl bg-elevated px-4 py-2 active:opacity-80"
					>
						{saving ? (
							<ActivityIndicator size="small" color="#9a9a9a" />
						) : (
							<Text className="text-[12.5px] font-medium text-ink">保存指令</Text>
						)}
					</Pressable>
				</View>
			</View>
		</>
	);
}
