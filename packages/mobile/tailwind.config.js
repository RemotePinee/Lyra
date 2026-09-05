/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
	presets: [require("nativewind/preset")],
	darkMode: "class",
	theme: {
		extend: {
			colors: {
				shell: "var(--color-shell)",
				sidebar: "var(--color-sidebar)",
				panel: "var(--color-panel)",
				card: "var(--color-card)",
				"card-hover": "var(--color-card-hover)",
				input: "var(--color-input)",
				elevated: "var(--color-elevated)",
				line: "var(--color-line)",
				"line-soft": "var(--color-line-soft)",
				ink: "var(--color-ink)",
				"ink-muted": "var(--color-ink-muted)",
				"ink-faint": "var(--color-ink-faint)",
				accent: "var(--color-accent)",
				ok: "var(--color-ok)",
				info: "var(--color-info)",
				violet: "var(--color-violet)",
				danger: "var(--color-danger)",
			},
		},
	},
	plugins: [],
};
