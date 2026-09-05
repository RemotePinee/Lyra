import { vars } from "nativewind";
import { DARK_THEME, LIGHT_THEME } from "./theme";

export const darkThemeVariables = vars({
	"--color-shell": DARK_THEME.shell,
	"--color-sidebar": DARK_THEME.sidebar,
	"--color-panel": DARK_THEME.panel,
	"--color-card": DARK_THEME.card,
	"--color-card-hover": DARK_THEME.cardHover,
	"--color-input": DARK_THEME.input,
	"--color-elevated": DARK_THEME.elevated,
	"--color-line": DARK_THEME.line,
	"--color-line-soft": DARK_THEME.lineSoft,
	"--color-ink": DARK_THEME.ink,
	"--color-ink-muted": DARK_THEME.inkMuted,
	"--color-ink-faint": DARK_THEME.inkFaint,
	"--color-accent": DARK_THEME.accent,
	"--color-ok": DARK_THEME.ok,
	"--color-info": DARK_THEME.info,
	"--color-violet": DARK_THEME.violet,
	"--color-danger": DARK_THEME.danger,
});

export const lightThemeVariables = vars({
	"--color-shell": LIGHT_THEME.shell,
	"--color-sidebar": LIGHT_THEME.sidebar,
	"--color-panel": LIGHT_THEME.panel,
	"--color-card": LIGHT_THEME.card,
	"--color-card-hover": LIGHT_THEME.cardHover,
	"--color-input": LIGHT_THEME.input,
	"--color-elevated": LIGHT_THEME.elevated,
	"--color-line": LIGHT_THEME.line,
	"--color-line-soft": LIGHT_THEME.lineSoft,
	"--color-ink": LIGHT_THEME.ink,
	"--color-ink-muted": LIGHT_THEME.inkMuted,
	"--color-ink-faint": LIGHT_THEME.inkFaint,
	"--color-accent": LIGHT_THEME.accent,
	"--color-ok": LIGHT_THEME.ok,
	"--color-info": LIGHT_THEME.info,
	"--color-violet": LIGHT_THEME.violet,
	"--color-danger": LIGHT_THEME.danger,
});
