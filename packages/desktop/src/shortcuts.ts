/**
 * The window's keyboard shortcuts.
 *
 * All of them in one place, because a shortcut is only ever wrong relative to the others: two
 * handlers claiming ⌘L, or Escape closing something a menu had already dealt with. Reading them as
 * a list is how those get noticed.
 *
 * What each one needs arrives as a parameter rather than being reached for, so this can be read
 * without knowing how the shell stores its state.
 */

import { useEffect, useRef } from "react";
import type { PanelKind } from "./sideStore.ts";

export interface ShortcutDeps {
	compact: boolean;
	navOpen: boolean;
	panelOpen: boolean;
	expanded: boolean;
	activeSessionId: string | null;
	workspace: unknown;
	toggleNav(): void;
	dismissNav(): void;
	closePanel(): void;
	toggleExpanded(): void;
	openPanel(then: () => void): void;
	toggleTab(kind: PanelKind): void;
}

export function useShortcuts(deps: ShortcutDeps): void {
	/*
	 * `openPanel` is read through a ref rather than listed as a dependency.
	 *
	 * The shell rebuilds it on every render, so depending on it would tear down and re-attach the
	 * key listener that often. The ref is updated each render, so the handler always calls the
	 * current one — the behaviour a dependency would have given, without the churn.
	 */
	const openPanel = useRef(deps.openPanel);
	openPanel.current = deps.openPanel;

	const {
		compact,
		navOpen,
		panelOpen,
		expanded,
		activeSessionId,
		workspace,
		toggleNav,
		dismissNav,
		closePanel,
		toggleExpanded,
		toggleTab,
	} = deps;

useEffect(() => {
  const onKey = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    // ⌘B is the conventional shortcut, and it makes the transition easy to feel.
    if (mod && !event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleNav();
      return;
    }
    /*
     * `code`, not `key`.
     *
     * Option is a dead-key modifier on macOS: ⌥S arrives as "ß", so matching on `key`
     * would never fire. The physical key is what the shortcut is written as.
     */
    if (mod && event.altKey && event.code === "KeyS") {
      event.preventDefault();
      if (activeSessionId) openPanel.current(() => toggleTab("chat"));
      return;
    }
    if (mod && event.shiftKey && event.code === "KeyR") {
      event.preventDefault();
      if (workspace) openPanel.current(() => toggleTab("review"));
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && event.code === "KeyP") {
      event.preventDefault();
      if (workspace) openPanel.current(() => toggleTab("files"));
      return;
    }
    // ⌘L for the trajectory: the log of what actually happened, beside the conversation.
    if (mod && !event.altKey && !event.shiftKey && event.code === "KeyL") {
      event.preventDefault();
      if (activeSessionId) openPanel.current(() => toggleTab("trajectory"));
      return;
    }
    // ⌃` is what every terminal-bearing editor uses, and it is not a ⌘ shortcut.
    if (event.ctrlKey && !event.metaKey && event.code === "Backquote") {
      event.preventDefault();
      if (workspace) openPanel.current(() => toggleTab("terminal"));
      return;
    }
    /*
     * Escape dismisses whatever is *covering* the conversation, and nothing else.
     *
     * A panel sitting beside the transcript is not covering anything, and closing
     * something you are working alongside is not what Escape means — so at ordinary
     * widths it does nothing. Full screen is covering it, and steps back one level
     * rather than closing outright: you asked for more room, not to be rid of the panel.
     * Popovers stop the event during capture, so an open menu still gets first refusal.
     */
    // Anything that already acted on Escape — the editor's find bar, a menu — calls
    // `preventDefault`. Without this check the same keypress also stepped the panel out
    // of full screen, so closing a find bar took the window apart with it.
    if (event.key === "Escape" && !event.defaultPrevented) {
      if (compact) {
        if (navOpen) dismissNav();
        else if (panelOpen) closePanel();
      } else if (panelOpen && expanded) {
        toggleExpanded();
      }
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [
  compact,
  navOpen,
  panelOpen,
  expanded,
  toggleNav,
  dismissNav,
  closePanel,
  toggleTab,
  toggleExpanded,
  activeSessionId,
  workspace,
]);
}
