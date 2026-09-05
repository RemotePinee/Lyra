import { useRouter } from "expo-router";
import { View } from "react-native";
import { MobileGitStatusModal } from "../src/MobileGitStatusModal";
import { useMobile } from "../src/store";

export default function GitStatusRoute() {
	const router = useRouter();
	const activeSession = useMobile((s) => s.activeSession);

	return (
		<View style={{ flex: 1, backgroundColor: "transparent" }}>
			<MobileGitStatusModal
				visible={true}
				cwd={activeSession?.cwd}
				onClose={() => router.back()}
			/>
		</View>
	);
}
