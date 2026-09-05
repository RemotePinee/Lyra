import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { RemoteModel } from "./protocol";
import { useThemeColors } from "./theme";

interface Props {
	visible: boolean;
	models: RemoteModel[];
	currentModelId: string | null;
	onSelectModel: (modelId: string) => void;
	onClose: () => void;
}

export function MobileModelPickerModal({
	visible,
	models,
	currentModelId,
	onSelectModel,
	onClose,
}: Props) {
	const { colors } = useThemeColors();

	if (!visible) return null;

	return (
		<View
			style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}
			pointerEvents="box-none"
		>
			{/* Backdrop */}
			<Pressable
				style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.45)" }]}
				onPress={onClose}
			/>

			{/* Sheet */}
			<View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
				<View
					style={{
						backgroundColor: colors.shell,
						maxHeight: "75%",
						borderTopLeftRadius: 24,
						borderTopRightRadius: 24,
						paddingHorizontal: 16,
						paddingBottom: 32,
						paddingTop: 10,
					}}
				>
					{/* Handle indicator */}
					<View className="items-center pb-3">
						<View className="h-1.5 w-10 rounded-full bg-white/20" />
					</View>

					{/* Title Header */}
					<View className="flex-row items-center justify-between pb-3 pt-1">
						<View>
							<Text className="text-[17px] font-semibold text-ink">选择模型</Text>
							<Text className="mt-0.5 text-[11.5px] text-ink-faint">
								可随时在对话中切换模型（之前的推理上下文将保留为纯文本）
							</Text>
						</View>
						<Pressable
							onPress={onClose}
							className="rounded-full bg-card px-3 py-1 active:bg-card-hover"
						>
							<Text className="text-[12.5px] font-medium text-ink">关闭</Text>
						</Pressable>
					</View>

					{/* Model List */}
					<ScrollView className="mt-1" showsVerticalScrollIndicator={false}>
						{models.length === 0 ? (
							<View className="items-center rounded-2xl bg-card p-8">
								<Text className="text-[13px] text-ink-faint">桌面端暂无可用模型</Text>
							</View>
						) : (
							<View className="overflow-hidden rounded-2xl bg-card">
								{models.map((m) => {
									const isCurrent = m.id === currentModelId;
									return (
										<Pressable
											key={m.id}
											onPress={() => {
												onSelectModel(m.id);
												onClose();
											}}
											className="flex-row items-center justify-between border-b border-line-soft/30 p-3.5 last:border-b-0 active:bg-card-hover"
										>
											<View className="flex-1 pr-3">
												<View className="flex-row items-center gap-2">
													<Text
														className={`text-[14px] ${
															isCurrent ? "font-bold text-accent" : "font-medium text-ink"
														}`}
													>
														{m.name}
													</Text>
													{isCurrent && (
														<View className="rounded bg-accent/15 px-1.5 py-0.5">
															<Text className="text-[10px] font-semibold text-accent">当前</Text>
														</View>
													)}
												</View>
												<Text className="mt-0.5 text-[11px] text-ink-faint">
													{m.provider} · {m.id}
												</Text>
											</View>
											{isCurrent ? (
												<Text className="text-[16px] text-accent font-bold">✓</Text>
											) : null}
										</Pressable>
									);
								})}
							</View>
						)}
					</ScrollView>
				</View>
			</View>
		</View>
	);
}
