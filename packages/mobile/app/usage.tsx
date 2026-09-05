import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useMobile } from "../src/store";
import { type Range, summarise, type UsageScan } from "../src/usage";

function formatTokens(count: number): string {
	if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(2)}B`;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(0)}k`;
	return String(count);
}

export default function UsageScreen() {
	const fetchUsage = useMobile((s) => s.fetchUsage);
	const [scan, setScan] = useState<UsageScan | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [range, setRange] = useState<Range>(7);

	const load = useCallback(async () => {
		const res = await fetchUsage();
		setScan(res);
	}, [fetchUsage]);

	useEffect(() => {
		let active = true;
		void (async () => {
			setLoading(true);
			const res = await fetchUsage();
			if (active) {
				setScan(res);
				setLoading(false);
			}
		})();
		return () => {
			active = false;
		};
	}, [fetchUsage]);

	const onRefresh = useCallback(async () => {
		setRefreshing(true);
		await load();
		setRefreshing(false);
	}, [load]);

	const now = useMemo(() => new Date(), []);
	const summary = useMemo(() => {
		if (!scan) return null;
		return summarise(scan, range, now);
	}, [scan, range, now]);

	return (
		<View className="flex-1 bg-shell">
			<ScrollView
				className="flex-1"
				contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#9a9a9a" />}
			>
				{/* Range Tabs: 7天 / 30天 / 全部 */}
				<View className="mb-4 flex-row rounded-xl bg-card p-1">
					{([7, 30, 0] as const).map((r) => {
						const active = range === r;
						const label = r === 0 ? "全部" : `${r} 天`;
						return (
							<Pressable
								key={r}
								onPress={() => setRange(r)}
								className={`flex-1 items-center justify-center rounded-lg py-1.5 ${
									active ? "bg-card-hover" : ""
								}`}
							>
								<Text className={`text-[13px] font-medium ${active ? "text-ink" : "text-ink-muted"}`}>
									{label}
								</Text>
							</Pressable>
						);
					})}
				</View>

				{loading && !scan && (
					<View className="mt-12 items-center justify-center">
						<ActivityIndicator color="#9a9a9a" />
						<Text className="mt-3 text-[13px] text-ink-faint">正在统计本地用量…</Text>
					</View>
				)}

				{!loading && !scan && (
					<View className="mt-12 items-center justify-center">
						<Text className="text-[13.5px] text-ink-faint">未能获取用量数据，请确保桌面端已连接</Text>
					</View>
				)}

				{summary && (
					<>
						{/* Stat Grid */}
						<View className="mb-4 flex-row gap-3">
							<View className="flex-1 rounded-2xl bg-card p-4">
								<Text className="text-[12px] font-medium text-ink-faint">Tokens 用量</Text>
								<Text className="mt-1.5 font-mono text-[22px] font-bold text-ink">
									{formatTokens(summary.totals.tokens)}
								</Text>
								<Text className="mt-1 text-[11px] text-ink-faint">
									输入 {formatTokens(summary.totals.input)} / 输出 {formatTokens(summary.totals.output)}
								</Text>
							</View>
							<View className="flex-1 rounded-2xl bg-card p-4">
								<Text className="text-[12px] font-medium text-ink-faint">缓存命中</Text>
								<Text className="mt-1.5 font-mono text-[22px] font-bold text-ok">
									{summary.totals.input + summary.totals.cacheRead > 0
										? `${Math.round((summary.totals.cacheRead / (summary.totals.input + summary.totals.cacheRead)) * 100)}%`
										: "0%"}
								</Text>
								<Text className="mt-1 text-[11px] text-ink-faint">
									读取 {formatTokens(summary.totals.cacheRead)}
								</Text>
							</View>
						</View>

						{/* Activity Info */}
						<View className="mb-5 flex-row items-center justify-between rounded-2xl bg-card px-4 py-3">
							<View>
								<Text className="text-[13px] font-medium text-ink">连续活跃</Text>
								<Text className="text-[11.5px] text-ink-faint">今日或昨日有记录</Text>
							</View>
							<Text className="font-mono text-[18px] font-bold text-ok">
								{summary.streak} 天
							</Text>
						</View>

						{/* Models Ranking */}
						<Text className="mb-2.5 px-1 text-[12.5px] font-medium text-ink-muted">模型消耗排行</Text>
						<View className="overflow-hidden rounded-2xl bg-card">
							{summary.models.length === 0 && (
								<View className="py-6 items-center">
									<Text className="text-[12.5px] text-ink-faint">此时间段暂无模型用量记录</Text>
								</View>
							)}
							{summary.models.map((m) => (
								<View
									key={m.key}
									className="p-4"
								>
									<View className="flex-row items-center justify-between">
										<Text className="flex-1 text-[13.5px] font-medium text-ink" numberOfLines={1}>
											{m.model}
										</Text>
										<Text className="font-mono text-[13px] font-semibold text-ink">
											{formatTokens(m.tokens)} tokens
										</Text>
									</View>
									<View className="mt-1.5 flex-row items-center justify-between">
										<Text className="text-[11.5px] text-ink-faint">{m.provider}</Text>
										<Text className="font-mono text-[11.5px] text-ink-faint">
											占比 {Math.round(m.share * 100)}%
										</Text>
									</View>
									{/* Share Bar */}
									<View className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-card-hover">
										<View
											className="h-full rounded-full bg-accent"
											style={{ width: `${Math.max(2, Math.round(m.share * 100))}%` }}
										/>
									</View>
								</View>
							))}
						</View>
					</>
				)}
			</ScrollView>
		</View>
	);
}
