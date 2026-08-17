import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { installTooltips } from "./tooltip.ts";
import "./styles.css";

installTooltips();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Outside `App`, so a throw during its own setup is caught too — that is the case where
		    the window would otherwise be empty grey with nothing to read at all. */}
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
