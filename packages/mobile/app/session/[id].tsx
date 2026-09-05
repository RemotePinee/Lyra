import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { haptic } from "../../src/haptics";
import {
	ActivityIndicator,
	FlatList,
	Image,
	Keyboard,
	LayoutAnimation,
	Pressable,
	ScrollView,
	StyleSheet,
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
import { MobileCodeViewer } from "../../src/MobileCodeViewer";
import { MobileCollapsibleCodeCard } from "../../src/CollapsibleCard";
import { MobileActionSheet, MobileConfirmDialog } from "../../src/MobileDialog";
import { MobileMarkdownView } from "../../src/MarkdownContent";
import { MobileModelPickerModal } from "../../src/MobileModelPickerModal";
import { MobilePermissionPickerModal } from "../../src/MobilePermissionPickerModal";
import { MobileResumeRow } from "../../src/MobileResumeRow";
import { MobileThinkingPickerModal } from "../../src/MobileThinkingPickerModal";
import { resolveModelThinkingOptions, type ThinkingOption } from "../../src/thinkingOptions";
import { MobileTaskList } from "../../src/MobileTaskList";
import { MobileThinkingBlock } from "../../src/MobileThinkingBlock";
import { groupMessages, type MobileRun } from "../../src/grouping";
import { describeRun, formatElapsed, formatTokens, moodFor, phraseFor, type Mood } from "../../src/runSummary";
import type { AssistantMessage, ImageContent, Message } from "../../src/protocol";
import { assistantText, todosFrom, useMobile, type ToolRun } from "../../src/store";
import { useThemeColors } from "../../src/theme";

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
	const { colors, isDark } = useThemeColors();
	const keyboard = useAnimatedKeyboard({
		isStatusBarTranslucentAndroid: true,
		isNavigationBarTranslucentAndroid: true,
	});

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
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameText, setRenameText] = useState("");
	const renameSession = useMobile((s) => s.renameSession);
	const setModel = useMobile((s) => s.setModel);
	const setThinking = useMobile((s) => s.setThinking);
	const setPermissionMode = useMobile((s) => s.setPermissionMode);
	const settings = useMobile((s) => s.settings);
	const models = useMobile((s) => s.settings?.models ?? []);
	const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
	const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);
	const listRef = useRef<FlatList>(null);

	const loadingSessionId = useMobile((s) => s.loadingSessionId);
	const loadingEarlier = useMobile((s) => s.loadingEarlier);
	const hasEarlierMessages = useMobile((s) => s.hasEarlierMessages);
	const loadEarlierMessages = useMobile((s) => s.loadEarlierMessages);
	const isAtBottomRef = useRef(true);
	const isDraggingRef = useRef(false);
	const textInputRef = useRef<TextInput>(null);

	// Adaptive ActionSheet & Dialog States for Session
	const [imageSheetVisible, setImageSheetVisible] = useState(false);
	const [sessionAlert, setSessionAlert] = useState<{ visible: boolean; title: string; message: string }>({
		visible: false,
		title: "",
		message: "",
	});

	const showSessionAlert = (title: string, message: string) => {
		setSessionAlert({ visible: true, title, message });
	};

	// Floating scroll-to-bottom button opacity (driven purely by Reanimated UI thread, 0 React re-renders)
	const scrollFabOpacity = useSharedValue(0);

	const fabAnimatedStyle = useAnimatedStyle(() => ({
		opacity: scrollFabOpacity.value,
		transform: [{ scale: scrollFabOpacity.value }],
	}));

	// Reset state when switching session
	useEffect(() => {
		isAtBottomRef.current = true;
		isDraggingRef.current = false;
		scrollFabOpacity.value = 0;
	}, [id, scrollFabOpacity]);

	const scrollToBottom = useCallback((animated = true) => {
		isAtBottomRef.current = true;
		isDraggingRef.current = false;
		scrollFabOpacity.value = withTiming(0, { duration: 150 });
		listRef.current?.scrollToOffset({ offset: 0, animated });
	}, [scrollFabOpacity]);

	// When user sends a message, snap to bottom (offset 0 in inverted list)
	const handleSend = useCallback(() => {
		const text = draft.trim();
		if (!text && selectedImages.length === 0 && attachedCards.length === 0) return;
		haptic.impact();

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
		scrollToBottom(false);
		setTimeout(() => scrollToBottom(false), 50);
		void send(fullText, imagesToSend);
	}, [draft, selectedImages, attachedCards, send, scrollToBottom]);

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
				showSessionAlert("权限不足", "需要访问相册权限以选择图片");
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
			showSessionAlert("选图失败", "读取相册图片出现异常");
		}
	};

	const takePhoto = async () => {
		try {
			const permission = await ImagePicker.requestCameraPermissionsAsync();
			if (!permission.granted) {
				showSessionAlert("权限不足", "需要相机权限以进行拍照");
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
			showSessionAlert("拍照失败", "唤起相机出现异常");
		}
	};

	const handlePickImage = () => {
		if (selectedImages.length >= 4) {
			showSessionAlert("数量限制", "单次最多支持发送 4 张图片");
			return;
		}
		haptic.impact();
		setImageSheetVisible(true);
	};

	// Deep-linking straight to a session id means the store may not have it loaded yet.
	useEffect(() => {
		if (activeSession?.id === id) return;
		const meta = sessions.find((s) => s.id === id);
		if (meta) void openSession(meta);
	}, [id, activeSession, sessions, openSession]);

	// Auto-scroll anchor logic:
	// Inverted FlatList: offset 0 is the bottom (latest message).
	// Only auto-scroll if the user hasn't explicitly scrolled up.
	// Debounce/guard using rAF so high-frequency streaming doesn't saturate the UI thread.
	const scrollRafRef = useRef<number | null>(null);
	useEffect(() => {
		// If user is touching/dragging the list or scrolled away from bottom, do NOT force scroll
		if (isDraggingRef.current || !isAtBottomRef.current) return;
		if (scrollRafRef.current !== null) return;

		scrollRafRef.current = requestAnimationFrame(() => {
			scrollRafRef.current = null;
			if (isAtBottomRef.current && !isDraggingRef.current) {
				listRef.current?.scrollToOffset({ offset: 0, animated: false });
			}
		});

		return () => {
			if (scrollRafRef.current !== null) {
				cancelAnimationFrame(scrollRafRef.current);
				scrollRafRef.current = null;
			}
		};
	}, [messages, toolRuns, running]);

	useEffect(() => () => closeSession(), [closeSession]);

	// Keyboard offset driven by keyboard.height
	// When modal opens or textinput blurs, ensure translateY immediately stays 0.
	const keyboardAnimatedStyle = useAnimatedStyle(() => {
		const h = keyboard.height.value;
		const isOpen = keyboard.state.value === 1 || keyboard.state.value === 2;
		const offset = isOpen && h > 10 ? h : 0;
		return {
			transform: [{ translateY: -offset }],
		};
	});

	// Keyboard avoidance for inverted FlatList:
	const listContainerAnimatedStyle = useAnimatedStyle(() => {
		const h = keyboard.height.value;
		const isOpen = keyboard.state.value === 1 || keyboard.state.value === 2;
		const offset = isOpen && h > 10 ? h : 0;
		return {
			paddingBottom: offset,
		};
	});

	// Pre-sort reversed runs synchronously so FlatList mounts already inverted without layout jump
	const reversedRuns = useMemo(() => {
		const runs = groupMessages(messages);
		return runs.reverse();
	}, [messages]);

	const currentTodos = useMemo(() => todosFrom(messages), [messages]);

	const extractKey = useCallback((item: MobileRun, index: number) => getRunKey(item, index), []);

	const handleImagePress = useCallback((uri: string) => {
		setViewingImageUri(uri);
	}, []);

	const renderTranscriptItem = useCallback(
		({ item }: { item: MobileRun }) => (
			<MobileTranscriptRow
				run={item}
				onImagePress={handleImagePress}
			/>
		),
		[handleImagePress],
	);

	const isInitialLoading = (loadingSessionId === id || !activeSession) && messages.length === 0;
	const isBackgroundRefreshing = loadingSessionId === id && messages.length > 0;
	// Determine whether prose is actively streaming at the tail of the message list.
	// When answer text starts arriving, running indicator is automatically folded.
	const answering = useMemo(() => {
		const last = messages[messages.length - 1];
		if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
		const lastBlock = last.content[last.content.length - 1];
		return lastBlock?.type === "text" && lastBlock.text.trim().length > 0;
	}, [messages]);

	const approval = approvals[0];
	const sessionTitle = activeSession?.title ?? sessions.find((s) => s.id === id)?.title ?? "会话";

	return (
		<View style={{ flex: 1, backgroundColor: colors.shell, paddingTop: insets.top }}>
			<View className="h-14 flex-row items-center bg-shell px-3.5">
				<Pressable
					onPress={() => router.back()}
					hitSlop={8}
					className="h-9 w-9 items-center justify-center rounded-full bg-elevated active:opacity-85"
				>
					<View className="h-4 w-4 items-center justify-center">
						<View
							className="h-2.5 w-2.5 border-b-2 border-l-2 border-ink"
							style={{ transform: [{ rotate: "45deg" }, { translateX: 1 }] }}
						/>
					</View>
				</Pressable>
				<View className="ml-3 flex-1 flex-row items-center gap-2 pr-2">
					{isRenaming ? (
						<TextInput
							value={renameText}
							onChangeText={setRenameText}
							autoFocus
							onSubmitEditing={async () => {
								if (renameText.trim()) {
									await renameSession(renameText.trim());
								}
								setIsRenaming(false);
							}}
							onBlur={() => setIsRenaming(false)}
							className="h-8 flex-1 rounded-lg bg-card px-2.5 text-[15px] font-semibold text-ink"
						/>
					) : (
						<Pressable
							onLongPress={() => {
								setRenameText(sessionTitle);
								setIsRenaming(true);
							}}
							className="flex-1 justify-center"
						>
							<View className="flex-row items-center gap-2">
								<Text className="text-[16px] font-semibold tracking-tight text-ink" numberOfLines={1}>
									{sessionTitle}
								</Text>
								{isBackgroundRefreshing && <ActivityIndicator size="small" color="#9a9a9a" />}
							</View>
							{Boolean(activeSession?.cwd) && (
								<Text className="font-mono text-[10.5px] text-ink-faint" numberOfLines={1}>
									{activeSession?.cwd}
								</Text>
							)}
						</Pressable>
					)}
					<Pressable
						onPress={() => router.push("/git-status")}
						className="rounded-lg bg-elevated px-2.5 py-1 active:bg-card-hover"
					>
						<Text className="font-mono text-[12px] font-medium text-ink-muted">Git</Text>
					</Pressable>
					<Pressable
						onPress={() => router.push("/file-viewer")}
						className="rounded-lg bg-elevated px-2.5 py-1 active:bg-card-hover"
					>
						<Text className="text-[12px] font-medium text-ink-muted">文件</Text>
					</Pressable>
				</View>
			</View>

			{isInitialLoading && (
				<View className="absolute inset-0 z-10 items-center justify-center bg-shell/90">
					<ActivityIndicator size="small" color="#ededed" />
					<Text className="mt-2.5 text-[12.5px] text-ink-muted">同步中…</Text>
				</View>
			)}

			<Animated.View style={[{ flex: 1 }, listContainerAnimatedStyle]}>
				{currentTodos.length > 0 && (
					<View
						style={{ backgroundColor: colors.shell }}
						className="absolute left-0 right-0 top-0 z-10 px-3.5 pb-1.5 pt-1"
					>
						<MobileTaskList
							todos={currentTodos}
							running={running}
							onPause={() => void abort()}
							onResume={() => void send("继续，从暂停的地方接着做。")}
						/>
					</View>
				)}

				{currentTodos.length === 0 && (
					<View className="px-3.5 pt-1">
						<MobileResumeRow
							running={running}
							messages={messages}
							todos={currentTodos}
							onResume={(prompt) => void send(prompt)}
						/>
					</View>
				)}

				<FlatList
					ref={listRef}
				data={reversedRuns}
				inverted
				renderItem={renderTranscriptItem}
				keyExtractor={extractKey}
				style={{ flex: 1 }}
				contentContainerStyle={{
					paddingHorizontal: 14,
					paddingTop: 6,
					// In inverted list paddingBottom is visual top; reserve space for floating task bar
					paddingBottom: currentTodos.length > 0 ? 52 : 16,
				}}
				maxToRenderPerBatch={6}
				updateCellsBatchingPeriod={50}
				windowSize={5}
				initialNumToRender={8}
				removeClippedSubviews={false}
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="always"
				onEndReached={() => {
					if (hasEarlierMessages && !loadingEarlier) {
						void loadEarlierMessages();
					}
				}}
				onEndReachedThreshold={0.2}
				onScroll={(e) => {
					// In inverted mode: offset 0 is bottom (latest message).
					const offset = e.nativeEvent.contentOffset.y;
					// If user is actively dragging or offset is clearly away from bottom, stay unlocked
					if (!isDraggingRef.current) {
						isAtBottomRef.current = offset <= 15;
					}
					if (offset > 160) {
						scrollFabOpacity.value = withTiming(1, { duration: 150 });
					} else {
						scrollFabOpacity.value = withTiming(0, { duration: 150 });
					}
				}}
				onScrollBeginDrag={() => {
					isDraggingRef.current = true;
					isAtBottomRef.current = false;
				}}
				onScrollEndDrag={(e) => {
					isDraggingRef.current = false;
					const offset = e.nativeEvent.contentOffset.y;
					isAtBottomRef.current = offset <= 15;
				}}
				onMomentumScrollEnd={(e) => {
					isDraggingRef.current = false;
					const offset = e.nativeEvent.contentOffset.y;
					isAtBottomRef.current = offset <= 15;
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
					hasEarlierMessages ? (
						<View className="mb-3">
							{/* Cursor pagination: fetch earlier records from server */}
							<Pressable
								onPress={() => void loadEarlierMessages()}
								disabled={loadingEarlier}
								className="mb-3 flex-row items-center justify-center gap-2 rounded-xl bg-card py-2.5 active:bg-card-hover disabled:opacity-60"
							>
								{loadingEarlier ? (
									<>
										<ActivityIndicator size="small" color="#9a9a9a" />
										<Text className="text-[12px] font-medium text-ink-muted">正在向服务器加载更早历史…</Text>
									</>
								) : (
									<Text className="text-[12px] font-medium text-ink-muted">加载更早的历史记录</Text>
								)}
							</Pressable>
						</View>
					) : null
				}
			/>
				{/* Floating Scroll to Bottom Button */}
				<Animated.View
					style={[
						{
							position: "absolute",
							right: 14,
							bottom: (insets.bottom || 12) + 68,
							zIndex: 30,
						},
						fabAnimatedStyle,
					]}
				>
					<Pressable
						onPress={() => scrollToBottom(true)}
						className="h-10 w-10 items-center justify-center rounded-full bg-elevated shadow-lg active:opacity-80"
					>
						<Text className="text-[16px] text-ink">↓</Text>
					</Pressable>
				</Animated.View>
			</Animated.View>

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

			{/* Running Indicator & Input Bar & Attachments (Padded and translated together with keyboard) */}
			<Animated.View
				className="bg-sidebar"
				style={[
					{
						flexShrink: 0,
						paddingBottom: insets.bottom || 12,
					},
					keyboardAnimatedStyle,
				]}
			>
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

				{running && !answering && <MobileRunningIndicator messages={messages} toolRuns={toolRuns} />}

				{/* Composer Control Bar: Permission, Model, and Thinking */}
				<View className="flex-row items-center justify-between px-3 pt-1.5 pb-0.5">
					<View className="flex-row items-center gap-1.5">
						{/* Permission Mode Chip */}
						<Pressable
							disabled={running}
							onPress={() => {
								haptic.tap();
								setPermissionPickerOpen(true);
							}}
							className="flex-row items-center gap-1.5 rounded-full bg-card px-2.5 py-1 active:bg-card-hover disabled:opacity-60"
						>
							<View
								className={`h-1.5 w-1.5 rounded-full ${
									(settings?.permissionMode ?? "auto") === "full"
										? "bg-danger"
										: (settings?.permissionMode ?? "auto") === "auto"
											? "bg-emerald-500"
											: "bg-amber-500"
								}`}
							/>
							<Text className="text-[11.5px] font-medium text-ink">
								{(settings?.permissionMode ?? "auto") === "full"
									? "完全访问"
									: (settings?.permissionMode ?? "auto") === "auto"
										? "帮我批准"
										: "请求批准"}
							</Text>
							<Text className="text-[9.5px] text-ink-faint">▾</Text>
						</Pressable>
					</View>

					<View className="flex-row items-center gap-1.5">
						{/* Thinking Effort Chip */}
						{(() => {
							const currentModel = models.find((m) => m.id === activeSession?.modelId);
							const thinkingOpts = resolveModelThinkingOptions(
								currentModel ? { id: currentModel.id, modelId: currentModel.id } : null,
							);
							if (thinkingOpts.length === 0) return null;

							const currentLevel = activeSession?.thinking ?? settings?.thinking ?? "medium";
							const matchedOpt =
								thinkingOpts.find((o: ThinkingOption) => o.id === currentLevel) ??
								thinkingOpts.find((o: ThinkingOption) => o.isDefault);
							const label = matchedOpt?.label ?? "中";

							return (
								<Pressable
									disabled={running}
									onPress={() => {
										haptic.tap();
										setThinkingPickerOpen(true);
									}}
									className="flex-row items-center gap-1 rounded-full bg-card px-2 py-1 active:bg-card-hover disabled:opacity-60"
								>
									<Text className="text-[11px] text-ink-muted">思考</Text>
									<Text className="text-[11.5px] font-medium text-accent">
										{label}
									</Text>
									<Text className="text-[9.5px] text-ink-faint">▾</Text>
								</Pressable>
							);
						})()}

						{/* Model Chip */}
						<Pressable
							disabled={running}
							onPress={() => {
								haptic.tap();
								setModelPickerOpen(true);
							}}
							className="max-w-[155px] flex-row items-center gap-1.5 rounded-full bg-card px-2.5 py-1 active:bg-card-hover disabled:opacity-60"
						>
							<View className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
							<Text className="shrink truncate text-[11.5px] font-medium text-ink" numberOfLines={1}>
								{models.find((m) => m.id === activeSession?.modelId)?.name ?? activeSession?.modelId ?? "选择模型"}
							</Text>
							<Text className="shrink-0 text-[9.5px] text-ink-faint">▾</Text>
						</Pressable>
					</View>
				</View>

				<View className="px-3 py-2">
					<View className="flex-row items-end gap-2">
						<Pressable
							disabled={running}
							onPress={handlePickImage}
							style={{ backgroundColor: colors.elevated }}
							className={`h-11 w-11 items-center justify-center rounded-full active:opacity-75 ${
								running ? "opacity-50" : ""
							}`}
						>
							<View className="h-5 w-5 items-center justify-center">
								{/* Camera top bump */}
								<View className="h-[2.5px] w-[6px] rounded-t-[1px] bg-ink self-start ml-0.5" />
								{/* Camera body */}
								<View className="h-[13px] w-[18px] items-center justify-center rounded-[3px] border border-ink bg-transparent">
									{/* Lens */}
									<View className="h-[6px] w-[6px] rounded-full border border-ink bg-ink/30" />
								</View>
							</View>
						</Pressable>
						<TextInput
							ref={textInputRef}
							value={draft}
							editable={!running}
							onChangeText={handleDraftChange}
							placeholder={running ? "Agent 正在执行中…" : "随心输入"}
							placeholderTextColor={isDark ? "#71717a" : "#8e8e93"}
							multiline
							onSubmitEditing={handleSend}
							style={[
								{ backgroundColor: colors.input },
								inputHeight !== undefined ? { height: inputHeight } : undefined,
							]}
							className={`max-h-32 min-h-11 flex-1 rounded-2xl px-4 py-2.5 text-[14px] leading-5 text-ink ${
								running ? "opacity-60" : ""
							}`}
						/>
						{running ? (
							<Pressable
								onPress={() => {
									haptic.heavy();
									void abort();
								}}
								className="h-11 w-11 items-center justify-center rounded-full bg-ink active:opacity-85"
							>
								<View className="h-3 w-3 rounded-[2px] bg-shell" />
							</Pressable>
						) : (
							<Pressable
								disabled={!draft.trim() && selectedImages.length === 0}
								onPress={handleSend}
								style={{
									backgroundColor: draft.trim() || selectedImages.length > 0 ? colors.ink : colors.elevated,
								}}
								className="h-11 w-11 items-center justify-center rounded-full active:opacity-85 disabled:opacity-40"
							>
								<Text
									style={{
										color: draft.trim() || selectedImages.length > 0 ? colors.shell : colors.inkMuted,
									}}
									className="text-[17px] leading-5 font-bold"
								>
									↑
								</Text>
							</Pressable>
						)}
					</View>
				</View>
			</Animated.View>

			{/* Fullscreen Image Preview */}
			{viewingImageUri && (
				<View
					style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}
					className="items-center justify-center bg-black/90 p-4"
				>
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => setViewingImageUri(null)}
					/>
					<Image
						source={{ uri: viewingImageUri }}
						className="h-full w-full"
						resizeMode="contain"
					/>
					<Pressable
						onPress={() => setViewingImageUri(null)}
						className="absolute top-12 right-6 h-10 w-10 items-center justify-center rounded-full bg-white/20"
					>
						<Text className="text-[16px] font-bold text-white">✕</Text>
					</Pressable>
				</View>
			)}

			{/* Adaptive High-Grade ActionSheet for Camera & Photo Picker */}
			<MobileActionSheet
				visible={imageSheetVisible}
				title="添加图片"
				iconKind="image"
				onClose={() => setImageSheetVisible(false)}
				actions={[
					{
						label: "拍照",
						onPress: () => {
							void takePhoto();
						},
					},
					{
						label: "从相册选取",
						onPress: () => {
							void pickFromLibrary();
						},
					},
				]}
			/>

			{/* Adaptive Session Alert Dialog */}
			<MobileConfirmDialog
				visible={sessionAlert.visible}
				title={sessionAlert.title}
				message={sessionAlert.message}
				confirmText="知道了"
				cancelText=""
				onConfirm={() => setSessionAlert((prev) => ({ ...prev, visible: false }))}
				onCancel={() => setSessionAlert((prev) => ({ ...prev, visible: false }))}
			/>

			{/* Model Picker Modal */}
			<MobileModelPickerModal
				visible={modelPickerOpen}
				models={models}
				currentModelId={activeSession?.modelId ?? null}
				onSelectModel={(modelId) => {
					void setModel(modelId);
				}}
				onClose={() => setModelPickerOpen(false)}
			/>

			{/* Thinking Effort Picker Modal */}
			<MobileThinkingPickerModal
				visible={thinkingPickerOpen}
				model={models.find((m) => m.id === activeSession?.modelId) ?? null}
				currentThinking={activeSession?.thinking ?? settings?.thinking ?? "medium"}
				onSelectThinking={(thinking) => {
					void setThinking(thinking);
				}}
				onClose={() => setThinkingPickerOpen(false)}
			/>

			{/* Permission Picker Modal */}
			<MobilePermissionPickerModal
				visible={permissionPickerOpen}
				currentMode={settings?.permissionMode ?? "auto"}
				onSelectMode={(mode) => {
					void setPermissionMode(mode);
				}}
				onClose={() => setPermissionPickerOpen(false)}
			/>
		</View>
	);
}

// Helper for stable key extraction that does NOT change mid-stream or collide
function getRunKey(run: MobileRun, index: number): string {
	if (run.kind === "tools") return `tools-${run.id}-${index}`;
	const m = run.message;
	if (m.role === "toolResult") return `tr-${m.toolCallId}-${run.index}`;
	if (m.role === "user") return `user-${m.timestamp}-${run.index}`;
	// For assistant, use index + timestamp + upTo slice to ensure global uniqueness across turns
	return `ast-${m.timestamp}-${run.index}-${run.upTo}`;
}

function isSyntheticOrNudge(message: Message): boolean {
	if (message.role === "user") {
		if (message.synthetic) return true;
		return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
	}
	return false;
}

const MobileTranscriptRow = React.memo(
	function MobileTranscriptRow({
		run,
		onImagePress,
	}: {
		run: MobileRun;
		onImagePress?: (uri: string) => void;
	}) {
		if (run.kind === "tools") {
			return <ToolRunGroup calls={run.calls} />;
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
	},
	(prev, next) => {
		if (prev.run === next.run && prev.onImagePress === next.onImagePress) return true;
		if (prev.run.kind !== next.run.kind) return false;
		if (prev.run.kind === "tools" && next.run.kind === "tools") {
			return prev.run.id === next.run.id && prev.run.calls.length === next.run.calls.length;
		}
		if (prev.run.kind === "message" && next.run.kind === "message") {
			return prev.run.message === next.run.message && prev.run.upTo === next.run.upTo;
		}
		return false;
	},
);

function AssistantRow({ message, upTo }: { message: AssistantMessage; upTo: number }) {
	const text = assistantText(message, upTo);
	const thinking = message.content.find((c) => c.type === "thinking");

	return (
		<View className="mb-4">
			{thinking && thinking.type === "thinking" && (
				<MobileThinkingBlock
					text={thinking.thinking}
					redacted={thinking.redacted}
					live={message.stopReason === "pending"}
				/>
			)}

			{text.length > 0 && <MobileMarkdownView content={text} />}

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
}: {
	calls: { block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[];
}) {
	const [open, setOpen] = useState(false);
	const toolRuns = useMobile((s) => s.toolRuns);
	const running = useMobile((s) => s.running);
	const { colors } = useThemeColors();
	const listRef = useRef<View>(null);

	const callsWithSummary = calls.map((c) => {
		const tr = toolRuns[c.block.id];
		const fallbackDone = !running || c.stopReason !== "pending";
		return {
			toolName: c.block.name,
			summary: tr?.summary ?? c.block.name,
			status: tr?.status ?? (fallbackDone ? "done" : "running"),
		};
	});

	const isRunning = callsWithSummary.some((c) => c.status === "running");
	const hasError = callsWithSummary.some((c) => c.status === "error");
	const summaryText = describeRun(callsWithSummary);

	const toggleOpen = () => {
		LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
		setOpen((v) => !v);
	};

	return (
		<View
			ref={listRef}
			style={{ backgroundColor: colors.card }}
			className="mb-2.5 overflow-hidden rounded-2xl"
		>
			<Pressable
				onPress={toggleOpen}
				className="flex-row items-center justify-between px-3.5 py-2.5 active:opacity-80"
			>
				<View className="mr-2 flex-1 flex-row items-center gap-2">
					<View
						className={`h-2 w-2 rounded-full ${
							hasError ? "bg-danger" : isRunning ? "bg-accent" : "bg-ok"
						}`}
					/>
					<Text
						style={{ color: colors.ink }}
						className="flex-1 text-[13px] font-medium"
						numberOfLines={1}
					>
						{summaryText || "调用工具"}
					</Text>
				</View>
				<View className="flex-row items-center gap-2">
					<Text style={{ color: colors.inkMuted }} className="text-[11.5px] font-mono">
						{calls.length} 项
					</Text>
					<Text style={{ color: colors.inkFaint }} className="text-[11px]">
						{open ? "▾" : "▸"}
					</Text>
				</View>
			</Pressable>

			{open && (
				<View className="px-3 pb-1.5 pt-0.5">
					{calls.map((c, idx) => (
						<ToolCard
							key={`${c.block.id}-${idx}`}
							run={toolRuns[c.block.id]}
							name={c.block.name}
						/>
					))}
				</View>
			)}
		</View>
	);
}

function renderToolSummary(summary: string) {
	// Parse git-like diff stats: e.g. "Edited foo.tsx: 1 replacement, +1 -1." or "+10 -5"
	const diffMatch = summary.match(/^([\s\S]*?)(?:,\s*)?(\+\d+)?(?:\s*)?([-\u2212]\d+)?(\.?)$/);
	if (diffMatch && (diffMatch[2] || diffMatch[3])) {
		const prefix = diffMatch[1];
		const added = diffMatch[2];
		const removed = diffMatch[3];
		const suffix = diffMatch[4];

		return (
			<Text className="flex-1 font-mono text-[12px] text-ink-muted" numberOfLines={1}>
				{prefix}
				{Boolean(prefix && (added || removed)) && " "}
				{Boolean(added) && (
					<Text className="font-bold text-ok">{added} </Text>
				)}
				{Boolean(removed) && (
					<Text className="font-bold text-danger">{removed}</Text>
				)}
				{suffix}
			</Text>
		);
	}

	return (
		<Text className="flex-1 font-mono text-[12px] text-ink-muted" numberOfLines={1}>
			{summary}
		</Text>
	);
}

function ToolCard({ run, name }: { run: ToolRun | undefined; name: string }) {
	const [open, setOpen] = useState(false);
	const [ready, setReady] = useState(false);
	const status = run?.status ?? "running";

	const toggleOpen = () => {
		LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
		const next = !open;
		setOpen(next);
		if (next && !ready) {
			// Defer heavy code viewer until after layout animation settles
			requestIdleCallback(() => setReady(true));
		}
	};

	const summaryText = run?.summary ?? name;

	return (
		<View className="py-1.5">
			<Pressable
				onPress={toggleOpen}
				className="flex-row items-center justify-between gap-2 active:opacity-75"
			>
				{renderToolSummary(summaryText)}
				<View className="flex-row items-center gap-1.5">
					<View
						className={`h-1.5 w-1.5 rounded-full ${
							status === "error" ? "bg-danger" : status === "done" ? "bg-ok" : "bg-accent"
						}`}
					/>
					<Text
						className={`text-[11px] font-medium ${
							status === "error" ? "text-danger" : status === "done" ? "text-ok" : "text-accent"
						}`}
					>
						{status === "running" ? "运行中" : status === "done" ? "完成" : "失败"}
					</Text>
					{Boolean(run?.output) && (
						<Text className="text-[10px] text-ink-faint">{open ? "▴" : "▾"}</Text>
					)}
				</View>
			</Pressable>
			{open && Boolean(run?.output) && (
				<View className="mt-1.5 overflow-hidden rounded-xl bg-card">
					{ready ? (
						<MobileCodeViewer code={run?.output || ""} />
					) : (
						<View className="items-center py-3">
							<ActivityIndicator size="small" />
						</View>
					)}
				</View>
			)}
		</View>
	);
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
