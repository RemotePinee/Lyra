import { useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { MobileFileViewerModal } from "../src/MobileFileViewerModal";
import { useMobile } from "../src/store";

export default function FileViewerRoute() {
	const router = useRouter();
	const params = useLocalSearchParams<{ path?: string }>();
	const activeSession = useMobile((s) => s.activeSession);

	return (
		<View style={{ flex: 1, backgroundColor: "transparent" }}>
			<MobileFileViewerModal
				visible={true}
				rootPath={params.path || activeSession?.cwd}
				onClose={() => router.back()}
			/>
		</View>
	);
}
