import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		// @deepwise/core ships TypeScript sources, so it must be bundled rather than
		// externalised — Node cannot require a .ts entry point at runtime.
		plugins: [externalizeDepsPlugin({ exclude: ["@deepwise/core"] })],
		build: {
			rollupOptions: {
				input: { index: resolve("electron/main.ts") },
				/*
				 * `electron` is a devDependency, so the externalize plugin leaves it in — and
				 * bundling its CommonJS loader breaks on `__dirname` under ESM output.
				 *
				 * `node-pty` for a sharper reason: it loads a compiled `.node` addon by relative
				 * path. Inlined into an ESM bundle its `__dirname` does not exist, and the app
				 * fails to boot at all. Native modules are always external.
				 *
				 * Listed here rather than left to the plugin because assigning `external`
				 * replaces what the plugin contributes instead of adding to it.
				 */
				external: ["electron", "node-pty"],
			},
		},
		resolve: {
			// The core package ships TypeScript sources and imports them with explicit .ts
			// extensions; Rollup needs the extension list to include them.
			extensions: [".ts", ".js", ".mjs", ".json"],
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ["@deepwise/core"] })],
		build: {
			rollupOptions: {
				input: { index: resolve("electron/preload.ts") },
				external: ["electron"],
			},
		},
	},
	renderer: {
		root: ".",
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: { "@": resolve("src") },
		},
		build: {
			rollupOptions: {
				input: { index: resolve("index.html") },
			},
		},
	},
});
