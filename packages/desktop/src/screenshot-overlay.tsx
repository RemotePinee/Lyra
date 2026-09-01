import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ScreenshotOverlay } from "./components/image/ScreenshotOverlay.tsx";
import { installTooltips } from "./tooltip.ts";
import "./styles.css";

class ScreenshotErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[screenshot] overlay renderer failed", error, info.componentStack);
		void window.lyra.screenshot.cancel();
	}

	override render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}

installTooltips();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ScreenshotErrorBoundary>
			<ScreenshotOverlay />
		</ScreenshotErrorBoundary>
	</StrictMode>,
);
