import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Animated,
	BackHandler,
	PanResponder,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { MobileCodeViewer } from "./MobileCodeViewer";
import type { RemoteFileContents, RemoteFileEntry } from "./protocol";
import { useMobile } from "./store";

interface FileViewerModalProps {
	visible: boolean;
	rootPath?: string;
	onClose: () => void;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

export function MobileFileViewerModal({ visible, rootPath, onClose }: FileViewerModalProps) {
	const listFiles = useMobile((s) => s.listFiles);
	const readFile = useMobile((s) => s.readFile);

	const animTranslateY = useRef(new Animated.Value(600)).current;
	const animBackdropOpacity = useRef(new Animated.Value(0)).current;

	const [currentDir, setCurrentDir] = useState<string>("");
	const [dirHistory, setDirHistory] = useState<string[]>([]);
	const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
	const [loading, setLoading] = useState(false);

	// File reading preview state
	const [selectedFile, setSelectedFile] = useState<{ name: string; path: string } | null>(null);
	const [fileContents, setFileContents] = useState<RemoteFileContents | null>(null);
	const [fileLoading, setFileLoading] = useState(false);

	useEffect(() => {
		if (visible && rootPath) {
			setCurrentDir(rootPath);
			setDirHistory([]);
			setSelectedFile(null);
			setFileContents(null);
		}
	}, [visible, rootPath]);

	const loadDir = useCallback(
		async (dir: string) => {
			if (!dir) return;
			setLoading(true);
			const res = await listFiles(dir);
			setEntries(res);
			setLoading(false);
		},
		[listFiles],
	);

	useEffect(() => {
		if (visible && currentDir) {
			void loadDir(currentDir);
		}
	}, [visible, currentDir, loadDir]);

	const handleEntryPress = async (entry: RemoteFileEntry) => {
		if (entry.isDirectory) {
			setDirHistory((prev) => [...prev, currentDir]);
			setCurrentDir(entry.path);
		} else {
			setSelectedFile({ name: entry.name, path: entry.path });
			setFileLoading(true);
			const res = await readFile(entry.path);
			setFileContents(res);
			setFileLoading(false);
		}
	};

	const segments = currentDir.split(/[\\/]/).filter(Boolean);
	const currentDirName = segments.length > 0 ? segments[segments.length - 1] : "项目根目录";

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

	const handleGoBack = useCallback(() => {
		if (selectedFile) {
			setSelectedFile(null);
			setFileContents(null);
			return;
		}
		if (dirHistory.length > 0) {
			const previous = dirHistory[dirHistory.length - 1];
			setDirHistory((prev) => prev.slice(0, -1));
			setCurrentDir(previous);
		} else {
			handleClose();
		}
	}, [selectedFile, dirHistory, handleClose]);

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
			if (selectedFile || dirHistory.length > 0) {
				handleGoBack();
			} else {
				handleClose();
			}
			return true;
		});
		return () => sub.remove();
	}, [visible, selectedFile, dirHistory, handleClose, handleGoBack]);

	if (!visible) return null;

	return (
		<View
			style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}
			pointerEvents="box-none"
		>
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

			<View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
				<Animated.View
					style={{
						height: "85%",
						transform: [{ translateY: animTranslateY }],
						borderTopLeftRadius: 24,
						borderTopRightRadius: 24,
						padding: 20,
						paddingBottom: 32,
						shadowColor: "#000",
						shadowOffset: { width: 0, height: -4 },
						shadowOpacity: 0.15,
						shadowRadius: 12,
						elevation: 20,
					}}
					className="bg-shell"
				>
					{/* Card drag indicator pill & handle area */}
					<View
						{...panResponder.panHandlers}
						className="items-center pb-3 pt-0"
						hitSlop={{ top: 10, bottom: 15, left: 60, right: 60 }}
					>
						<View className="h-1.5 w-10 rounded-full bg-white/30" />
					</View>

					{/* Header */}
					<View className="flex-row items-center justify-between pb-3.5">
						<View className="flex-1 pr-3">
							<View className="flex-row items-center gap-2">
								{(dirHistory.length > 0 || selectedFile) && (
									<Pressable onPress={handleGoBack} className="rounded-lg bg-card px-2 py-1 active:bg-card-hover">
										<Text className="text-[12px] font-medium text-ink-muted">← 返回</Text>
									</Pressable>
								)}
								<Text className="flex-1 text-[16.5px] font-bold text-ink" numberOfLines={1}>
									{selectedFile ? selectedFile.name : currentDirName}
								</Text>
							</View>
							<Text className="mt-0.5 font-mono text-[11px] text-ink-faint" numberOfLines={1}>
								{selectedFile ? selectedFile.path : currentDir}
							</Text>
						</View>
						<Pressable onPress={handleClose} className="rounded-full bg-card px-3 py-1.5 active:bg-card-hover">
							<Text className="text-[13px] font-medium text-ink-muted">关闭</Text>
						</Pressable>
					</View>

					{/* File Content Preview */}
					{selectedFile ? (
						<View className="flex-1 pt-3">
							{fileLoading ? (
								<View className="flex-1 items-center justify-center">
									<ActivityIndicator color="#9a9a9a" />
									<Text className="mt-2.5 text-[12.5px] text-ink-faint">读取文件中…</Text>
								</View>
							) : fileContents?.binary ? (
								<View className="flex-1 items-center justify-center p-6">
									<Text className="text-[14px] font-medium text-ink">二进制文件</Text>
									<Text className="mt-1.5 text-[12px] text-ink-faint">
										大小: {formatBytes(fileContents.bytes)}，暂不支持直接预览
									</Text>
								</View>
							) : fileContents ? (
								<View className="flex-1 overflow-hidden rounded-2xl bg-[#0d1117] p-2">
									{fileContents.truncated && (
										<View className="mb-2 rounded-lg bg-accent/10 px-3 py-1.5">
											<Text className="text-[11.5px] text-accent">文件过大，仅显示前 512KB 内容</Text>
										</View>
									)}
									<MobileCodeViewer code={fileContents.text} fileName={selectedFile.name} />
								</View>
							) : (
								<View className="flex-1 items-center justify-center">
									<Text className="text-[13px] text-ink-faint">未能读取该文件内容</Text>
								</View>
							)}
						</View>
					) : (
						/* Directory File List */
						<View className="flex-1 pt-2">
							{loading ? (
								<View className="flex-1 items-center justify-center">
									<ActivityIndicator color="#9a9a9a" />
								</View>
							) : entries.length === 0 ? (
								<View className="flex-1 items-center justify-center">
									<Text className="text-[13px] text-ink-faint">空目录</Text>
								</View>
							) : (
								<ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
									<View className="overflow-hidden rounded-2xl bg-card">
										{entries.map((entry) => (
											<Pressable
												key={entry.path}
												onPress={() => void handleEntryPress(entry)}
												className="flex-row items-center justify-between p-3.5 active:bg-card-hover"
											>
												<View className="flex-1 flex-row items-center gap-2.5 pr-2">
													<Text className="text-[15px]">{entry.isDirectory ? "📁" : "📄"}</Text>
													<Text className="flex-1 text-[13.5px] font-medium text-ink" numberOfLines={1}>
														{entry.name}
													</Text>
												</View>
												<Text className="font-mono text-[11.5px] text-ink-faint">
													{entry.isDirectory ? "目录" : formatBytes(entry.size)}
												</Text>
											</Pressable>
										))}
									</View>
								</ScrollView>
							)}
						</View>
					)}
				</Animated.View>
			</View>
		</View>
	);
}
