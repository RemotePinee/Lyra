import { CameraView, useCameraPermissions } from "expo-camera";
import { Link, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Image,
	Modal,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import type Swipeable from "react-native-gesture-handler/Swipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../src/haptics";
import { MobileConfirmDialog } from "../src/MobileDialog";
import type { SessionMeta } from "../src/protocol";
import { useMobile } from "../src/store";
import { SwipeableSessionRow } from "../src/SwipeableSessionRow";
import { SessionActivityBadge } from "../src/SessionActivityBadge";
import { useThemeColors } from "../src/theme";

const appIcon = require("../assets/logo.png");

type ViewTab = "projects" | "chats";

interface RecencyBand {
	key: string;
	label: string;
	sessions: SessionMeta[];
}

function daysBetween(now: number, then: number): number {
	const midnight = (ms: number) => {
		const date = new Date(ms);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	};
	return Math.round((midnight(now) - midnight(then)) / 86_400_000);
}

function bandByRecency(sessions: SessionMeta[]): RecencyBand[] {
	const now = Date.now();
	const cuts: { key: string; label: string; within: number }[] = [
		{ key: "today", label: "今天", within: 0 },
		{ key: "yesterday", label: "昨天", within: 1 },
		{ key: "week", label: "过去 7 天", within: 7 },
		{ key: "month", label: "过去 30 天", within: 30 },
	];

	const buckets = new Map<string, SessionMeta[]>();
	for (const cut of cuts) buckets.set(cut.key, []);
	buckets.set("older", []);

	for (const session of sessions) {
		const days = daysBetween(now, session.updatedAt);
		const cut = cuts.find((c) => days <= c.within);
		const key = cut ? cut.key : "older";
		buckets.get(key)!.push(session);
	}

	const labels = new Map(cuts.map((c) => [c.key, c.label]));
	labels.set("older", "更早");

	const result: RecencyBand[] = [];
	for (const [key, items] of buckets.entries()) {
		if (items.length > 0) {
			result.push({
				key,
				label: labels.get(key) ?? key,
				sessions: items,
			});
		}
	}
	return result;
}

function HeaderTitle({ onScanPress }: { onScanPress: () => void }) {
	const { colors } = useThemeColors();
	return (
		<View className="flex-1 flex-row items-center justify-between">
			<View className="flex-row items-center gap-3">
				<Image
					source={appIcon}
					style={{ width: 32, height: 32 }}
					resizeMode="contain"
				/>
				<Text style={{ fontSize: 22, fontWeight: "700", color: colors.ink, letterSpacing: 0.3 }}>Lyra</Text>
			</View>

			{/* QR Code Scan Button on the far right */}
			<Pressable
				onPress={() => {
					haptic.impact();
					onScanPress();
				}}
				hitSlop={8}
				className="h-10 w-10 items-center justify-center rounded-full bg-card active:bg-card-hover"
			>
				<View className="h-6 w-6 items-center justify-center">
					<View className="h-[20px] w-[20px] justify-between p-[1px]">
						<View className="flex-row justify-between">
							<View className="h-[6px] w-[6px] border-t-2 border-l-2 border-ink" />
							<View className="h-[6px] w-[6px] border-t-2 border-r-2 border-ink" />
						</View>
						<View className="h-[5px] w-[5px] self-center rounded-[1px] bg-accent" />
						<View className="flex-row justify-between">
							<View className="h-[6px] w-[6px] border-b-2 border-l-2 border-ink" />
							<View className="h-[6px] w-[6px] border-b-2 border-r-2 border-ink" />
						</View>
					</View>
				</View>
			</Pressable>
		</View>
	);
}

export default function SessionListScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { colors } = useThemeColors();
	const hydrated = useMobile((s) => s.hydrated);
	const connection = useMobile((s) => s.connection);
	const sessions = useMobile((s) => s.sessions);
	const loading = useMobile((s) => s.loadingSessions);
	const socketState = useMobile((s) => s.socketState);
	const error = useMobile((s) => s.error);
	const refresh = useMobile((s) => s.refreshSessions);
	const openSession = useMobile((s) => s.openSession);
	const sessionActivities = useMobile((s) => s.sessionActivities);

	const [refreshing, setRefreshing] = useState(false);
	const [creating, setCreating] = useState<string | null>(null);
	const [viewTab, setViewTab] = useState<ViewTab>("projects");
	const [showArchived, setShowArchived] = useState(false);
	const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
	const settings = useMobile((s) => s.settings);
	const createSession = useMobile((s) => s.createSession);
	const archiveSession = useMobile((s) => s.archiveSession);
	const deleteSession = useMobile((s) => s.deleteSession);
	const pair = useMobile((s) => s.pair);
	const projects = settings?.projects ?? [];
	const openSwipeableRef = useRef<Swipeable | null>(null);

	const closeOpenSwipeable = useCallback(() => {
		if (openSwipeableRef.current) {
			openSwipeableRef.current.close();
			openSwipeableRef.current = null;
		}
	}, []);

	// Scanner State
	const [scannerOpen, setScannerOpen] = useState(false);
	const [permission, requestPermission] = useCameraPermissions();
	const [scanned, setScanned] = useState(false);

	// Adaptive ActionSheet & Dialog States
	const [targetSession, setTargetSession] = useState<SessionMeta | null>(null);
	const [confirmDeleteVisible, setConfirmDeleteVisible] = useState(false);
	const [dialogAlert, setDialogAlert] = useState<{ visible: boolean; title: string; message: string }>({
		visible: false,
		title: "",
		message: "",
	});

	const showModalAlert = (title: string, message: string) => {
		setDialogAlert({ visible: true, title, message });
	};

	const toggleProjectCollapse = (projectId: string) => {
		setCollapsedProjects((prev) => ({
			...prev,
			[projectId]: !prev[projectId],
		}));
	};

	const handleHomeScanPress = useCallback(async () => {
		if (!permission?.granted) {
			const res = await requestPermission();
			if (!res.granted) {
				showModalAlert("权限不足", "需要相机权限以扫描桌面端二维码");
				return;
			}
		}
		setScanned(false);
		setScannerOpen(true);
	}, [permission, requestPermission]);

	const handleBarcodeScanned = useCallback(
		async ({ data }: { data: string }) => {
			if (scanned) return;
			setScanned(true);
			const text = data.trim();
			const match = /lyra:\/\/pair\?(.*)/.exec(text);
			if (!match) {
				showModalAlert("扫码失败", "未识别到有效的 Lyra 配对二维码");
				setScannerOpen(false);
				return;
			}
			const params = new URLSearchParams(match[1]);
			const host = params.get("host");
			const port = Number.parseInt(params.get("port") ?? "4517", 10);
			const token = params.get("token");
			if (!host || !token) {
				showModalAlert("扫码失败", "二维码缺少主机地址或配对令牌");
				setScannerOpen(false);
				return;
			}
			setScannerOpen(false);
			try {
				await pair({ host, port, token });
				showModalAlert("连接成功", `已连接至桌面端 ${host}:${port}`);
			} catch (err) {
				showModalAlert("连接失败", err instanceof Error ? err.message : "未知错误");
			}
		},
		[scanned, pair],
	);

	useEffect(() => {
		if (!connection) return;
		const timer = setInterval(() => void refresh(), 15000);
		return () => clearInterval(timer);
	}, [connection, refresh]);

	const onRefresh = useCallback(async () => {
		setRefreshing(true);
		await refresh();
		setRefreshing(false);
	}, [refresh]);

	const handleDeleteTrigger = useCallback((session: SessionMeta) => {
		setTargetSession(session);
		setConfirmDeleteVisible(true);
	}, []);

	if (!hydrated) {
		return (
			<View className="flex-1 items-center justify-center bg-shell">
				<ActivityIndicator color="#9a9a9a" />
			</View>
		);
	}

	if (!connection) return <NotPaired />;

	const filteredSessions = sessions.filter((s) => (showArchived ? !!s.archived : !s.archived));
	const grouped = groupByProject(filteredSessions);
	const recencyBands = bandByRecency(filteredSessions);
	const hasArchivedSessions = sessions.some((s) => s.archived);

	return (
		<View style={{ flex: 1, backgroundColor: colors.shell, paddingTop: insets.top }}>
			{/* Header */}
			<View className="flex-row items-center justify-between px-4 py-2.5">
				<HeaderTitle onScanPress={handleHomeScanPress} />
			</View>

			<ScrollView
				className="flex-1 bg-shell"
				contentContainerStyle={{ padding: 16, paddingTop: 6, paddingBottom: 40 }}
				keyboardShouldPersistTaps="handled"
				onTouchStart={closeOpenSwipeable}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#9a9a9a" />}
			>
				{/* Connection Status & Fast Action Bar */}
				<View className="mb-4 flex-row items-center gap-2 px-1">
					<View
						className={`h-2 w-2 rounded-full ${
							socketState === "open" ? "bg-ok" : socketState === "connecting" ? "bg-accent" : "bg-danger"
						}`}
					/>
					<Text className="text-[12.5px] font-medium text-ink-muted">
						{socketState === "open" ? "已连接" : socketState === "connecting" ? "连接中…" : "已断开"}
					</Text>
					<Text className="text-[12px] font-mono text-ink-faint">
						{connection.host}:{connection.port}
					</Text>
					<View className="flex-1" />
					<Link href="/usage" asChild>
						<Pressable
							hitSlop={6}
							onPress={() => haptic.tap()}
							className="mr-2 h-8 w-8 items-center justify-center rounded-full bg-card active:bg-card-hover"
						>
							<View className="h-4 w-4 flex-row items-end justify-between px-0.5 pb-0.5">
								<View className="h-2 w-1 rounded-sm bg-ink-muted" />
								<View className="h-3.5 w-1 rounded-sm bg-accent" />
								<View className="h-2.5 w-1 rounded-sm bg-ink-muted" />
							</View>
						</Pressable>
					</Link>
					<Link href="/pair" asChild>
						<Pressable
							hitSlop={6}
							onPress={() => haptic.tap()}
							className="h-8 w-8 items-center justify-center rounded-full bg-card active:bg-card-hover"
						>
							<View className="h-4 w-4 items-center justify-center">
								<View className="h-3.5 w-3.5 rounded-full border-2 border-ink-muted items-center justify-center">
									<View className="h-1 w-1 rounded-full bg-ink-muted" />
								</View>
							</View>
						</Pressable>
					</Link>
				</View>

				{/* Quick New Session Project Chips */}
				{projects.length > 0 && (
					<View className="mb-5">
						<Text className="mb-2.5 px-1 text-[12px] font-medium tracking-wide text-ink-faint">新建会话</Text>
						<ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row">
							<View className="flex-row gap-2">
								{projects.map((project) => (
									<Pressable
										key={project.path}
										disabled={creating !== null}
										onPress={async () => {
											setCreating(project.path);
											try {
												const meta = await createSession(project.path);
												if (meta) {
													await openSession(meta);
													router.push(`/session/${meta.id}`);
												}
											} finally {
												setCreating(null);
											}
										}}
										className="flex-row items-center gap-2 rounded-xl bg-card px-3.5 py-2 active:bg-card-hover"
									>
										<Text className="text-[13px] font-medium text-ink">+ {project.name}</Text>
										{creating === project.path && <ActivityIndicator size="small" color="#9a9a9a" />}
									</Pressable>
								))}
							</View>
						</ScrollView>
					</View>
				)}

				{/* View Mode Segmented Controls: Projects vs Chats */}
				<View className="mb-4 flex-row items-center justify-between px-1">
					<View className="flex-row rounded-xl bg-card p-1">
						<Pressable
							onPress={() => {
								haptic.selection();
								setViewTab("projects");
							}}
							className={`rounded-lg px-3 py-1.5 ${viewTab === "projects" ? "bg-elevated" : "bg-transparent"}`}
						>
							<Text
								style={{
									fontSize: 13,
									fontWeight: viewTab === "projects" ? "600" : "500",
									color: viewTab === "projects" ? colors.ink : colors.inkMuted,
								}}
							>
								按项目
							</Text>
						</Pressable>
						<Pressable
							onPress={() => {
								haptic.selection();
								setViewTab("chats");
							}}
							className={`rounded-lg px-3 py-1.5 ${viewTab === "chats" ? "bg-elevated" : "bg-transparent"}`}
						>
							<Text
								style={{
									fontSize: 13,
									fontWeight: viewTab === "chats" ? "600" : "500",
									color: viewTab === "chats" ? colors.ink : colors.inkMuted,
								}}
							>
								按时间
							</Text>
						</Pressable>
					</View>

					{(hasArchivedSessions || showArchived) && (
						<Pressable
							onPress={() => setShowArchived((v) => !v)}
							className={`rounded-lg px-2.5 py-1.5 ${showArchived ? "bg-accent/15" : "bg-card"}`}
						>
							<Text
								style={{
									fontSize: 12,
									fontWeight: "500",
									color: showArchived ? colors.accent : colors.inkMuted,
								}}
							>
								{showArchived ? "退出归档" : "已归档"}
							</Text>
						</Pressable>
					)}
				</View>

				{error && (
					<View className="mb-4 rounded-xl bg-danger/10 px-4 py-3">
						<Text className="text-[13px] text-danger">{error}</Text>
					</View>
				)}

				{loading && sessions.length === 0 && <ActivityIndicator color="#9a9a9a" className="mt-8" />}

				{!loading && sessions.length === 0 && (
					<Text className="mt-16 text-center text-[13px] leading-6 text-ink-faint">
						桌面端还没有会话。{"\n"}在电脑上开始一个对话后下拉刷新。
					</Text>
				)}

				{/* 1. Projects View with Collapsible Sections */}
				{viewTab === "projects" &&
					grouped.map((group) => {
						const isCollapsed = !!collapsedProjects[group.projectId];
						return (
							<View key={group.projectId} className="mb-3 overflow-hidden rounded-2xl bg-card">
								<Pressable
									onPress={() => toggleProjectCollapse(group.projectId)}
									className="flex-row items-center justify-between px-4 py-3.5 active:bg-card-hover"
								>
									<View className="flex-row items-center gap-2.5">
										{/* Folder Glyph */}
										<View className="h-6 w-6 items-center justify-center rounded-lg bg-elevated">
											<View className="h-2.5 w-3.5 rounded-[2px] border border-ink-muted bg-transparent">
												<View className="h-[2px] w-[5px] rounded-t-[1px] bg-ink-muted -mt-[3px] ml-0.5" />
											</View>
										</View>
										<Text className="text-[14px] font-semibold text-ink">
											{group.projectName}
										</Text>
									</View>

									<View className="flex-row items-center gap-2">
										{/* Active running badge for collapsed group */}
										{(() => {
											const hasRunning = group.sessions.some(
												(s) => sessionActivities[s.id] === "running",
											);
											const hasWaiting = group.sessions.some(
												(s) => sessionActivities[s.id] === "waiting",
											);
											if (hasWaiting) {
												return <SessionActivityBadge activity="waiting" />;
											}
											if (hasRunning) {
												return <SessionActivityBadge activity="running" />;
											}
											return null;
										})()}
										<Text
											style={{
												fontSize: 12,
												fontWeight: "600",
												color: colors.inkMuted,
												includeFontPadding: false,
												textAlignVertical: "center",
											}}
										>
											{group.sessions.length}
										</Text>
										<View
											style={{
												width: 12,
												height: 12,
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											<View
												style={{
													width: 6,
													height: 6,
													borderTopWidth: 1.5,
													borderRightWidth: 1.5,
													borderColor: colors.inkFaint,
													transform: [{ rotate: isCollapsed ? "45deg" : "135deg" }],
													marginTop: isCollapsed ? 0 : -3,
												}}
											/>
										</View>
									</View>
								</Pressable>

								{!isCollapsed && (
									<View className="gap-1.5 p-2 pt-0">
										{group.sessions.map((session) => (
											<SwipeableSessionRow
												key={session.id}
												session={session}
												openRowRef={openSwipeableRef}
												onArchive={(s) => {
													void archiveSession(s, !s.archived);
												}}
												onDelete={handleDeleteTrigger}
											>
												<Pressable
													onPress={() => {
														if (openSwipeableRef.current) {
															closeOpenSwipeable();
															return;
														}
														void openSession(session);
														router.push(`/session/${session.id}`);
													}}
													className="rounded-xl bg-card px-3.5 py-3 active:bg-card-hover"
												>
													<View className="flex-row items-center justify-between gap-2">
														<Text className="flex-1 text-[13.5px] font-medium text-ink" numberOfLines={1}>
															{session.title}
														</Text>
														<SessionActivityBadge activity={sessionActivities[session.id]} />
													</View>
													<View className="mt-1.5 flex-row items-center gap-3">
														<Text className="text-[11.5px] text-ink-faint">{session.messageCount} 条消息</Text>
														<Text className="text-[11.5px] text-ink-faint">{formatTime(session.updatedAt)}</Text>
													</View>
												</Pressable>
											</SwipeableSessionRow>
										))}
									</View>
								)}
							</View>
						);
					})}

				{/* 2. Chats View (Recency Bands aligned with Desktop & NO lines) */}
				{viewTab === "chats" &&
					recencyBands.map((band) => (
						<View key={band.key} className="mb-4">
							<View className="flex-row items-center justify-between px-1 py-1.5">
								<Text className="text-[12.5px] font-semibold tracking-wide text-ink-muted">
									{band.label}
								</Text>
								<Text className="text-[11px] text-ink-faint">{band.sessions.length} 项</Text>
							</View>
							<View className="mt-1 gap-1.5">
								{band.sessions.map((session) => (
									<SwipeableSessionRow
										key={session.id}
										session={session}
										openRowRef={openSwipeableRef}
										onArchive={(s) => {
											void archiveSession(s, !s.archived);
										}}
										onDelete={handleDeleteTrigger}
									>
										<Pressable
											onPress={() => {
												if (openSwipeableRef.current) {
													closeOpenSwipeable();
													return;
												}
												void openSession(session);
												router.push(`/session/${session.id}`);
											}}
											className="rounded-2xl bg-card px-4 py-3 active:bg-card-hover"
										>
											<View className="flex-row items-center justify-between gap-2">
												<Text className="flex-1 text-[14px] font-medium text-ink" numberOfLines={1}>
													{session.title}
												</Text>
												<SessionActivityBadge activity={sessionActivities[session.id]} />
											</View>
											<View className="mt-1.5 flex-row items-center gap-3">
												<View className="rounded bg-shell px-1.5 py-0.5">
													<Text className="text-[11px] font-medium text-ink-muted">
														{session.projectName}
													</Text>
												</View>
												<Text className="text-[12px] text-ink-faint">{session.messageCount} 条消息</Text>
												<Text className="text-[12px] text-ink-faint">{formatTime(session.updatedAt)}</Text>
											</View>
										</Pressable>
									</SwipeableSessionRow>
								))}
							</View>
						</View>
					))}
			</ScrollView>

			{/* Fullscreen Scanner Modal */}
			<Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
				<View className="flex-1 bg-black">
					<CameraView
						style={StyleSheet.absoluteFill}
						facing="back"
						barcodeScannerSettings={{
							barcodeTypes: ["qr"],
						}}
						onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
					/>
					<View className="flex-1 items-center justify-between p-8 pt-16">
						<View className="rounded-full bg-black/60 px-5 py-2">
							<Text className="text-[14px] font-medium text-white">对准桌面端设置中的配对二维码</Text>
						</View>
						<View className="h-64 w-64 rounded-3xl border-2 border-accent bg-transparent" />
						<Pressable
							onPress={() => setScannerOpen(false)}
							className="rounded-full bg-white/20 px-8 py-3 backdrop-blur-md active:bg-white/30"
						>
							<Text className="text-[15px] font-medium text-white">取消扫码</Text>
						</Pressable>
					</View>
				</View>
			</Modal>

			{/* Adaptive High-Grade Confirm Delete Dialog */}
			{targetSession && (
				<MobileConfirmDialog
					visible={confirmDeleteVisible}
					title="删除会话"
					message={`确定要删除「${targetSession.title}」吗？此操作无法撤销。`}
					confirmText="删除"
					destructive
					onConfirm={() => {
						void deleteSession(targetSession);
					}}
					onCancel={() => setConfirmDeleteVisible(false)}
				/>
			)}

			{/* Adaptive Notice Dialog */}
			<MobileConfirmDialog
				visible={dialogAlert.visible}
				title={dialogAlert.title}
				message={dialogAlert.message}
				confirmText="知道了"
				cancelText=""
				onConfirm={() => setDialogAlert((prev) => ({ ...prev, visible: false }))}
				onCancel={() => setDialogAlert((prev) => ({ ...prev, visible: false }))}
			/>
		</View>
	);
}

const appLogo = require("../assets/logo.png");

function NotPaired() {
	return (
		<View className="flex-1 items-center justify-center bg-shell px-8">
			<Image
				source={appLogo}
				style={{ width: 80, height: 80, marginBottom: 20 }}
				resizeMode="contain"
			/>
			<Text className="text-center text-[22px] font-semibold text-ink">连接你的桌面端</Text>
			<Text className="mt-3 text-center text-[13.5px] leading-6 text-ink-muted">
				Lyra 的文件、终端和 MCP 都跑在电脑上。{"\n"}
				手机连上以后可以查看进行中的回合、批准操作、继续追问。
			</Text>
			<Link href="/pair" asChild>
				<Pressable className="mt-8 rounded-xl bg-ink px-5 py-3 active:opacity-85">
					<Text className="text-[14px] font-medium text-shell">开始配对</Text>
				</Pressable>
			</Link>
			<Text className="mt-6 text-center text-[12px] leading-5 text-ink-faint">
				在桌面端打开「设置 → 移动端同步」{"\n"}启用服务后即可看到地址和令牌
			</Text>
		</View>
	);
}

function groupByProject(sessions: SessionMeta[]) {
	const map = new Map<string, { projectId: string; projectName: string; sessions: SessionMeta[] }>();
	for (const session of sessions) {
		const group = map.get(session.projectId) ?? {
			projectId: session.projectId,
			projectName: session.projectName,
			sessions: [],
		};
		group.sessions.push(session);
		map.set(session.projectId, group);
	}
	return [...map.values()];
}

function formatTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
