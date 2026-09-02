import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	FlatList,
	Image,
	Keyboard,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import Animated, {
	useAnimatedKeyboard,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { detectCodeOrError, parseUserMessageContent } from "../../src/codeDetection";
import { MobileCollapsibleCodeCard } from "../../src/CollapsibleCard";
import { groupMessages, type MobileRun } from "../../src/grouping";
import { describeRun, formatElapsed, formatTokens, moodFor, phraseFor, type Mood } from "../../src/runSummary";
import type { AssistantMessage, ImageContent, Message } from "../../src/protocol";
import { assistantText, useMobile, type ToolRun } from "../../src/store";

interface SelectedImage {
	uri: string;
	data: string;
	mimeType: string;
}

interface AttachedCard {
	id: string;
	title: string;
	content: string;
	language?: string;
}

export default function SessionScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const keyboard = useAnimatedKeyboard();

	const activeSession = useMobile((s) => s.activeSession);
	const sessions = useMobile((s) => s.sessions);
	const messages = useMobile((s) => s.messages);
	const toolRuns = useMobile((s) => s.toolRuns);
	const approvals = useMobile((s) => s.approvals);
	const running = useMobile((s) => s.running);
	const error = useMobile((s) => s.error);
	const openSession = useMobile((s) => s.openSession);
	const closeSession = useMobile((s) => s.closeSession);
	const send = useMobile((s) => s.send);
	const abort = useMobile((s) => s.abort);
	const approve = useMobile((s) => s.approve);

	const [draft, setDraft] = useState("");
	const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
	const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([]);
	const [attachedCards, setAttachedCards] = useState<AttachedCard[]>([]);
	const [viewingImageUri, setViewingImageUri] = useState<string | null>(null);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [windowSize, setWindowSize] = useState(60);
	const setModel = useMobile((s) => s.setModel);
	const models = useMobile((s) => s.settings?.models ?? []);
	const listRef = useRef<FlatList>(null);

	const loadingSessionId = useMobile((s) => s.loadingSessionId);
	const loadingEarlier = useMobile((s) => s.loadingEarlier);
	const hasEarlierMessages = useMobile((s) => s.hasEarlierMessages);
	const loadEarlierMessages = useMobile((s) => s.loadEarlierMessages);
	const isAtBottomRef = useRef(true);
	const textInputRef = useRef<TextInput>(null);

	// Floating scroll-to-bottom button opacity (driven purely by Reanimated UI thread, 0 React re-renders)
	const scrollFabOpacity = useSharedValue(0);

	const fabAnimatedStyle = useAnimatedStyle(() => ({
		opacity: scrollFabOpacity.value,
		transform: [{ scale: scrollFabOpacity.value }],
	}));

	// Reset state when switching session
	useEffect(() => {
		setWindowSize(60);
		isAtBottomRef.current = true;
		scrollFabOpacity.value = 0;
	}, [id, scrollFabOpacity]);

	// When user sends a message, snap to bottom
	const handleSend = useCallback(() => {
		const text = draft.trim();
		if (!text && selectedImages.length === 0 && attachedCards.length === 0) return;

		// Assemble prompt with attachments
		let fullText = text;
		if (attachedCards.length > 0) {
			const attachmentsPayload = attachedCards
				.map((card) => `### 附件文件: ${card.title}\n\`\`\`${card.language || ""}\n${card.content}\n\`\`\``)
				.join("\n\n");
			fullText = fullText ? `${fullText}\n\n${attachmentsPayload}` : attachmentsPayload;
		}

		const imagesToSend = [...selectedImages];
		setDraft("");
		setInputHeight(undefined);
		setSelectedImages([]);
		setAttachedCards([]);
		textInputRef.current?.clear();
		textInputRef.current?.setNativeProps?.({ text: "" });
		textInputRef.current?.blur();
		Keyboard.dismiss();
		isAtBottomRef.current = true;
		listRef.current?.scrollToOffset({ offset: 0, animated: false });
		void send(fullText, imagesToSend);
	}, [draft, selectedImages, attachedCards, send]);

	const isPastingRef = useRef(false);

	const handleDraftChange = useCallback((newText: string) => {
		// Prevent double-triggering if paste already handled
		if (isPastingRef.current) return;

		// Detect if user pasted a large code/error block directly into the text input
		if (newText.length > 200 || newText.split("\n").length >= 4) {
			const detection = detectCodeOrError(newText);
			if (detection.isMatch) {
				isPastingRef.current = true;
				setAttachedCards((prev) => {
					// Deduplicate: don't add the same content twice
					if (prev.some((c) => c.content.trim() === newText.trim())) return prev;
					return [
						...prev,
						{
							id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
							title: detection.suggestedName,
							content: newText,
						},
					];
				});
				setDraft("");
				setInputHeight(44);
				textInputRef.current?.clear();
				textInputRef.current?.setNativeProps?.({ text: "" });
				setTimeout(() => {
					isPastingRef.current = false;
					setInputHeight(undefined);
				}, 100);
				return;
			}
		}
		setDraft(newText);
	}, []);

	const pickFromLibrary = async () => {
		try {
			const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
			if (!permission.granted) {
				Alert.alert("权限不足", "需要访问相册权限以选择图片");
				return;
			}
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				allowsMultipleSelection: true,
				selectionLimit: 4 - selectedImages.length,
				quality: 0.8,
				base64: true,
			});
			if (!result.canceled && result.assets) {
				const newImages: SelectedImage[] = result.assets
					.filter((asset) => asset.base64)
					.map((asset) => ({
						uri: asset.uri,
						data: asset.base64!,
						mimeType: asset.mimeType ?? "image/jpeg",
					}));
				setSelectedImages((prev) => [...prev, ...newImages].slice(0, 4));
			}
		} catch {
			Alert.alert("选图失败", "读取相册图片出现异常");
		}
	};

	const takePhoto = async () => {
		try {
			const permission = await ImagePicker.requestCameraPermissionsAsync();
			if (!permission.granted) {
				Alert.alert("权限不足", "需要相机权限以进行拍照");
				return;
			}
			const result = await ImagePicker.launchCameraAsync({
				quality: 0.8,
				base64: true,
			});
			if (!result.canceled && result.assets && result.assets[0]?.base64) {
				const asset = result.assets[0];
				const newImage: SelectedImage = {
					uri: asset.uri,
					data: asset.base64!,
					mimeType: asset.mimeType ?? "image/jpeg",
				};
				setSelectedImages((prev) => [...prev, newImage].slice(0, 4));
			}
		} catch {
			Alert.alert("拍照失败", "唤起相机出现异常");
		}
	};

	const handlePickImage = () => {
		if (selectedImages.length >= 4) {
			Alert.alert("数量限制", "单次最多支持发送 4 张图片");
			return;
		}
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					options: ["取消", "拍照", "从相册选取"],
					cancelButtonIndex: 0,
				},
				(buttonIndex) => {
					if (buttonIndex === 1) void takePhoto();
					if (buttonIndex === 2) void pickFromLibrary();
				},
			);
		} else {
			Alert.alert("添加图片", "请选择图片来源", [
				{ text: "拍照", onPress: () => void takePhoto() },
				{ text: "从相册选取", onPress: () => void pickFromLibrary() },
				{ text: "取消", style: "cancel" },
			]);
		}
	};

	// Deep-linking straight to a session id means the store may not have it loaded yet.
	useEffect(() => {
		if (activeSession?.id === id) return;
		const meta = sessions.find((s) => s.id === id);
		if (meta) void openSession(meta);
	}, [id, activeSession, sessions, openSession]);

	// Auto-scroll anchor logic:
	// When messages change or agent streams, if user is anchored at bottom, stay at offset 0
	useEffect(() => {
		if (isAtBottomRef.current) {
			listRef.current?.scrollToOffset({ offset: 0, animated: false });
		}
	}, [messages, toolRuns, running]);

	// Inverted list native anchor:
	// When entering a session or when content sizes finalize, if user is at bottom, snap to 0
	const onListContentSizeChange = useCallback(() => {
		if (isAtBottomRef.current) {
			listRef.current?.scrollToOffset({ offset: 0, animated: false });
		}
	}, []);

	useEffect(() => () => closeSession(), [closeSession]);

	const containerAnimatedStyle = useAnimatedStyle(() => {
		return {
			paddingBottom: keyboard.height.value,
		};
	});

	if (!activeSession) {
		return (
			<View className="flex-1 items-center justify-center bg-shell">
				<ActivityIndicator color="#9a9a9a" />
			</View>
		);
	}

	const isInitialLoading = loadingSessionId === id && messages.length === 0;
	const isBackgroundRefreshing = loadingSessionId === id && messages.length > 0;
	const approval = approvals[0];

	// Dual Protection: window slicing on client + cursor pagination on server
	const visibleMessages = messages.slice(-windowSize);
	const localHiddenCount = messages.length - visibleMessages.length;

	return (
		<Animated.View style={[{ flex: 1, backgroundColor: "#171717", paddingTop: insets.top }, containerAnimatedStyle]}>
			{/* Custom Header: Clean, borderless elevation aligned with desktop app */}
			<View className="flex-row items-center justify-between bg-sidebar px-3 py-2.5">
				<Pressable
					onPress={() => router.back()}
					hitSlop={12}
					className="h-8 w-8 items-center justify-center rounded-lg active:bg-card-hover"
				>
					<Text className="text-[17px] font-medium text-ink">←</Text>
				</Pressable>
				<Text className="flex-1 text-center text-[15px] font-semibold text-ink" numberOfLines={1}>
					{activeSession.title ?? "会话"}
				</Text>
				<View className="w-8" />
			</View>

			{isInitialLoading && (
				<View className="absolute inset-0 z-10 items-center justify-center bg-shell/90">
					<ActivityIndicator size="large" color="#ededed" />
					<Text className="mt-3 text-[13px] text-ink-muted">正在加载历史记录…</Text>
				</View>
			)}
			{isBackgroundRefreshing && (
				<View className="absolute top-12 left-0 right-0 z-10 flex-row items-center justify-center gap-2 bg-panel/80 py-1.5">
					<ActivityIndicator size="small" color="#9a9a9a" />
					<Text className="text-[11.5px] text-ink-faint">同步最新状态中…</Text>
				</View>
			)}

			<FlatList
				ref={listRef}
				data={[...groupMessages(visibleMessages)].reverse()}
				inverted
				renderItem={({ item }) => (
					<MobileTranscriptRow
						key={item.kind === "tools" ? `group-${item.id}` : rowKey(item.message)}
						run={item}
						toolRuns={toolRuns}
						onImagePress={(uri) => setViewingImageUri(uri)}
					/>
				)}
				keyExtractor={(item) =>
					item.kind === "tools" ? `group-${item.id}` : rowKey(item.message)
				}
				style={{ flex: 1 }}
				contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 16 }}
				maxToRenderPerBatch={10}
				windowSize={7}
				initialNumToRender={20}
				removeClippedSubviews={false}
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="always"
				onContentSizeChange={onListContentSizeChange}
				onScroll={(e) => {
					// In inverted mode: offset 0 is bottom (latest).
					const offset = e.nativeEvent.contentOffset.y;
					isAtBottomRef.current = offset <= 10;
					if (offset > 160) {
						scrollFabOpacity.value = withTiming(1, { duration: 150 });
					} else {
						scrollFabOpacity.value = withTiming(0, { duration: 150 });
					}
				}}
				onScrollBeginDrag={() => {
					isAtBottomRef.current = false;
				}}
				scrollEventThrottle={16}
				ListHeaderComponent={
					error ? (
						<View className="mb-2 pt-0.5">
							<View className="rounded-xl bg-danger/10 px-3.5 py-2.5">
								<Text className="text-[12.5px] font-medium text-danger">{error}</Text>
							</View>
						</View>
					) : null
				}
				ListFooterComponent={
					<View className="mb-3">
						{/* If there are local loaded messages not yet expanded into the window */}
						{localHiddenCount > 0 && (
							<Pressable
								onPress={() => setWindowSize((prev) => prev + 60)}
								className="mb-3 flex-row items-center justify-center rounded-xl bg-card py-2.5 active:bg-card-hover"
							>
								<Text className="text-[12px] font-medium text-ink-muted">
									展开更早的 {Math.min(localHiddenCount, 60)} 条（共 {localHiddenCount} 条已拉取）
								</Text>
							</Pressable>
						)}

						{/* Cursor pagination: fetch earlier records from server */}
						{hasEarlierMessages && localHiddenCount === 0 && (
							<Pressable
								onPress={() => {
									setWindowSize((prev) => prev + 60);
									void loadEarlierMessages();
								}}
								disabled={loadingEarlier}
								className="mb-3 flex-row items-center justify-center gap-2 rounded-xl bg-card py-2.5 active:bg-card-hover disabled:opacity-60"
							>
								{loadingEarlier ? (
									<>
										<ActivityIndicator size="small" color="#9a9a9a" />
										<Text className="text-[12px] font-medium text-ink-muted">正在向服务器加载更早历史…</Text>
									</>
								) : (
									<Text className="text-[12px] font-medium text-ink-muted">加载更早的 60 条记录</Text>
								)}
							</Pressable>
						)}

						<View className="flex-row items-center gap-2">
							<Text className="flex-1 text-[11.5px] text-ink-faint" numberOfLines={1}>
								{activeSession.cwd}
							</Text>
							{messages.length > 0 ? (
								<Text className="px-2 py-1 text-[11.5px] text-ink-faint">
									{models.find((m) => m.id === activeSession.modelId)?.name ?? activeSession.modelId}
								</Text>
							) : (
								<Pressable
									onPress={() => setModelPickerOpen(true)}
									className="rounded-lg bg-card px-2.5 py-1 active:bg-card-hover"
								>
									<Text className="text-[11.5px] text-ink-muted">
										{models.find((m) => m.id === activeSession.modelId)?.name ?? "选择模型"}
									</Text>
								</Pressable>
							)}
						</View>

						{modelPickerOpen && (
							<View className="mt-2 overflow-hidden rounded-xl bg-card">
								{models.map((model) => (
									<Pressable
										key={model.id}
										onPress={() => {
											void setModel(model.id);
											setModelPickerOpen(false);
										}}
										className="border-b border-line-soft/40 px-3.5 py-2.5 last:border-b-0 active:bg-card-hover"
									>
										<Text className="text-[13px] text-ink">{model.name}</Text>
										<Text className="mt-0.5 text-[11px] text-ink-faint">{model.provider}</Text>
									</Pressable>
								))}
								{models.length === 0 && (
									<Text className="px-3.5 py-4 text-center text-[12px] text-ink-faint">
										桌面端还没有可用模型
									</Text>
								)}
							</View>
						)}
					</View>
				}
			/>

			{approval && (
				<View className="bg-panel px-4 py-3.5">
					<View className="flex-row items-center gap-2">
						<View className="h-2 w-2 rounded-full bg-accent" />
						<Text className="text-[14px] font-semibold text-ink">{approval.title}</Text>
					</View>
					<ScrollView className="mt-2.5 max-h-28 rounded-xl bg-shell px-3.5 py-2.5">
						<Text className="font-mono text-[11.5px] leading-5 text-ink-muted">{approval.detail}</Text>
					</ScrollView>
					<View className="mt-3 flex-row gap-2.5">
						<Pressable
							onPress={() => void approve(approval.id, "reject")}
							className="flex-1 items-center rounded-xl bg-card py-2.5 active:bg-card-hover"
						>
							<Text className="text-[13px] font-medium text-danger">拒绝</Text>
						</Pressable>
						<Pressable
							onPress={() => void approve(approval.id, "always")}
							className="flex-1 items-center rounded-xl bg-card py-2.5 active:bg-card-hover"
						>
							<Text className="text-[13px] font-medium text-ink-muted">始终允许</Text>
						</Pressable>
						<Pressable
							onPress={() => void approve(approval.id, "once")}
							className="flex-1 items-center rounded-xl bg-ink py-2.5 active:opacity-85"
						>
							<Text className="text-[13px] font-semibold text-shell">允许</Text>
						</Pressable>
					</View>
				</View>
			)}

			{/* Attached Text/Code Cards Preview Bar */}
			{attachedCards.length > 0 && (
				<View className="bg-sidebar px-3 pt-2 pb-1.5">
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						contentContainerStyle={{ gap: 8 }}
						className="flex-row"
					>
						{attachedCards.map((card) => {
							const lines = card.content.split("\n").length;
							return (
								<View
									key={card.id}
									className="flex-row items-center gap-2 rounded-xl bg-card px-3 py-2"
								>
									<View className="h-6 w-6 items-center justify-center rounded-lg bg-accent/15">
										<Text className="text-[10px] font-bold text-accent">TXT</Text>
									</View>
									<View className="max-w-[130px]">
										<Text className="truncate text-[12px] font-medium text-ink">{card.title}</Text>
										<Text className="text-[10px] text-ink-faint">{lines} 行代码/日志</Text>
									</View>
									<Pressable
										onPress={() => setAttachedCards((prev) => prev.filter((c) => c.id !== card.id))}
										className="ml-1 h-5 w-5 items-center justify-center rounded-full bg-elevated active:opacity-60"
									>
										<Text className="text-[10px] text-ink-muted">✕</Text>
									</Pressable>
								</View>
							);
						})}
					</ScrollView>
				</View>
			)}

			{/* Selected Images Preview Bar */}
			{selectedImages.length > 0 && (
				<View className="bg-sidebar px-3 pt-2 pb-1">
					<ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row gap-2">
						{selectedImages.map((img, idx) => (
							<View key={idx} className="relative h-16 w-16 overflow-hidden rounded-xl bg-card">
								<Image source={{ uri: img.uri }} className="h-full w-full" resizeMode="cover" />
								<Pressable
									onPress={() => setSelectedImages((prev) => prev.filter((_, i) => i !== idx))}
									className="absolute top-1 right-1 h-5 w-5 items-center justify-center rounded-full bg-black/70"
								>
									<Text className="text-[10px] font-bold text-white">✕</Text>
								</Pressable>
							</View>
						))}
					</ScrollView>
				</View>
			)}

			{/* Running Indicator floating right above Input Bar */}
			{running && <MobileRunningIndicator messages={messages} toolRuns={toolRuns} />}

			{/* Input Bar (Fixed, dynamically padded by Reanimated hardware keyboard offset) */}
			<View
				className="bg-sidebar px-3 pt-2.5"
				style={{
					flexShrink: 0,
					paddingBottom: insets.bottom || 12,
				}}
			>
				<View className="flex-row items-end gap-2">
					<Pressable
						disabled={running}
						onPress={handlePickImage}
						className={`h-11 w-11 items-center justify-center rounded-full bg-card active:bg-card-hover ${
							running ? "opacity-50" : ""
						}`}
					>
						<View className="h-5 w-5 items-center justify-center">
							{/* Camera top bump */}
							<View className="h-[2px] w-[5px] rounded-t-[1px] bg-ink-muted self-start ml-0.5" />
							{/* Camera body */}
							<View className="h-[14px] w-[18px] items-center justify-center rounded-[3px] bg-ink-muted/30">
								{/* Lens */}
								<View className="h-[6px] w-[6px] rounded-full bg-ink-muted" />
							</View>
						</View>
					</Pressable>
					<TextInput
						ref={textInputRef}
						value={draft}
						editable={!running}
						onChangeText={handleDraftChange}
						placeholder={running ? "Agent 正在执行中…" : "随心输入"}
						placeholderTextColor="#6e6e6e"
						multiline
						onSubmitEditing={handleSend}
						style={inputHeight !== undefined ? { height: inputHeight } : undefined}
						className={`max-h-32 min-h-11 flex-1 rounded-2xl bg-card px-4 py-2.5 text-[14px] leading-5 text-ink ${
							running ? "opacity-60" : ""
						}`}
					/>
					{running ? (
						<Pressable
							onPress={() => void abort()}
							className="h-11 w-11 items-center justify-center rounded-full bg-ink active:opacity-85"
						>
							<View className="h-3 w-3 rounded-[2px] bg-shell" />
						</Pressable>
					) : (
						<Pressable
							disabled={!draft.trim() && selectedImages.length === 0}
							onPress={handleSend}
							className="h-11 w-11 items-center justify-center rounded-full bg-elevated active:opacity-85 disabled:opacity-40"
						>
							<Text className="text-[17px] leading-5 text-ink">↑</Text>
						</Pressable>
					)}
				</View>
			</View>

			{/* Floating Scroll to Bottom Button */}
			<Animated.View
				style={[
					{
						position: "absolute",
						right: 16,
						bottom: (insets.bottom || 12) + 76,
						zIndex: 30,
					},
					fabAnimatedStyle,
				]}
			>
				<Pressable
					onPress={() => {
						isAtBottomRef.current = true;
						scrollFabOpacity.value = withTiming(0, { duration: 150 });
						listRef.current?.scrollToOffset({ offset: 0, animated: true });
					}}
					className="h-10 w-10 items-center justify-center rounded-full bg-elevated shadow-lg active:bg-card-hover"
				>
					<Text className="text-[15px] font-bold text-ink">↓</Text>
				</Pressable>
			</Animated.View>

			{/* Fullscreen Image Preview Modal */}
			<Modal
				visible={!!viewingImageUri}
				transparent
				animationType="fade"
				onRequestClose={() => setViewingImageUri(null)}
			>
				<Pressable
					onPress={() => setViewingImageUri(null)}
					className="flex-1 items-center justify-center bg-black/90 p-4"
				>
					{viewingImageUri && (
						<Image
							source={{ uri: viewingImageUri }}
							className="h-full w-full"
							resizeMode="contain"
						/>
					)}
					<Pressable
						onPress={() => setViewingImageUri(null)}
						className="absolute top-12 right-6 h-10 w-10 items-center justify-center rounded-full bg-white/20"
					>
						<Text className="text-[16px] font-bold text-white">✕</Text>
					</Pressable>
				</Pressable>
			</Modal>
		</Animated.View>
	);
}

function rowKey(message: Message): string {
	if (message.role === "toolResult") return `tr-${message.toolCallId}`;
	if (message.role === "assistant") {
		const firstCall = message.content.find((c) => c.type === "toolCall");
		if (firstCall && firstCall.type === "toolCall") return `ast-call-${firstCall.id}`;
	}
	return `${message.role}-${message.timestamp}`;
}

function isSyntheticOrNudge(message: Message): boolean {
	if (message.role === "user") {
		if (message.synthetic) return true;
		return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
	}
	return false;
}

const MobileTranscriptRow = React.memo(function MobileTranscriptRow({
	run,
	toolRuns,
	onImagePress,
}: {
	run: MobileRun;
	toolRuns: Record<string, ToolRun>;
	onImagePress?: (uri: string) => void;
}) {
	if (run.kind === "tools") {
		return <ToolRunGroup calls={run.calls} toolRuns={toolRuns} />;
	}

	const message = run.message;
	if (message.role === "toolResult") return null;

	if (message.role === "user") {
		if (isSyntheticOrNudge(message)) return null;
		const textContents = message.content.filter((c) => c.type === "text");
		const imageContents = message.content.filter((c) => c.type === "image") as ImageContent[];
		const rawText = textContents.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const parsedParts = parseUserMessageContent(rawText);

		return (
			<View className="mb-3 items-end">
				{message.origin === "side-chat" && (
					<Text className="mr-1 mb-1 text-[11px] text-ink-faint">来自侧边聊天</Text>
				)}
				{imageContents.length > 0 && (
					<View className="mb-1.5 max-w-[85%] flex-row flex-wrap justify-end gap-1.5">
						{imageContents.map((img, idx) => {
							const uri = `data:${img.mimeType};base64,${img.data}`;
							return (
								<Pressable
									key={idx}
									onPress={() => onImagePress?.(uri)}
									className="h-32 w-32 overflow-hidden rounded-2xl bg-card active:opacity-80"
								>
									<Image source={{ uri }} className="h-full w-full" resizeMode="cover" />
								</Pressable>
							);
						})}
					</View>
				)}
				{parsedParts.map((part, idx) => {
					if (part.type === "attachment") {
						return <MobileCollapsibleCodeCard key={idx} title={part.title || "file.txt"} content={part.content} />;
					}
					return (
						<View key={idx} className="mb-1.5 max-w-[85%] rounded-2xl rounded-br-md bg-card px-3.5 py-2.5">
							<Text className="text-[14px] leading-6 text-ink">{part.content}</Text>
						</View>
					);
				})}
			</View>
		);
	}

	return <AssistantRow message={message} upTo={run.upTo} />;
});

function AssistantRow({ message, upTo }: { message: AssistantMessage; upTo: number }) {
	const text = assistantText(message, upTo);
	const thinking = message.content.find((c) => c.type === "thinking");

	return (
		<View className="mb-4">
			{thinking && thinking.type === "thinking" && thinking.thinking.length > 0 && (
				<ThinkingBlock text={thinking.thinking} />
			)}

			{text.length > 0 && <Text className="text-[14px] leading-6 text-ink">{stripMarkdown(text)}</Text>}

			{message.stopReason === "error" && message.errorMessage && (
				<View className="mt-2 rounded-xl bg-danger/10 px-3.5 py-2.5">
					<Text className="text-[12.5px] font-medium text-danger">{message.errorMessage}</Text>
				</View>
			)}

			{/* 桌面端设计原则：每条已完成消息气泡下不再显示冗余的小字 input/output token，全部收敛在状态栏和用量统计中 */}
		</View>
	);
}

function ToolRunGroup({
	calls,
	toolRuns,
}: {
	calls: { block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[];
	toolRuns: Record<string, ToolRun>;
}) {
	const [open, setOpen] = useState(false);

	const callsWithSummary = calls.map((c) => ({
		toolName: c.block.name,
		summary: toolRuns[c.block.id]?.summary ?? c.block.name,
		status: toolRuns[c.block.id]?.status ?? (c.stopReason === "pending" ? "running" : "done"),
	}));

	const isRunning = callsWithSummary.some((c) => c.status === "running");
	const hasError = callsWithSummary.some((c) => c.status === "error");
	const summaryText = describeRun(callsWithSummary);

	return (
		<View className="mb-2.5">
			<Pressable
				onPress={() => setOpen((v) => !v)}
				className="flex-row items-center justify-between rounded-xl bg-card/60 px-3.5 py-2.5 active:bg-card-hover"
			>
				<View className="mr-2 flex-1 flex-row items-center gap-2">
					<View
						className={`h-1.5 w-1.5 rounded-full ${
							hasError ? "bg-danger" : isRunning ? "bg-accent" : "bg-ok"
						}`}
					/>
					<Text className="flex-1 text-[12.5px] font-medium text-ink-muted" numberOfLines={1}>
						{summaryText || "调用工具"}
					</Text>
				</View>
				<View className="flex-row items-center gap-1.5">
					<Text className="text-[11px] text-ink-faint">{calls.length} 项</Text>
					<Text className="text-[11px] text-ink-faint">{open ? "▾" : "▸"}</Text>
				</View>
			</Pressable>

			{open && (
				<View className="mt-1.5 gap-1.5 pl-2">
					{calls.map((c) => (
						<ToolCard key={c.block.id} run={toolRuns[c.block.id]} name={c.block.name} />
					))}
				</View>
			)}
		</View>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	return (
		<View className="mb-2 overflow-hidden rounded-xl bg-card/60">
			<Pressable
				onPress={() => setOpen((v) => !v)}
				className="flex-row items-center justify-between px-3.5 py-2 active:bg-card-hover"
			>
				<View className="flex-row items-center gap-2">
					<View className="h-1.5 w-1.5 rounded-full bg-violet" />
					<Text className="text-[12px] font-medium text-ink-muted">思考过程</Text>
				</View>
				<Text className="text-[11px] text-ink-faint">{open ? "收起" : "展开"}</Text>
			</Pressable>
			{open && (
				<View className="bg-[#121212] px-3.5 py-2.5">
					<Text className="font-mono text-[12px] leading-5 text-ink-muted">{text}</Text>
				</View>
			)}
		</View>
	);
}

function ToolCard({ run, name }: { run: ToolRun | undefined; name: string }) {
	const [open, setOpen] = useState(false);
	const status = run?.status ?? "running";

	return (
		<Pressable
			onPress={() => setOpen((v) => !v)}
			className="mb-1.5 overflow-hidden rounded-xl bg-card px-3.5 py-2.5 active:bg-card-hover"
		>
			<View className="flex-row items-center gap-2">
				<Text className="flex-1 text-[12.5px] font-medium text-ink-muted" numberOfLines={1}>
					{run?.summary ?? name}
				</Text>
				<Text
					className={`text-[11.5px] font-medium ${
						status === "error" ? "text-danger" : status === "done" ? "text-ok" : "text-accent"
					}`}
				>
					{status === "running" ? "运行中" : status === "done" ? "完成" : "失败"}
				</Text>
			</View>
			{open && run?.output && (
				<Text className="mt-2 font-mono text-[11px] leading-4 text-ink-faint" numberOfLines={40}>
					{run.output}
				</Text>
			)}
		</Pressable>
	);
}

/**
 * React Native has no markdown renderer built in. Rather than ship a half-broken one, strip
 * the syntax that would otherwise show up as literal asterisks and backticks.
 */
function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, "").trimEnd())
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "• ");
}

function MobileRunningIndicator({
	messages,
	toolRuns,
}: {
	messages: Message[];
	toolRuns: Record<string, ToolRun>;
}) {
	const [elapsed, setElapsed] = useState(0);
	const [tick, setTick] = useState(0);
	const storeTurnStartedAt = useMobile((s) => s.turnStartedAt);
	const storeTurnTokens = useMobile((s) => s.turnTokens);

	useEffect(() => {
		const start = storeTurnStartedAt ?? Date.now();
		const updateElapsed = () => {
			setElapsed(Math.max(1, Math.floor((Date.now() - start) / 1000)));
		};
		updateElapsed();
		const timer = setInterval(updateElapsed, 1000);
		const phraseTimer = setInterval(() => {
			setTick((t) => t + 1);
		}, 3500);

		return () => {
			clearInterval(timer);
			clearInterval(phraseTimer);
		};
	}, [storeTurnStartedAt]);

	// Find the latest active tool or assistant writing state
	const activeRun = Object.values(toolRuns).find((r) => r.status === "running");
	const lastMsg = messages[messages.length - 1];
	const isWriting =
		lastMsg?.role === "assistant" &&
		lastMsg.stopReason === "pending" &&
		lastMsg.content.some((c) => c.type === "text" && c.text.length > 0);

	const mood: Mood = moodFor(activeRun?.toolName, activeRun?.summary, isWriting);
	const phrase = phraseFor(mood, tick);

	return (
		<View className="flex-row items-center justify-between bg-sidebar/95 px-4 py-2">
			<View className="flex-1 flex-row items-center gap-2">
				<ActivityIndicator size="small" color="#c084fc" />
				<Text className="text-[12.5px] font-medium text-ink" numberOfLines={1}>
					{phrase}…
				</Text>
			</View>
			<Text className="font-mono text-[11.5px] text-ink-faint">
				{formatElapsed(elapsed * 1000)}{storeTurnTokens > 0 ? ` · ${formatTokens(storeTurnTokens)} tokens` : ""}
			</Text>
		</View>
	);
}
