import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { haptic } from "../../src/haptics";
import { MobileThinkingOrb } from "../../src/MobileThinkingOrb";
import {
	ActivityIndicator,
	FlatList,
	Image,
	Keyboard,
	Modal,
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
import { summarizeToolCall } from "../../src/toolSummary";
import { MobilePermissionPickerModal } from "../../src/MobilePermissionPickerModal";
import { explain } from "../../src/explain";
import { MobileThinkingPickerModal } from "../../src/MobileThinkingPickerModal";
import { resolveModelThinkingOptions, type ThinkingOption } from "../../src/thinkingOptions";
import { MobileTaskList } from "../../src/MobileTaskList";
import { MobileThinkingBlock } from "../../src/MobileThinkingBlock";
import { groupMessages, type MobileRun } from "../../src/grouping";
import { describeRun, formatElapsed, formatTokens, moodFor, phraseFor, type Mood } from "../../src/runSummary";
import type { AssistantMessage, ImageContent, Message } from "../../src/protocol";
import { todosFrom, useMobile, type ToolRun } from "../../src/store";
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
	const storeRunning = useMobile((s) => s.running);
	const sessionActivities = useMobile((s) => s.sessionActivities);
	const running = storeRunning || sessionActivities[id] === "running";
	const openSession = useMobile((s) => s.openSession);
	const closeSession = useMobile((s) => s.closeSession);
	const send = useMobile((s) => s.send);
	const abort = useMobile((s) => s.abort);
	const approve = useMobile((s) => s.approve);
	const retryFrom = useMobile((s) => s.retryFrom);
	const resume = useMobile((s) => s.resume);

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
	const models = settings?.models ?? [];
	const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
	const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);
	const listRef = useRef<FlatList>(null);

	const loadingSessionId = useMobile((s) => s.loadingSessionId);
	const loadingEarlier = useMobile((s) => s.loadingEarlier);
	const hasEarlierMessages = useMobile((s) => s.hasEarlierMessages);
	const loadEarlierMessages = useMobile((s) => s.loadEarlierMessages);
	const isAtBottomRef = useRef(true);
	const isFabVisibleRef = useRef(false);
	const [fabVisible, setFabVisible] = useState(false);
	const isDraggingRef = useRef(false);
	const isMomentumScrollingRef = useRef(false);
	const [earlierPillVisible, setEarlierPillVisible] = useState(false);
	const isEarlierPillVisibleRef = useRef(false);
	const earlierPillOpacity = useSharedValue(0);
	const [todoHeight, setTodoHeight] = useState(0);
	const textInputRef = useRef<TextInput>(null);
	const loadingEarlierRef = useRef(false);
	useEffect(() => {
		loadingEarlierRef.current = loadingEarlier;
	}, [loadingEarlier]);

	const earlierPillAnimatedStyle = useAnimatedStyle(() => ({
		opacity: earlierPillOpacity.value,
		transform: [
			{ scale: 0.94 + earlierPillOpacity.value * 0.06 },
			{ translateY: (earlierPillOpacity.value - 1) * 8 },
		],
	}));

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
		transform: [
			{ scale: 0.92 + scrollFabOpacity.value * 0.08 },
			{ translateY: (1 - scrollFabOpacity.value) * 10 },
		],
	}));

	// Reset state when switching session
	useEffect(() => {
		isAtBottomRef.current = true;
		isFabVisibleRef.current = false;
		setFabVisible(false);
		isEarlierPillVisibleRef.current = false;
		setEarlierPillVisible(false);
		earlierPillOpacity.value = 0;
		isDraggingRef.current = false;
		isMomentumScrollingRef.current = false;
		scrollFabOpacity.value = 0;
	}, [id, scrollFabOpacity, earlierPillOpacity]);

	const setEarlierPillState = useCallback(
		(visible: boolean) => {
			if (isEarlierPillVisibleRef.current !== visible) {
				isEarlierPillVisibleRef.current = visible;
				setEarlierPillVisible(visible);
				earlierPillOpacity.value = withTiming(visible ? 1 : 0, { duration: 180 });
			}
		},
		[earlierPillOpacity],
	);
	const scrollToBottom = useCallback((animated = true) => {
		isAtBottomRef.current = true;
		isFabVisibleRef.current = false;
		setFabVisible(false);
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
		// Snap immediately to offset 0 when user actively sends a message
		scrollToBottom(false);
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
			// launchImageLibraryAsync handles permissions natively via PhotoPicker without blocking IPC
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				allowsMultipleSelection: true,
				selectionLimit: 4 - selectedImages.length,
				quality: 0.7,
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.includes("permission") || msg.includes("Permission")) {
				showSessionAlert("权限不足", "需要访问相册权限，请在系统设置中开启");
			} else {
				showSessionAlert("选图失败", "读取相册图片出现异常");
			}
		}
	};

	const takePhoto = async () => {
		try {
			// Directly launch camera; let OS/native layer prompt or throw on denial without extra IPC roundtrips
			const result = await ImagePicker.launchCameraAsync({
				quality: 0.7,
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.includes("permission") || msg.includes("Permission")) {
				showSessionAlert("权限不足", "需要相机权限，请在系统设置中开启");
			} else {
				showSessionAlert("拍照失败", "唤起相机出现异常");
			}
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
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- run once on mount or when id changes to avoid infinite loop
	}, [id]);

	// Pre-sort reversed runs synchronously so FlatList mounts already inverted without layout jump
	const reversedRuns = useMemo(() => {
		const runs = groupMessages(messages);
		const seen = new Set<string>();
		for (const run of runs) {
			const key = getRunKey(run);
			if (seen.has(key) && run.kind === "tools") {
				run.id = `${run.id}_dup_${seen.size}`;
			}
			seen.add(getRunKey(run));
		}
		return runs.reverse();
	}, [messages]);

	// Industrial-grade auto-scroll anchor:
	// When user is at bottom (isAtBottomRef === true) and not actively dragging,
	// keep view strictly pinned to bottom across streaming updates, tool card expansion, and runs changes.
	useEffect(() => {
		if (!isAtBottomRef.current || isDraggingRef.current || isMomentumScrollingRef.current) return;
		if (currentScrollOffsetRef.current > 15) return;
		listRef.current?.scrollToOffset({ offset: 0, animated: false });
	}, [reversedRuns, running]);

	// Ensure fresh viewport on mount or session switch: strictly reset scroll offset to 0 (bottom)
	useEffect(() => {
		const timer = setTimeout(() => {
			if (isAtBottomRef.current && !isDraggingRef.current && !isMomentumScrollingRef.current) {
				listRef.current?.scrollToOffset({ offset: 0, animated: false });
			}
		}, 50);
		return () => clearTimeout(timer);
	}, [id]);
	// Clean up session state on unmount
	useEffect(() => {
		return () => {
			closeSession();
		};
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only
	}, []);

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

	const currentTodos = useMemo(() => todosFrom(messages), [messages]);

	const extractKey = useCallback((item: MobileRun) => getRunKey(item), []);

	const handleImagePress = useCallback((uri: string) => {
		setViewingImageUri(uri);
	}, []);

	const currentScrollOffsetRef = useRef(0);
	const isCollapsingRef = useRef(false);
	const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		return () => {
			if (collapseTimeoutRef.current) {
				clearTimeout(collapseTimeoutRef.current);
			}
		};
	}, []);

	const handleCollapse = useCallback((source: "top" | "bottom", heightDiff: number) => {
		if (source === "top" && heightDiff > 0) {
			// When collapsing from top header in inverted list, the visual top of the card moves down by heightDiff.
			// Compensate scroll offset immediately by subtracting heightDiff so the header stays anchored.
			isCollapsingRef.current = true;
			if (collapseTimeoutRef.current) clearTimeout(collapseTimeoutRef.current);
			collapseTimeoutRef.current = setTimeout(() => {
				isCollapsingRef.current = false;
			}, 250);

			const currentOffset = currentScrollOffsetRef.current;
			const targetOffset = Math.max(0, currentOffset - heightDiff);
			listRef.current?.scrollToOffset({
				offset: targetOffset,
				animated: false,
			});
		}
		// When source === "bottom":
		// Viewport is already anchored at the bottom of the card reading forward.
		// In inverted FlatList, collapsing upwards naturally reveals the next message.
		// Do not force scrollToIndex which caused unwanted downward jump.
	}, []);

	const renderTranscriptItem = useCallback(
		({ item }: { item: MobileRun; index: number }) => (
			<MobileTranscriptRow
				run={item}
				onImagePress={handleImagePress}
				onCollapse={handleCollapse}
			/>
		),
		[handleImagePress, handleCollapse],
	);
	const storeError = useMobile((s) => s.error);
	const isInitialLoading = (loadingSessionId === id || !activeSession) && messages.length === 0 && !storeError;
	const isBackgroundRefreshing = loadingSessionId === id && messages.length > 0 && running;
	const isLoadFailed = !isInitialLoading && loadingSessionId !== id && messages.length === 0 && Boolean(storeError);
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
			<View className="h-11 flex-row items-center bg-shell px-3">
				<Pressable
					onPress={() => router.back()}
					hitSlop={8}
					className="h-8 w-8 items-center justify-center rounded-full bg-elevated active:opacity-85"
				>
					<View className="h-4 w-4 items-center justify-center">
						<View
							className="h-2.5 w-2.5 border-b-2 border-l-2 border-ink"
							style={{ transform: [{ rotate: "45deg" }, { translateX: 1 }] }}
						/>
					</View>
				</Pressable>
				<View className="ml-2.5 flex-1 flex-row items-center gap-1.5 pr-1">
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
							className="h-7 flex-1 rounded-lg bg-card px-2 text-[14px] font-semibold text-ink"
						/>
					) : (
						<Pressable
							onLongPress={() => {
								setRenameText(sessionTitle);
								setIsRenaming(true);
							}}
							className="flex-1 justify-center overflow-hidden pr-0.5"
						>
							<View className="flex-row items-center gap-1.5 overflow-hidden">
								<Text className="shrink text-[14.5px] font-semibold tracking-tight text-ink" numberOfLines={1}>
									{sessionTitle}
								</Text>
								{activeSession?.cwd ? (
									<Text className="shrink-0 font-mono text-[10px] text-ink-faint" numberOfLines={1}>
										({activeSession.cwd.split(/[/\\]/).findLast(Boolean) ?? ""})
									</Text>
								) : null}
							</View>
						</Pressable>
					)}
					<Pressable
						onPress={() => router.push("/git-status")}
						className="shrink-0 rounded-lg bg-elevated px-2 py-1 active:bg-card-hover"
					>
						<Text className="font-mono text-[11.5px] font-medium text-ink-muted">Git</Text>
					</Pressable>
					<Pressable
						onPress={() => router.push("/file-viewer")}
						className="shrink-0 rounded-lg bg-elevated px-2 py-1 active:bg-card-hover"
					>
						<Text className="text-[11.5px] font-medium text-ink-muted">文件</Text>
					</Pressable>
				</View>
			</View>

			{isInitialLoading && (
				<View
					style={{ top: insets.top + 44, bottom: 0, left: 0, right: 0 }}
					className="absolute z-50 items-center justify-center bg-shell/95 backdrop-blur-sm pointer-events-none"
				>
					<View
						style={{ backgroundColor: colors.card, borderColor: colors.line }}
						className="items-center justify-center gap-3 rounded-2xl border px-6 py-5 shadow-lg shadow-black/10"
					>
						<ActivityIndicator size="small" color={colors.accent} />
						<Text style={{ color: colors.ink }} className="text-[13px] font-medium tracking-wide">
							正在载入会话记录…
						</Text>
						<Text style={{ color: colors.inkMuted }} className="text-[11px]">
							首次进入正在同步对话…
						</Text>
					</View>
				</View>
			)}
			{isLoadFailed && (
				<View
					style={{ top: insets.top + 44, bottom: 0, left: 0, right: 0 }}
					className="absolute z-40 items-center justify-center bg-shell px-6"
				>
					<View
						style={{ backgroundColor: colors.card, borderColor: colors.line }}
						className="w-full max-w-sm items-center justify-center gap-3 rounded-2xl border px-6 py-6 shadow-sm"
					>
						<View
							style={{ backgroundColor: isDark ? "rgba(239, 68, 68, 0.15)" : "rgba(239, 68, 68, 0.1)" }}
							className="h-10 w-10 items-center justify-center rounded-full"
						>
							<Text className="text-[18px]">⚠️</Text>
						</View>
						<Text style={{ color: colors.ink }} className="text-center text-[15px] font-semibold">
							加载会话失败
						</Text>
						<Text style={{ color: colors.inkMuted }} className="text-center text-[12px] leading-5">
							{storeError ?? "网络异常或会话记录读取失败"}
						</Text>
						<Pressable
							onPress={() => {
								haptic.tap();
								const meta = sessions.find((s) => s.id === id);
								if (meta) void openSession(meta);
							}}
							style={{ backgroundColor: colors.accent }}
							className="mt-2 w-full items-center justify-center rounded-xl py-2.5 active:opacity-85"
						>
							<Text className="text-[13px] font-semibold text-white">点击重试</Text>
						</Pressable>
					</View>
				</View>
			)}


			{isBackgroundRefreshing && (
				<View
					pointerEvents="none"
					className="absolute left-0 right-0 z-30 items-center"
					style={{ top: insets.top + 46 }}
				>
					<View
						style={{
							backgroundColor: isDark ? "rgba(30, 30, 34, 0.92)" : "rgba(255, 255, 255, 0.96)",
							borderColor: isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)",
							shadowColor: "#000",
							shadowOffset: { width: 0, height: 2 },
							shadowOpacity: isDark ? 0.35 : 0.08,
							shadowRadius: 6,
							elevation: 4,
						}}
						className="flex-row items-center gap-2 rounded-full border px-3 py-1.5"
					>
						<ActivityIndicator size="small" color={colors.accent} style={{ transform: [{ scale: 0.75 }] }} />
						<Text style={{ color: colors.inkMuted }} className="text-[11.5px] font-medium tracking-tight">
							正在同步最新对话…
						</Text>
					</View>
				</View>
			)}
			<Animated.View style={[{ flex: 1 }, listContainerAnimatedStyle]}>
				{/* Top Bar Anchors: Todo List only */}
				{currentTodos.length > 0 && (
					<View
						onLayout={(e) => {
							const h = e.nativeEvent.layout.height;
							if (h > 0 && h !== todoHeight) setTodoHeight(h);
						}}
						className="z-10 bg-shell px-3.5 pt-0.5 pb-1"
					>
						<MobileTaskList
							todos={currentTodos}
							running={running}
							onPause={() => void abort()}
							onResume={() => void send("继续，从暂停的地方接着做。")}
						/>
					</View>
				)}
				{/* Floating "Load Earlier Messages" Pill - Appears only when user explicitly pulls/scrolls to top edge */}
				{hasEarlierMessages && (
					<Animated.View
						pointerEvents={earlierPillVisible ? "auto" : "none"}
						style={[
							{
								top: currentTodos.length > 0 ? (todoHeight > 0 ? todoHeight + 4 : 44) : 4,
								left: 0,
								right: 0,
								alignItems: "center",
								zIndex: 25,
							},
							earlierPillAnimatedStyle,
						]}
					>
						<Pressable
							onPress={() => {
								haptic.tap();
								void loadEarlierMessages();
							}}
							disabled={loadingEarlier}
							style={{
								backgroundColor: isDark ? "rgba(30, 30, 34, 0.94)" : "rgba(255, 255, 255, 0.96)",
								borderColor: colors.line,
								shadowColor: "#000",
								shadowOffset: { width: 0, height: 2 },
								shadowOpacity: isDark ? 0.4 : 0.1,
								shadowRadius: 6,
								elevation: 5,
							}}
							className="flex-row items-center justify-center gap-2 rounded-full border px-3.5 py-1.5 active:opacity-75 disabled:opacity-60"
						>
							{loadingEarlier ? (
								<>
									<ActivityIndicator size="small" color={colors.accent} />
									<Text style={{ color: colors.inkMuted }} className="text-[12px] font-medium tracking-tight">
										正在加载更早 12 组对话…
									</Text>
								</>
							) : (
								<>
									<View className="h-3.5 w-3.5 items-center justify-center">
										<View
											className="h-2 w-2 border-l-[1.5px] border-t-[1.5px]"
											style={{ borderColor: colors.inkMuted, transform: [{ rotate: "45deg" }, { translateY: 1 }] }}
										/>
									</View>
									<Text style={{ color: colors.inkMuted }} className="text-[12px] font-medium tracking-tight">
										加载更早 12 组对话
									</Text>
								</>
							)}
						</Pressable>
					</Animated.View>
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
						paddingTop: 8,
						paddingBottom: 8,
					}}
					maxToRenderPerBatch={15}
					updateCellsBatchingPeriod={30}
					windowSize={15}
					initialNumToRender={12}
					removeClippedSubviews={false}
					onScrollToIndexFailed={() => {}}
					keyboardDismissMode="on-drag"
					keyboardShouldPersistTaps="always"
					onEndReachedThreshold={0.05}
					onEndReached={() => {
						if (!hasEarlierMessages || loadingEarlierRef.current) return;
						// Automatically load earlier 12 dialogue turns when reaching top of history
						void loadEarlierMessages();
					}}
				onScroll={(e) => {
					// In inverted mode: offset 0 is bottom (latest message).
					const offset = e.nativeEvent.contentOffset.y;
					currentScrollOffsetRef.current = offset;
					if (offset > 15) {
						isAtBottomRef.current = false;
					} else if (!isDraggingRef.current && !isMomentumScrollingRef.current) {
						isAtBottomRef.current = true;
					}
					const isVisible = offset > 80;
					isFabVisibleRef.current = isVisible;
					if (isVisible !== fabVisible) {
						setFabVisible(isVisible);
						scrollFabOpacity.value = withTiming(isVisible ? 1 : 0, { duration: 150 });
					}
					const { layoutMeasurement, contentSize } = e.nativeEvent;
					const isNearTopEdge =
						Boolean(hasEarlierMessages) &&
						offset > 120 &&
						Boolean(layoutMeasurement) &&
						Boolean(contentSize) &&
						contentSize.height > layoutMeasurement.height + 100 &&
						layoutMeasurement.height + offset >= contentSize.height - 40;
					setEarlierPillState(isNearTopEdge);
				}}
				ListFooterComponent={null}
				ListHeaderComponent={null}
				onScrollBeginDrag={() => {
					isDraggingRef.current = true;
					isMomentumScrollingRef.current = false;
					isAtBottomRef.current = false;
				}}
				onScrollEndDrag={(e) => {
					isDraggingRef.current = false;
					const offset = e.nativeEvent.contentOffset.y;
					currentScrollOffsetRef.current = offset;
					if (offset > 15) {
						isAtBottomRef.current = false;
					} else if (!isMomentumScrollingRef.current) {
						isAtBottomRef.current = true;
					}
					const isVisible = offset > 80;
					isFabVisibleRef.current = isVisible;
					if (isVisible !== fabVisible) {
						setFabVisible(isVisible);
						scrollFabOpacity.value = withTiming(isVisible ? 1 : 0, { duration: 150 });
					}
				}}
				onMomentumScrollBegin={() => {
					isMomentumScrollingRef.current = true;
				}}
				onMomentumScrollEnd={(e) => {
					isDraggingRef.current = false;
					isMomentumScrollingRef.current = false;
					const offset = e.nativeEvent.contentOffset.y;
					currentScrollOffsetRef.current = offset;
					if (offset > 15) {
						isAtBottomRef.current = false;
					} else {
						isAtBottomRef.current = true;
					}
					const isVisible = offset > 80;
					isFabVisibleRef.current = isVisible;
					if (isVisible !== fabVisible) {
						setFabVisible(isVisible);
						scrollFabOpacity.value = withTiming(isVisible ? 1 : 0, { duration: 150 });
					}
				}}
			/>
				{/* Floating Bottom Center Pill (ChatGPT/Linear Style, borderless) */}
				<Animated.View
					pointerEvents={fabVisible ? "auto" : "none"}
					style={[
						{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: 12,
							alignItems: "center",
							zIndex: 30,
						},
						fabAnimatedStyle,
					]}
				>
					<Pressable
						onPress={() => scrollToBottom(true)}
						hitSlop={10}
						style={{
							backgroundColor: isDark ? "rgba(30, 30, 34, 0.92)" : "rgba(255, 255, 255, 0.95)",
							shadowColor: "#000",
							shadowOffset: { width: 0, height: 4 },
							shadowOpacity: isDark ? 0.45 : 0.12,
							shadowRadius: 10,
							elevation: 6,
						}}
						className="flex-row items-center gap-1.5 rounded-full px-3 py-1.5 active:scale-95 active:opacity-75"
					>
						{/* Precision Minimal Chevron: 12x12 container centered, rotating square shifted upward by half diagonal */}
						<View className="h-3 w-3 items-center justify-center overflow-hidden">
							<View
								style={{
									width: 6,
									height: 6,
									borderBottomWidth: 1.5,
									borderRightWidth: 1.5,
									borderColor: colors.inkMuted,
									transform: [{ rotate: "45deg" }, { translateY: -1 }],
								}}
							/>
						</View>
						<Text
							style={{ color: colors.inkMuted }}
							className="text-[11.5px] font-medium tracking-tight"
						>
							回到底部
						</Text>
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

				{/* Resume / Continue Row when last request failed, stopped or has remaining items */}
				{!running && (() => {
					const lastMsg = messages[messages.length - 1];
					const isStoppedError = lastMsg?.role === "assistant" && lastMsg.stopReason === "error";
					const isStoppedAborted = lastMsg?.role === "assistant" && lastMsg.stopReason === "aborted";
					if (!isStoppedError && !isStoppedAborted) return null;

					const note = isStoppedError ? "上次请求失败，进度已保留" : "已暂停";

					return (
						<View className="flex-row items-center gap-2 px-3.5 pt-1.5 pb-0.5">
							<Text className="text-[11.5px] text-ink-faint">{note}</Text>
							<Text className="text-[11.5px] text-ink-faint">·</Text>
							<Pressable
								onPress={() => {
									haptic.tap();
									void resume();
								}}
								className="active:opacity-60"
							>
								<Text className="text-[12px] font-medium text-accent underline">继续</Text>
							</Pressable>
							<Text className="text-[11.5px] text-ink-faint">·</Text>
							<Pressable
								onPress={() => {
									haptic.tap();
									void retryFrom(messages.length - 1);
								}}
								className="active:opacity-60"
							>
								<Text className="text-[12px] font-medium text-ink-muted">重试</Text>
							</Pressable>
						</View>
					);
				})()}

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
			<Modal
				visible={Boolean(viewingImageUri)}
				transparent
				animationType="fade"
				statusBarTranslucent
				onRequestClose={() => setViewingImageUri(null)}
			>
				<View className="flex-1 items-center justify-center bg-black/90 p-4">
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => setViewingImageUri(null)}
					/>
					{Boolean(viewingImageUri) && (
						<Image
							source={{ uri: viewingImageUri! }}
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
				</View>
			</Modal>

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

export function getRunKey(run: MobileRun): string {
	if (run.kind === "tools") return `tools-${run.id}`;
	const m = run.message;
	if (m.role === "toolResult") return `tr-${m.toolCallId}`;
	if (m.role === "user") {
		const txt = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		return `user-${m.timestamp}-${run.index}-${txt.slice(0, 16)}`;
	}
	const sliceKey = `${run.from ?? 0}-${run.upTo}`;
	return `ast-${m.timestamp}-${run.index}-${sliceKey}`;
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
		onCollapse,
	}: {
		run: MobileRun;
		onImagePress?: (uri: string) => void;
		onCollapse?: (source: "top" | "bottom", heightDiff: number) => void;
	}) {
		if (run.kind === "tools") {
			return <ToolRunGroup calls={run.calls} onCollapse={onCollapse} />;
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
						<View
							className={`mb-1.5 flex-row flex-wrap justify-end gap-1.5 ${
								imageContents.length === 1
									? "max-w-[70%]"
									: imageContents.length === 2 || imageContents.length === 4
										? "max-w-[80%]"
										: "max-w-[95%]"
							}`}
						>
							{imageContents.map((img, idx) => {
								const uri = `data:${img.mimeType};base64,${img.data}`;
								const imgSizeClass =
									imageContents.length === 1
										? "h-44 w-44"
										: imageContents.length === 3
											? "h-24 w-24"
											: "h-28 w-28";
								return (
									<Pressable
										key={idx}
										onPress={() => onImagePress?.(uri)}
										className={`${imgSizeClass} overflow-hidden rounded-2xl bg-card active:opacity-80`}
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

		return <AssistantRow message={message} upTo={run.upTo} from={run.from} onCollapse={onCollapse} />;
	},
	(prev, next) => {
		if (
			prev.run === next.run &&
			prev.onImagePress === next.onImagePress &&
			prev.onCollapse === next.onCollapse
		)
			return true;
		if (prev.run.kind !== next.run.kind) return false;
		if (prev.run.kind === "tools" && next.run.kind === "tools") {
			return (
				prev.run.id === next.run.id &&
				prev.run.calls.length === next.run.calls.length &&
				prev.run.live === next.run.live &&
				prev.onCollapse === next.onCollapse
			);
		}
		if (prev.run.kind === "message" && next.run.kind === "message") {
			return (
				prev.run.message === next.run.message &&
				prev.run.upTo === next.run.upTo &&
				prev.run.from === next.run.from &&
				prev.onCollapse === next.onCollapse
			);
		}
		return false;
	},
);

function AssistantRow({
	message,
	upTo,
	from = 0,
	onCollapse,
}: {
	message: AssistantMessage;
	upTo: number;
	from?: number;
	onCollapse?: (source: "top" | "bottom", heightDiff: number) => void;
}) {
	const own = message.content.slice(from, upTo);

	return (
		<View className="mb-4">
			{own.map((block, index) => {
				const at = from + index;
				if (block.type === "thinking") {
					return (
						<MobileThinkingBlock
							key={`think-${at}`}
							text={block.thinking}
							redacted={block.redacted}
							live={message.stopReason === "pending" && at === message.content.length - 1}
							onCollapse={onCollapse}
						/>
					);
				}
				if (block.type === "text") {
					return block.text.trim() ? (
						<View key={`text-${at}`} className="mb-2">
							<MobileMarkdownView content={block.text} />
						</View>
					) : null;
				}
				return null;
			})}

			{message.stopReason === "error" && message.errorMessage && (
				<MobileErrorBlock errorMessage={message.errorMessage} />
			)}
		</View>
	);
}

function MobileErrorBlock({ errorMessage }: { errorMessage: string }) {
	const [open, setOpen] = useState(false);
	const explained = explain(errorMessage);
	const hasDetail = explained.message !== errorMessage;

	return (
		<View className="mt-2.5 overflow-hidden rounded-2xl border border-danger/20 bg-danger/5 p-3">
			<Pressable
				onPress={() => {
					if (hasDetail) {
						setOpen((v) => !v);
					}
				}}
				className="flex-row items-center justify-between active:opacity-75"
			>
				<View className="mr-2 flex-1 flex-row items-center gap-2">
					<View className="h-2 w-2 rounded-full bg-danger" />
					<Text className="text-[13px] font-semibold text-danger">{explained.message}</Text>
				</View>
				{hasDetail && (
					<Text className="text-[11px] text-ink-faint">{open ? "收起 ▲" : "详情 ▼"}</Text>
				)}
			</Pressable>

			{open && hasDetail && (
				<View className="mt-2.5 rounded-xl bg-card/60 p-2.5">
					{explained.hint && (
						<Text className="mb-1.5 text-[11.5px] leading-4 text-ink-muted">{explained.hint}</Text>
					)}
					<Text selectable className="font-mono text-[11px] leading-4 text-ink-faint">
						{errorMessage}
					</Text>
				</View>
			)}
		</View>
	);
}

function ToolRunGroup({
	calls,
	onCollapse,
}: {
	calls: { block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>; stopReason: AssistantMessage["stopReason"] }[];
	onCollapse?: (source: "top" | "bottom", heightDiff: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const toolRuns = useMobile((s) => s.toolRuns);
	const storeRunning = useMobile((s) => s.running);
	const sessionActivities = useMobile((s) => s.sessionActivities);
	const activeSession = useMobile((s) => s.activeSession);
	const running = storeRunning || (activeSession ? sessionActivities[activeSession.id] === "running" : false);
	const { colors } = useThemeColors();
	const containerHeightRef = useRef(0);
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

	const handleCollapse = (source: "top" | "bottom") => {
		const diff = Math.max(0, containerHeightRef.current - 44);
		setOpen(false);
		onCollapse?.(source, diff);
	};

	const toggleOpen = () => {
		if (open) {
			handleCollapse("top");
		} else {
			setOpen(true);
		}
	};
	return (
		<View
			onLayout={(e) => {
				containerHeightRef.current = e.nativeEvent.layout.height;
			}}
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
				<View className="px-3 pb-2 pt-0.5">
					{calls.map((c, idx) => (
						<ToolCard
							key={`${c.block.id}-${idx}`}
							run={toolRuns[c.block.id]}
							block={c.block}
						/>
					))}
					{calls.length > 3 && (
						<Pressable
							onPress={() => handleCollapse("bottom")}
							className="mt-2.5 flex-row items-center justify-center gap-1 rounded-xl bg-card-hover py-2 active:opacity-75"
						>
							<Text className="text-[11.5px] font-medium text-ink-muted">收起全部工具调用</Text>
							<Text className="text-[11px] text-ink-muted">▴</Text>
						</Pressable>
					)}
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

function ToolCard({
	run,
	block,
}: {
	run: ToolRun | undefined;
	block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
}) {
	const [open, setOpen] = useState(false);
	const status = run?.status ?? "running";

	const toggleOpen = () => {
		setOpen((v) => !v);
	};

	const summaryText = run?.summary ?? summarizeToolCall(block.name, block.arguments);

	// Render parameter text (matching desktop ToolCard args rendering)
	const argsText = useMemo(() => {
		const raw = block.arguments ?? {};
		if (typeof raw.command === "string") {
			return `$ ${raw.command}`;
		}
		if (Object.keys(raw).length > 0) {
			return JSON.stringify(raw, null, 2);
		}
		return "";
	}, [block.arguments]);

	const outputText = run?.output ?? "";

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
					<Text className="text-[10px] text-ink-faint">{open ? "▴" : "▾"}</Text>
				</View>
			</Pressable>
			{open && (
				<View className="mt-1.5 overflow-hidden rounded-xl bg-card p-2.5">
					<View className="gap-2">
						{Boolean(argsText) && (
							<View className="overflow-hidden rounded-xl border border-line bg-card">
								<View className="border-b border-line bg-elevated px-3 py-1.5">
									<Text className="font-mono text-[11px] text-ink-muted">输入参数 (Arguments)</Text>
								</View>
								<View className="px-3 py-2 bg-shell">
									<MobileCodeViewer code={argsText} />
								</View>
							</View>
						)}
						{outputText ? (
							<View className="overflow-hidden rounded-xl border border-line bg-card">
								<View className="border-b border-line bg-elevated px-3 py-1.5">
									<Text className="font-mono text-[11px] text-ink-muted">执行结果 (Output)</Text>
								</View>
								<View className="px-3 py-2 bg-shell">
									<MobileCodeViewer code={outputText} />
								</View>
							</View>
						) : (
							status === "running" && (
								<Text className="text-[12px] text-ink-faint">等待输出…</Text>
							)
						)}
					</View>
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
	const [now, setNow] = useState(() => Date.now());
	const [tick, setTick] = useState(0);
	const storeTurnStartedAt = useMobile((s) => s.turnStartedAt);
	const storeTurnTokens = useMobile((s) => s.turnTokens);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 250);
		const words = setInterval(() => setTick((n) => n + 1), 4200);
		return () => {
			clearInterval(timer);
			clearInterval(words);
		};
	}, []);

	const runs = Object.values(toolRuns);
	const running = runs.find((r) => r.status === "running");
	const latest = running ?? runs[runs.length - 1];
	const fresh = Boolean(latest);

	const lastMsg = messages[messages.length - 1];
	const isWriting =
		lastMsg?.role === "assistant" &&
		lastMsg.stopReason === "pending" &&
		lastMsg.content.some((c) => c.type === "text" && c.text.length > 0);

	const elapsed = storeTurnStartedAt ? now - storeTurnStartedAt : 0;
	const mood: Mood = moodFor(fresh ? latest?.toolName : undefined, fresh ? latest?.summary : undefined, false, isWriting);
	const phrase = phraseFor(mood, tick, elapsed);
	return (
		<View className="flex-row items-center justify-between bg-sidebar/95 px-4 py-2">
			<View className="flex-1 flex-row items-center gap-2.5">
				<MobileThinkingOrb state={mood} size={20} />
				<Text className="text-[12.5px] font-medium text-ink" numberOfLines={1}>
					{phrase}…
				</Text>
			</View>
			<Text className="font-mono text-[11.5px] text-ink-faint">
				{formatElapsed(elapsed)}{storeTurnTokens > 0 ? ` · ${formatTokens(storeTurnTokens)} tokens` : ""}
			</Text>
		</View>
	);
}
