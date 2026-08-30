import { Link, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { SessionMeta } from "../src/protocol";
import { useMobile } from "../src/store";

export default function SessionListScreen() {
	const router = useRouter();
	const hydrated = useMobile((s) => s.hydrated);
	const connection = useMobile((s) => s.connection);
	const sessions = useMobile((s) => s.sessions);
	const loading = useMobile((s) => s.loadingSessions);
	const socketState = useMobile((s) => s.socketState);
	const error = useMobile((s) => s.error);
	const refresh = useMobile((s) => s.refreshSessions);
	const openSession = useMobile((s) => s.openSession);

	const [refreshing, setRefreshing] = useState(false);
	const [creating, setCreating] = useState<string | null>(null);
	const [navigatingId, setNavigatingId] = useState<string | null>(null);
	const settings = useMobile((s) => s.settings);
	const createSession = useMobile((s) => s.createSession);
	const activeSessionId = useMobile((s) => s.activeSession?.id ?? null);
	const projects = settings?.projects ?? [];

	// Poll while the app is foregrounded so a session started on the desktop shows up here.
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

	if (!hydrated) {
		return (
			<View className="flex-1 items-center justify-center bg-shell">
				<ActivityIndicator color="#9a9a9a" />
			</View>
		);
	}

	if (!connection) return <NotPaired />;

	/*
	 * Same rule as the desktop sidebar: a session with no messages has no title and nothing to
	 * return to, so it is not a row worth showing. The one you are currently in is exempt —
	 * it may be brand new with its first message still on the way.
	 */
	const grouped = groupByProject(sessions.filter((s) => s.messageCount > 0 || s.id === activeSessionId));

	return (
		<ScrollView
			className="flex-1 bg-shell"
			contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#9a9a9a" />}
		>
			<View className="mb-4 flex-row items-center gap-2">
				<View
					className={`h-2 w-2 rounded-full ${
						socketState === "open" ? "bg-ok" : socketState === "connecting" ? "bg-accent" : "bg-danger"
					}`}
				/>
				<Text className="text-[13px] text-ink-muted">
					{socketState === "open" ? "已连接" : socketState === "connecting" ? "连接中…" : "已断开，正在重试"}
				</Text>
				<Text className="text-[13px] text-ink-faint">
					{connection.host}:{connection.port}
				</Text>
				<View className="flex-1" />
				<Link href="/pair" asChild>
					<Pressable className="rounded-lg border border-line px-2.5 py-1">
						<Text className="text-[12px] text-ink-muted">设置</Text>
					</Pressable>
				</Link>
			</View>

			{projects.length > 0 && (
				<View className="mb-5">
					<Text className="mb-2 px-1 text-[12px] text-ink-faint">新建会话</Text>
					<View className="flex-row flex-wrap gap-2">
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
								className="flex-row items-center gap-1.5 rounded-xl border border-line bg-card/40 px-3 py-2 active:bg-card-hover"
							>
								<Text className="text-[13px] text-ink">+ {project.name}</Text>
								{creating === project.path && <ActivityIndicator size="small" color="#9a9a9a" />}
							</Pressable>
						))}
					</View>
				</View>
			)}

			{error && (
				<View className="mb-4 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3">
					<Text className="text-[13px] text-danger">{error}</Text>
				</View>
			)}

			{loading && sessions.length === 0 && <ActivityIndicator color="#9a9a9a" className="mt-8" />}

			{!loading && sessions.length === 0 && (
				<Text className="mt-16 text-center text-[13px] leading-6 text-ink-faint">
					桌面端还没有会话。{"\n"}在电脑上开始一个对话后下拉刷新。
				</Text>
			)}

			{grouped.map((group) => (
				<View key={group.projectId} className="mb-6">
					<Text className="mb-2 px-1 text-[12px] text-ink-faint">{group.projectName}</Text>
					<View className="overflow-hidden rounded-xl border border-line bg-card/40">
						{group.sessions.map((session, index) => {
							const isNavigating = navigatingId === session.id;
							return (
								<Pressable
									key={session.id}
									onPress={() => {
										setNavigatingId(session.id);
										void openSession(session);
										router.push(`/session/${session.id}`);
										// Reset active press feedback shortly after route transition triggers
										setTimeout(() => setNavigatingId(null), 500);
									}}
									className={`px-3.5 py-3 ${isNavigating ? "bg-card-hover/90" : "active:bg-card-hover"} ${index > 0 ? "border-t border-line-soft" : ""}`}
								>
									<View className="flex-row items-center justify-between gap-2">
										<Text className="flex-1 text-[14px] text-ink" numberOfLines={1}>
											{session.title}
										</Text>
										{isNavigating && <ActivityIndicator size="small" color="#9a9a9a" />}
									</View>
									<View className="mt-1 flex-row items-center gap-3">
										<Text className="text-[11.5px] text-ink-faint">{session.messageCount} 条消息</Text>
										<Text className="text-[11.5px] text-ink-faint">{formatTime(session.updatedAt)}</Text>
										{session.usage.cost.total > 0 && (
											<Text className="text-[11.5px] text-ink-faint">${session.usage.cost.total.toFixed(4)}</Text>
										)}
									</View>
								</Pressable>
							);
						})}
					</View>
				</View>
			))}
		</ScrollView>
	);
}

function NotPaired() {
	return (
		<View className="flex-1 items-center justify-center bg-shell px-8">
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
