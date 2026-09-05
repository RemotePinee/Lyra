import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Animated,
	BackHandler,
	PanResponder,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	getGitCache,
	setGitBranchesCache,
	setGitHistoryCache,
	setGitStatusCache,
} from "./gitCache";
import { MobileGitBranchesTab } from "./MobileGitBranchesTab";
import { MobileGitChangesTab } from "./MobileGitChangesTab";
import { MobileGitHistoryTab } from "./MobileGitHistoryTab";
import { MobileGitTabNav, type GitTab } from "./MobileGitTabNav";
import type { BranchList, GitCommit, GitStatus } from "./protocol";
import { useMobile } from "./store";
import { useThemeColors } from "./theme";

interface Props {
	visible: boolean;
	onClose: () => void;
	cwd?: string;
}

export function MobileGitStatusModal({ visible, onClose, cwd }: Props) {
	const { colors } = useThemeColors();
	const client = useMobile((s) => s.client);

	const animTranslateY = useRef(new Animated.Value(600)).current;
	const animBackdropOpacity = useRef(new Animated.Value(0)).current;

	const [activeTab, setActiveTab] = useState<GitTab>("changes");
	const [loading, setLoading] = useState(false);
	const [actionPending, setActionPending] = useState(false);

	// Tab states with cache warm-up (0ms instant render)
	const initialCache = cwd ? getGitCache(cwd) : undefined;
	const [status, setStatus] = useState<GitStatus | null>(initialCache?.status ?? null);
	const [commits, setCommits] = useState<GitCommit[]>(initialCache?.commits ?? []);
	const [hasLoadedHistory, setHasLoadedHistory] = useState(Boolean(initialCache?.commits?.length));
	const [branchList, setBranchList] = useState<BranchList | null>(initialCache?.branchList ?? null);
	const [hasLoadedBranches, setHasLoadedBranches] = useState(Boolean(initialCache?.branchList));

	const loadStatus = useCallback(async (silent = false) => {
		if (!client || !cwd) return;
		// If we already have cache, don't show blocking spinner, silently revalidate
		if (!silent && !getGitCache(cwd)?.status) setLoading(true);
		try {
			const res = await client.gitStatus(cwd);
			setStatus(res);
			setGitStatusCache(cwd, res);
		} catch {
			if (!getGitCache(cwd)?.status) setStatus(null);
		} finally {
			setLoading(false);
		}
	}, [client, cwd]);

	const loadHistory = useCallback(async (silent = false) => {
		if (!client || !cwd) return;
		if (!silent && !getGitCache(cwd)?.commits?.length) setHasLoadedHistory(false);
		try {
			const res = await client.gitLog(cwd, 40);
			setCommits(res);
			setHasLoadedHistory(true);
			setGitHistoryCache(cwd, res);
		} catch {
			if (!getGitCache(cwd)?.commits?.length) setCommits([]);
		}
	}, [client, cwd]);

	const loadBranches = useCallback(async (silent = false) => {
		if (!client || !cwd) return;
		if (!silent && !getGitCache(cwd)?.branchList) setHasLoadedBranches(false);
		try {
			const res = await client.gitBranches(cwd);
			setBranchList(res);
			setHasLoadedBranches(true);
			setGitBranchesCache(cwd, res);
		} catch {
			if (!getGitCache(cwd)?.branchList) setBranchList(null);
		}
	}, [client, cwd]);

	useEffect(() => {
		if (visible) {
			void loadStatus();
			void loadHistory(true);
			void loadBranches(true);
		}
	}, [visible, loadStatus, loadHistory, loadBranches]);

	const totalChanges = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);

	useEffect(() => {
		if (visible) {
			animTranslateY.setValue(600);
			animBackdropOpacity.setValue(0);
			Animated.parallel([
				Animated.timing(animTranslateY, {
					toValue: 0,
					duration: 220,
					useNativeDriver: true,
				}),
				Animated.timing(animBackdropOpacity, {
					toValue: 1,
					duration: 200,
					useNativeDriver: true,
				}),
			]).start();
		}
	}, [visible, animTranslateY, animBackdropOpacity]);

	const handleClose = useCallback(() => {
		Animated.parallel([
			Animated.timing(animTranslateY, {
				toValue: 650,
				duration: 180,
				useNativeDriver: true,
			}),
			Animated.timing(animBackdropOpacity, {
				toValue: 0,
				duration: 180,
				useNativeDriver: true,
			}),
		]).start(() => {
			onClose();
		});
	}, [animTranslateY, animBackdropOpacity, onClose]);

	const panResponder = useRef(
		PanResponder.create({
			onStartShouldSetPanResponder: () => true,
			onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 5,
			onPanResponderMove: (_, gestureState) => {
				if (gestureState.dy > 0) {
					animTranslateY.setValue(gestureState.dy);
				}
			},
			onPanResponderRelease: (_, gestureState) => {
				if (gestureState.dy > 120 || gestureState.vy > 0.8) {
					handleClose();
				} else {
					Animated.spring(animTranslateY, {
						toValue: 0,
						tension: 300,
						friction: 25,
						useNativeDriver: true,
					}).start();
				}
			},
		}),
	).current;

	useEffect(() => {
		if (!visible) return;
		const sub = BackHandler.addEventListener("hardwareBackPress", () => {
			handleClose();
			return true;
		});
		return () => sub.remove();
	}, [visible, handleClose]);

	if (!visible) return null;

	return (
		<View
			style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}
			pointerEvents="box-none"
		>
			{/* Backdrop */}
			<Animated.View
				style={[
					StyleSheet.absoluteFill,
					{
						backgroundColor: "rgba(0, 0, 0, 0.4)",
						opacity: animBackdropOpacity,
					},
				]}
			>
				<Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
			</Animated.View>

			{/* Sheet Container */}
			<View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
				<Animated.View
					style={{
						height: "94%",
						backgroundColor: colors.shell,
						borderTopLeftRadius: 24,
						borderTopRightRadius: 24,
						transform: [{ translateY: animTranslateY }],
						overflow: "hidden",
						paddingHorizontal: 16,
						paddingBottom: 24,
						paddingTop: 8,
					}}
				>
					{/* Card drag indicator pill & handle area */}
					<View
						{...panResponder.panHandlers}
						className="items-center pb-2 pt-1"
						hitSlop={{ top: 10, bottom: 15, left: 60, right: 60 }}
					>
						<View className="h-1.5 w-10 rounded-full bg-white/30" />
					</View>

					{/* Top Header */}
					<View className="flex-row items-center justify-between pb-2 pt-0.5">
						<View className="flex-row items-center gap-2">
							<Text className="text-[16.5px] font-semibold text-ink">Git 控制台</Text>
							{actionPending && <ActivityIndicator size="small" />}
						</View>
						<Pressable
							onPress={handleClose}
							className="rounded-full bg-card px-3 py-1 active:bg-card-hover"
						>
							<Text className="text-[12.5px] font-medium text-ink">完成</Text>
						</Pressable>
					</View>

					{/* Tabs */}
					<MobileGitTabNav
						activeTab={activeTab}
						totalChanges={totalChanges}
						onSelectTab={setActiveTab}
					/>

					{loading && !status ? (
						<View className="flex-1 items-center justify-center">
							<ActivityIndicator size="small" />
							<Text className="mt-3 text-[13px] text-ink-faint">正在获取仓库状态…</Text>
						</View>
					) : !status?.branch ? (
						<View className="flex-1 items-center justify-center p-6">
							<Text className="text-[14px] text-ink-faint">当前工作区不是 Git 仓库</Text>
						</View>
					) : (
						<View className="flex-1">
							{/* Tab 1: Changes */}
							<View style={{ flex: 1, display: activeTab === "changes" ? "flex" : "none" }}>
								<MobileGitChangesTab
									status={status}
									cwd={cwd}
									client={client}
									actionPending={actionPending}
									setActionPending={setActionPending}
									onReloadStatus={() => loadStatus(true)}
									onReloadHistory={loadHistory}
								/>
							</View>

							{/* Tab 2: History */}
							<View style={{ flex: 1, display: activeTab === "history" ? "flex" : "none" }}>
								<MobileGitHistoryTab
									commits={commits}
									hasLoadedHistory={hasLoadedHistory}
									onReloadHistory={loadHistory}
								/>
							</View>

							{/* Tab 3: Branches */}
							<View style={{ flex: 1, display: activeTab === "branches" ? "flex" : "none" }}>
								<MobileGitBranchesTab
									currentBranch={status.branch}
									branchList={branchList}
									hasLoadedBranches={hasLoadedBranches}
									cwd={cwd}
									client={client}
									actionPending={actionPending}
									setActionPending={setActionPending}
									onReloadBranches={loadBranches}
									onReloadStatus={() => loadStatus(true)}
									onReloadHistory={loadHistory}
								/>
							</View>
						</View>
					)}
				</Animated.View>
			</View>
		</View>
	);
}
