import * as SecureStore from "expo-secure-store";
import { colorScheme as nativewindColorScheme } from "nativewind";
import { useEffect, useState } from "react";
import { Appearance, useColorScheme as useRNColorScheme } from "react-native";
import { create } from "zustand";

export type ThemePreference = "system" | "dark" | "light";

export interface ThemeColors {
	shell: string;
	sidebar: string;
	panel: string;
	card: string;
	cardHover: string;
	input: string;
	elevated: string;
	line: string;
	lineSoft: string;
	ink: string;
	inkMuted: string;
	inkFaint: string;
	accent: string;
	ok: string;
	info: string;
	violet: string;
	danger: string;
}

export const DARK_THEME: ThemeColors = {
	shell: "#121212",
	sidebar: "#18181a",
	panel: "#1e1e22",
	card: "#222226",
	cardHover: "#2a2a30",
	input: "#27272c",
	elevated: "#303036",
	line: "#2c2c30",
	lineSoft: "#222226",
	ink: "#ededed",
	inkMuted: "#9a9a9a",
	inkFaint: "#6e6e6e",
	accent: "#ff8b3d",
	ok: "#3ecf8e",
	info: "#5aa2f5",
	violet: "#b18cf5",
	danger: "#f2555a",
};

export const LIGHT_THEME: ThemeColors = {
	shell: "#f6f6f8",
	sidebar: "#ffffff",
	panel: "#f0f0f3",
	card: "#f0f0f3",
	cardHover: "#e6e6e9",
	input: "#e4e4e8",
	elevated: "#e4e4e7",
	line: "#e5e5ea",
	lineSoft: "#eaeaea",
	ink: "#1c1c1e",
	inkMuted: "#636366",
	inkFaint: "#8e8e93",
	accent: "#ff7a22",
	ok: "#28a745",
	info: "#007aff",
	violet: "#8a5cf5",
	danger: "#e03e42",
};

const THEME_STORE_KEY = "lyra.theme_preference";

interface ThemeState {
	preference: ThemePreference;
	setPreference: (pref: ThemePreference) => void;
	initPreference: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
	preference: "system",
	setPreference: (preference: ThemePreference) => {
		set({ preference });
		void SecureStore.setItemAsync(THEME_STORE_KEY, preference).catch(() => {});
	},
	initPreference: async () => {
		try {
			const saved = await SecureStore.getItemAsync(THEME_STORE_KEY);
			if (saved === "system" || saved === "dark" || saved === "light") {
				set({ preference: saved });
			}
		} catch {
			// ignore storage failure
		}
	},
}));

export function useThemeColors(): {
	colors: ThemeColors;
	isDark: boolean;
	preference: ThemePreference;
	setPreference: (pref: ThemePreference) => void;
} {
	const rnScheme = useRNColorScheme();
	const [hardwareScheme, setHardwareScheme] = useState<"light" | "dark">(() => {
		return Appearance.getColorScheme() === "dark" ? "dark" : "light";
	});
	const preference = useThemeStore((s) => s.preference);
	const setPreference = useThemeStore((s) => s.setPreference);

	// When preference changes, reset React Native's Appearance override so it reads actual OS theme
	useEffect(() => {
		if (preference === "system") {
			// Clear manual override in React Native Appearance
			nativewindColorScheme.set("system");
			// Read current real system appearance
			const current = Appearance.getColorScheme();
			if (current === "light" || current === "dark") {
				setHardwareScheme(current);
			}
		} else {
			nativewindColorScheme.set(preference);
		}
	}, [preference]);

	useEffect(() => {
		const sub = Appearance.addChangeListener(({ colorScheme }) => {
			if (colorScheme === "light" || colorScheme === "dark") {
				setHardwareScheme(colorScheme);
			}
		});
		return () => sub.remove();
	}, []);

	const isDark = preference === "system"
		? (hardwareScheme === "dark" || rnScheme === "dark")
		: preference === "dark";

	return {
		colors: isDark ? DARK_THEME : LIGHT_THEME,
		isDark,
		preference,
		setPreference,
	};
}
