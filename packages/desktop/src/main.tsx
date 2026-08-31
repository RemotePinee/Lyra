import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { ScreenshotOverlay } from "./components/image/ScreenshotOverlay.tsx";
import { installTooltips } from "./tooltip.ts";
import "./styles.css";

installTooltips();

const isOverlay = window.location.hash.startsWith("#/screenshot-overlay");

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Outside `App`, so a throw during its own setup is caught too — that is the case where
		    the window would otherwise be empty grey with nothing to read at all. */}
		<ErrorBoundary>
			{isOverlay ? <ScreenshotOverlay /> : <App />}
		</ErrorBoundary>
	</StrictMode>,
);
