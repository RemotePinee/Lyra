import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { haptic } from "./haptics";

interface PermissionOption {
	id: string;
	label: string;
	desc: string;
	danger?: boolean;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
	{ id: "ask", label: "请求批准", desc: "编辑文件和网络请求时始终询问确认" },
	{ id: "auto", label: "帮我批准", desc: "仅对检测到的高风险系统操作请求批准" },
	{ id: "full", label: "完全访问", desc: "跳过所有人工确认，直接执行操作", danger: true },
];

interface MobilePermissionPickerModalProps {
	visible: boolean;
	currentMode: string;
	onSelectMode: (mode: string) => void;
	onClose: () => void;
}

export function MobilePermissionPickerModal({
	visible,
	currentMode,
	onSelectMode,
	onClose,
}: MobilePermissionPickerModalProps) {
	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={onClose}
		>
			<View style={styles.backdrop}>
				<Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
				<View className="w-[88%] max-w-[360px] overflow-hidden rounded-2xl border border-line bg-card p-4 shadow-xl">
					<View className="mb-3 flex-row items-center justify-between border-b border-line pb-2.5">
						<View>
							<Text className="text-[16px] font-semibold text-ink">权限模式</Text>
							<Text className="mt-0.5 text-[11.5px] text-ink-muted">控制 Agent 工具调用与执行权限</Text>
						</View>
						<Pressable
							onPress={onClose}
							hitSlop={8}
							className="h-7 w-7 items-center justify-center rounded-full bg-elevated active:opacity-70"
						>
							<Text className="text-[12px] font-bold text-ink-muted">✕</Text>
						</Pressable>
					</View>

					<View className="gap-1.5">
						{PERMISSION_OPTIONS.map((opt) => {
							const isSelected = (currentMode || "auto") === opt.id;
							return (
								<Pressable
									key={opt.id}
									onPress={() => {
										haptic.tap();
										onSelectMode(opt.id);
										onClose();
									}}
									className={`flex-row items-center justify-between rounded-xl px-3.5 py-2.5 active:bg-card-hover ${
										isSelected
											? opt.danger
												? "bg-danger/10 border border-danger/30"
												: "bg-accent/10 border border-accent/30"
											: "border border-transparent"
									}`}
								>
									<View className="flex-1 pr-2">
										<View className="flex-row items-center gap-2">
											<Text
												className={`text-[14px] font-medium ${
													isSelected ? (opt.danger ? "text-danger" : "text-accent") : "text-ink"
												}`}
											>
												{opt.label}
											</Text>
											{isSelected && (
												<View
													className={`rounded px-1.5 py-0.2 ${
														opt.danger ? "bg-danger/20" : "bg-accent/20"
													}`}
												>
													<Text
														className={`text-[10px] font-bold ${
															opt.danger ? "text-danger" : "text-accent"
														}`}
													>
														当前
													</Text>
												</View>
											)}
										</View>
										<Text className="mt-0.5 text-[11.5px] text-ink-faint leading-4">
											{opt.desc}
										</Text>
									</View>
									{isSelected && (
										<Text
											className={`text-[15px] font-bold ${
												opt.danger ? "text-danger" : "text-accent"
											}`}
										>
											✓
										</Text>
									)}
								</Pressable>
							);
						})}
					</View>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	backdrop: {
		flex: 1,
		backgroundColor: "rgba(0, 0, 0, 0.4)",
		justifyContent: "center",
		alignItems: "center",
	},
});
