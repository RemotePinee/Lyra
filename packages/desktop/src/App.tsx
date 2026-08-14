import { useEffect, useRef, useState } from "react";
import { Spinner } from "./components/RunningIndicator.tsx";
import {
  Conversation,
  ConversationSkeleton,
} from "./components/Conversation.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { NoticeStack } from "./components/NoticeStack.tsx";
import { PullRequestsView } from "./components/PullRequestsView.tsx";
import { ScheduledView } from "./components/ScheduledView.tsx";
import { ResizeHandle } from "./components/ResizeHandle.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { ToolbarButton, WindowControls } from "./components/WindowControls.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SettingsShell } from "./components/settings/SettingsShell.tsx";
import { LayoutProvider, NavPane, SidePane, useLayout } from "./layout.tsx";
import { useSide } from "./sideStore.ts";
import { useApp } from "./store.ts";
import { applyAppearance, watchSystemTheme } from "./theme.ts";

/** What the conversation keeps for itself before the panel is allowed any more. */
const CONTENT_MIN = 420;
/**
 * Left offset of the first toolbar button, when there are traffic lights to clear.
 *
 * The three lights are 12pt wide on a 20pt pitch starting at x=16, so they end at 68.5.
 * Starting at 78 leaves the ~10pt gap the reference screenshots have; 70 put the button flush
 * against the green light.
 */
const TOOLBAR_LEFT = 78;
/**
 * And where it goes when there are none.
 *
 * macOS takes the lights away in native full screen. Holding their inset open then leaves a
 * gap at the top-left reserved for three buttons that are not there — which is exactly what it
 * looks like. 12 is the same margin the rest of the window's edges use.
 */
const TOOLBAR_LEFT_FULLSCREEN = 12;

export function App() {
  const ready = useApp((s) => s.ready);
  const bootstrap = useApp((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const appearance = useApp((s) => s.settings?.appearance);
  useEffect(() => {
    if (appearance) applyAppearance(appearance);
  }, [appearance]);
  useEffect(
    () =>
      watchSystemTheme(
        () => useApp.getState().settings?.appearance ?? appearance!,
      ),
    [appearance],
  );

  if (!ready) return <BootScreen />;

  return (
    <LayoutProvider>
      <Shell />
    </LayoutProvider>
  );
}

/**
 * What the window shows between opening and the settings arriving.
 *
 * Almost always a few hundred milliseconds, which is the whole design problem: anything that
 * announces itself immediately is a flash, and a flash is what makes a fast launch feel broken.
 * So nothing is drawn for the first half-second, and what does appear afterwards is one arc and
 * the app's name, fading in over a full second rather than snapping on.
 *
 * The colours here come from the preload, which paints the saved theme before the first frame —
 * without it this screen was always dark, and a light-theme app began every launch by flashing.
 */
function BootScreen() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex h-full items-center justify-center bg-shell" aria-busy>
      <div
        className="flex flex-col items-center gap-3.5 transition-opacity duration-[900ms] ease-out"
        style={{ opacity: shown ? 1 : 0 }}
      >
        <Spinner size={20} />
        <span className="text-[12px] tracking-[0.14em] text-ink-faint/80 uppercase">
          DeepWise
        </span>
      </div>
    </div>
  );
}

function Shell() {
  const view = useApp((s) => s.view);
  const { dismissNav } = useLayout();

  // Settings and the workspace each own a navigation pane; a drawer opened over one has no
  // meaning over the other, so leaving the view puts it away.
  useEffect(() => dismissNav(), [view, dismissNav]);

  if (view === "settings") return <SettingsShell />;
  return <ChatShell />;
}

function ChatShell() {
  const view = useApp((s) => s.view);
  const messages = useApp((s) => s.messages);
  const loadingSession = useApp((s) => s.loadingSession);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const {
    compact,
    width,
    navOpen,
    nativeFullScreen,
    sidebarWidth,
    panelWidth: preferredPanelWidth,
    setPanelWidth,
    resetPanelWidth,
    bounds,
    toggleNav,
    dismissNav,
    collapseNav,
  } = useLayout();

  const workspace = useApp((s) => s.workspace);
  const panelOpen = useSide((s) => s.panelOpen);
  const expanded = useSide((s) => s.expanded);
  const reopenPanel = useSide((s) => s.reopenPanel);
  const closePanel = useSide((s) => s.closePanel);
  const toggleTab = useSide((s) => s.toggleTab);
  const toggleExpanded = useSide((s) => s.toggleExpanded);
  const attach = useSide((s) => s.attach);

  /**
   * What the panel gets, once the conversation has taken what it needs.
   *
   * Squeezed rather than fixed: at 1110px with the sidebar out there is room for the full
   * 380, at 900 there is not, and a panel that refused to give any of it back would leave a
   * column too narrow to read a sentence in.
   */
  const available = width - (navOpen && !compact ? sidebarWidth : 0);
  /*
   * The preference, narrowed to what is actually there.
   *
   * Clamped at render rather than written back, so a window dragged narrow and out again
   * returns the panel to the width that was asked for instead of keeping whatever it was
   * squeezed to on the way through.
   */
  const panelWidth = Math.max(
    bounds.panel.min,
    Math.min(preferredPanelWidth, available - CONTENT_MIN),
  );
  /**
   * Full-screen: the panel takes the conversation's whole column.
   *
   * Laid over it rather than squeezing it to nothing. A transcript reflowed to zero width and
   * back costs a full re-layout of every message in it, and the scroll position does not
   * survive the trip — covering it leaves the conversation exactly as it was underneath.
   *
   * Full height, exactly as the docked panel is. Starting below the toolbar instead left a
   * 44px band of empty window above it, and with the sidebar collapsed that band ran the full
   * width — the panel read as having come loose from the top of the window. Its own tab strip
   * sits in that band and is what the window is dragged by, the same way it already works
   * docked; the traffic-light inset below keeps the first tab clear of them.
   */
  const fullScreen = expanded && !compact;
  /**
   * Who draws the window's three buttons.
   *
   * The panel, whenever its left edge is the window's — compact, or full screen with the sidebar
   * away. In every other layout something of the window is still up there and they stay in the
   * toolbar. Exactly one of the two renders them, so they never double up.
   */
  const panelHostsControls = panelOpen && (compact || (fullScreen && !navOpen));
  /**
   * Whether the panel is over the top-right corner, where the toolbar's own buttons live.
   *
   * Only then does the panel need to carry the control that closes it; the rest of the time the
   * toolbar keeps it, in a spot that does not move when the panel opens.
   */
  const panelCoversToolbar = panelOpen && (compact || fullScreen);

  /**
   * Opening the panel puts the sidebar away when all three cannot fit.
   *
   * Re-opening the sidebar afterwards is then a choice the user is allowed to make, rather
   * than something that gets undone under them a frame later.
   */
  const openPanel = (open: () => void) => {
    open();
    dismissNav();
    if (!compact && navOpen && width - sidebarWidth - panelWidth < CONTENT_MIN)
      collapseNav();
  };

  /**
   * Give the conversation its floor back when the window is dragged narrower.
   *
   * Checking only at the moment of opening was not enough: open all three at a comfortable
   * width, then drag the window in, and nothing re-ran — the column was squeezed to about
   * 200px, where a sentence wraps every four characters and the composer's own controls pile
   * on top of each other.
   *
   * Only while shrinking. Reacting to `navOpen` as well would mean re-opening the sidebar by
   * hand gets undone a frame later, which is the app arguing with the user rather than
   * responding to a window that genuinely no longer fits.
   */
  const lastWidth = useRef(width);
  useEffect(() => {
    const shrinking = width < lastWidth.current;
    lastWidth.current = width;
    if (!shrinking || compact || !panelOpen || !navOpen) return;
    if (width < sidebarWidth + CONTENT_MIN + bounds.panel.min) collapseNav();
  }, [width, compact, panelOpen, navOpen, collapseNav]);

  // The side chat reads the session it is attached to, so it follows whichever one is open.
  useEffect(() => {
    void attach(activeSessionId);
  }, [activeSessionId, attach]);

  // Two full-window panels cannot share one window; the newest one wins.
  useEffect(() => {
    if (compact && navOpen) closePanel();
  }, [compact, navOpen, closePanel]);

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
        if (activeSessionId) openPanel(() => toggleTab("chat"));
        return;
      }
      if (mod && event.shiftKey && event.code === "KeyR") {
        event.preventDefault();
        if (workspace) openPanel(() => toggleTab("review"));
        return;
      }
      if (mod && !event.altKey && !event.shiftKey && event.code === "KeyP") {
        event.preventDefault();
        if (workspace) openPanel(() => toggleTab("files"));
        return;
      }
      // ⌃` is what every terminal-bearing editor uses, and it is not a ⌘ shortcut.
      if (event.ctrlKey && !event.metaKey && event.code === "Backquote") {
        event.preventDefault();
        if (workspace) openPanel(() => toggleTab("terminal"));
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

  return (
    <div className="dw-shell relative flex h-full overflow-hidden">
      <NavPane width={sidebarWidth} label="侧边栏">
        <Sidebar />
      </NavPane>

      <main className="dw-opaque relative flex min-w-0 flex-1 flex-col">
        {/* Space for the window toolbar, which is rendered last so its no-drag holes stick. */}
        <div className="h-[44px] shrink-0" />

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {view === "pull-requests" ? (
              <PullRequestsView />
            ) : view === "scheduled" ? (
              <ScheduledView />
            ) : messages.length > 0 ? (
              <Conversation />
            ) : loadingSession ? (
              <ConversationSkeleton />
            ) : (
              <EmptyState />
            )}
          </div>
        </div>

        <NoticeStack />
      </main>

      {/*
       * Window toolbar, deliberately the last child.
       *
       * Electron builds the draggable region by walking the DOM in order, so a `drag`
       * element that appears after a `no-drag` one fills the hole back in. The sidebar's
       * own drag strip used to come later than this toolbar, which is why these buttons
       * could not be clicked at all. Keeping the strip and its buttons together, last,
       * makes the holes final — and keeps them clickable above the drawer, which is how
       * a full-window drawer gets closed again.
       */}
      <div className="drag-region absolute inset-x-0 top-0 z-40 h-[44px]">
        <div className="no-drag toolbar-right absolute top-0 flex h-[44px] items-center gap-0.5">
          {/*
           * One control, in one place, for both directions.
           *
           * This used to disappear when the panel opened, on the grounds that the panel's own
           * title bar carries a close button in roughly this spot. Roughly is the problem: the
           * panel insets itself by six pixels and draws a border, so the button landed a few
           * pixels off from where it had just been and the eye caught every open and close as a
           * jump. Now it only hands over when the panel genuinely covers this corner — full
           * screen or compact — and in every other layout it stays put and changes state.
           */}
          {!panelCoversToolbar && !(compact && navOpen) && (
            <ToolbarButton
              label={panelOpen ? "收起面板" : "展开面板"}
              onClick={() => (panelOpen ? closePanel() : openPanel(() => reopenPanel()))}
            >
              <RightPanelIcon active={panelOpen} />
            </ToolbarButton>
          )}
        </div>
      </div>

      {/*
       * Last, and deliberately so.
       *
       * Electron composites drag regions by DOM order, so the toolbar's `drag-region`
       * would fill in this panel's `no-drag` holes if the panel came first — its title
       * bar buttons sit inside the toolbar's 44px band and would stop being clickable.
       *
       * Being last in the DOM costs nothing in the wide layout: the toolbar is absolute
       * and takes no part in the flex row, so this is still the third and rightmost item.
       */}
      <SidePane
        width={panelWidth}
        open={panelOpen}
        fullScreen={fullScreen}
        offset={navOpen ? sidebarWidth : 0}
      >
        <SidePanel />

        {/*
         * Not in compact or full screen, where the panel covers the column rather than
         * sharing it: there is no boundary between two things to move. Nor while closed —
         * the pane is still mounted then, and an edge with nothing on one side of it is
         * not an edge.
         */}
        {panelOpen && !compact && !fullScreen && (
          <ResizeHandle
            edge="start"
            width={panelWidth}
            min={bounds.panel.min}
            max={Math.max(
              bounds.panel.min,
              Math.min(bounds.panel.max, available - CONTENT_MIN),
            )}
            onResize={setPanelWidth}
            onReset={resetPanelWidth}
            label="调整面板宽度"
          />
        )}
      </SidePane>

      {/*
       * The window's own controls.
       *
       * Rendered here only while something of the window is still visible behind them. When
       * the panel reaches the left edge it hosts these itself, inside its tab strip — see
       * `WindowControls` in SidePanel. Floating them over its card instead left three
       * buttons sitting in a surface they had nothing to do with, and pushed the first tab
       * 172px inward to get out of their way.
       *
       * Last in the DOM because Electron composites drag regions in order, and a `drag`
       * element after a `no-drag` one fills the hole back in.
       */}
      {!panelHostsControls && (
        <div
          className="no-drag absolute top-0 z-[60] flex h-[44px] items-center gap-0.5"
          style={{
            left: nativeFullScreen ? TOOLBAR_LEFT_FULLSCREEN : TOOLBAR_LEFT,
          }}
        >
          <WindowControls
            navOpen={navOpen}
            onToggleNav={toggleNav}
            active={compact && navOpen}
          />
        </div>
      )}
    </div>
  );
}

function RightPanelIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="14.5" y1="4" x2="14.5" y2="20" />
      <rect
        x="14.5"
        y="4"
        width="6.5"
        height="16"
        rx="2.5"
        fill="currentColor"
        stroke="none"
        className="transition-opacity duration-200"
        opacity={active ? 0.5 : 0}
      />
    </svg>
  );
}
