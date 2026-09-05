import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { RemoteModel } from "./protocol";
import { resolveModelThinkingOptions, type ThinkingOption } from "./thinkingOptions";
import { haptic } from "./haptics";

interface MobileThinkingPickerModalProps {
	visible: boolean;
	model?: RemoteModel | null;
	currentThinking: string;
	onSelectThinking: (thinking: string) => void;
	onClose: () => void;
}

export function MobileThinkingPickerModal({
	visible,
	model,
	currentThinking,
	onSelectThinking,
	onClose,
}: MobileThinkingPickerModalProps) {
	const options = resolveModelThinkingOptions(model ? { id: model.id, modelId: model.id } : null);
	const supported = options.length > 0;

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
							<Text className="text-[16px] font-semibold text-ink">推理强度</Text>
							<Text className="mt-0.5 text-[11.5px] text-ink-muted">
								{supported ? `${model?.name ?? "模型"} 的思考预算档位` : "该模型不支持深度思考"}
							</Text>
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
						{supported ? (
							options.map((opt: ThinkingOption) => {
								const isSelected =
									currentThinking === opt.id || (!currentThinking && opt.isDefault);
								return (
									<Pressable
										key={opt.id}
										onPress={() => {
											haptic.tap();
											onSelectThinking(opt.id);
											onClose();
										}}
										className={`flex-row items-center justify-between rounded-xl px-3.5 py-2.5 active:bg-card-hover ${
											isSelected ? "bg-accent/10 border border-accent/30" : "border border-transparent"
										}`}
									>
										<View className="flex-1 pr-2">
											<View className="flex-row items-center gap-2">
												<Text className={`text-[14px] font-medium ${isSelected ? "text-accent" : "text-ink"}`}>
													{opt.label}
												</Text>
												{opt.isDefault && (
													<View className="rounded bg-elevated px-1.5 py-0.2">
														<Text className="text-[9.5px] text-ink-faint">默认</Text>
													</View>
												)}
												{isSelected && (
													<View className="rounded bg-accent/20 px-1.5 py-0.2">
														<Text className="text-[10px] font-bold text-accent">当前</Text>
													</View>
												)}
											</View>
											{Boolean(opt.detail) && (
												<Text className="mt-0.5 text-[11.5px] text-ink-faint leading-4">
													{opt.detail}
												</Text>
											)}
										</View>
										{isSelected && (
											<Text className="text-[15px] font-bold text-accent">✓</Text>
										)}
									</Pressable>
								);
							})
						) : (
							<View className="py-4 items-center">
								<Text className="text-[13px] text-ink-faint">当前模型不支持配置推理档位</Text>
							</View>
						)}
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
