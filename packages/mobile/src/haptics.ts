import { Platform, Vibration } from "react-native";

/**
 * High-precision vibration patterns calibrated for tactile button feel:
 * Android vibration pattern: [delay_ms, vibrate_ms, delay_ms, vibrate_ms...]
 */
export const haptic = {
	/** Crisp light tap for buttons, list clicks, toggles (instant 8ms tick) */
	tap: () => {
		try {
			if (Platform.OS === "android") {
				Vibration.vibrate(8);
			} else {
				Vibration.vibrate(10);
			}
		} catch {
			// Safe fallthrough
		}
	},
	/** Medium mechanical feedback for drawer/modal open and primary action clicks */
	impact: () => {
		try {
			if (Platform.OS === "android") {
				Vibration.vibrate([0, 14]);
			} else {
				Vibration.vibrate(20);
			}
		} catch {
			// Safe fallthrough
		}
	},
	/** Heavy distinctive mechanical buzz for destructive actions or long press */
	heavy: () => {
		try {
			if (Platform.OS === "android") {
				Vibration.vibrate([0, 28]);
			} else {
				Vibration.vibrate(40);
			}
		} catch {
			// Safe fallthrough
		}
	},
	/** Double click tick for success */
	success: () => {
		try {
			if (Platform.OS === "android") {
				Vibration.vibrate([0, 10, 40, 12]);
			} else {
				Vibration.vibrate(25);
			}
		} catch {
			// Safe fallthrough
		}
	},
	/** Warning buzz */
	warning: () => {
		try {
			if (Platform.OS === "android") {
				Vibration.vibrate([0, 20, 50, 20]);
			} else {
				Vibration.vibrate(30);
			}
		} catch {
			// Safe fallthrough
		}
	},
	/** Ultra-short subtle click for tab switching */
	selection: () => {
		try {
			if (Platform.OS === "android") {
				Vibration.vibrate(5);
			} else {
				Vibration.vibrate(5);
			}
		} catch {
			// Safe fallthrough
		}
	},
};
