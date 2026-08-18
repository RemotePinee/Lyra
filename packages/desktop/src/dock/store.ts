/**
 * The dock's state: one tree, and the few things that are true *about* the tree rather than in it.
 *
 * This replaces four fields that had to agree with each other — `panelOpen`, `activeTab`,
 * `expanded`, and the tab list — with one that cannot disagree with itself. A pane is open if it
 * is in the tree. Where it is, is where it is. There is no second place that also knows.
 *
 * What is *not* here is anything a pane contains. The side chat's messages, the queued tasks and
 * the browser's target all stay in `sideStore`: those are contents with their own lifetimes, and
 * folding them in would tie a conversation's history to where its window happened to be.
 */

import { create } from "zustand";
import { flushTree, readTree, storageKey, writeTree } from "./persist.ts";
import {
	defaultTree,
	has,
	insert,
	kinds,
	move,
	remove,
	resize,
	type DockNode,
	type DropAt,
	type PaneKind,
} from "./tree.ts";

/** A drag in flight. Null the rest of the time, which is almost all of it. */
interface DragState {
	kind: PaneKind;
	/** Where the pane was when the drag began, so the ghost can start there rather than jump. */
	from: { left: number; top: number; width: number; height: number };
	/** How far into the pane the pointer grabbed it, so the ghost hangs off the pointer correctly. */
	grip: { x: number; y: number };
	pointer: { x: number; y: number };
	/** The landing place currently committed to the tree, so a move is not re-applied per frame. */
	at: DropAt | null;
	/** The tree as it was before the drag, to restore if it lands nowhere. */
	before: DockNode;
	/**
	 * The layout without the carried pane, which is what the drag is hit-tested against.
	 *
	 * Fixed for the whole drag. The preview inserts into a copy of this rather than into whatever
	 * the previous frame produced — see `preview`.
	 */
	rest: DockNode;
}

interface DockState {
	tree: DockNode;
	/** Which pane the collapsed (narrow-window) form is showing. */
	focused: PaneKind;
	/** A pane drawn over the whole dock — what is left of the old `expanded`. */
	maximized: PaneKind | null;
	drag: DragState | null;
	/** The project this tree belongs to, so switching saves the old one under the right key. */
	scope: string | null;
	/**
	 * Whether `adopt` has ever run.
	 *
	 * Needed because `null` is a real scope — a conversation with no project runs in a scratch
	 * directory and has a layout of its own. Without this flag the initial `scope: null` is
	 * indistinguishable from "already pointed at the scratch scope", so the first `adopt(null)`
	 * decided there was nothing to do and the saved layout was never read back. Which is to say:
	 * the one case where persistence silently did nothing was the default case.
	 */
	adopted: boolean;

	/** Open a pane, or focus it if it is already open. */
	open(kind: PaneKind): void;
	close(kind: PaneKind): void;
	toggle(kind: PaneKind): void;
	moveTo(kind: PaneKind, at: DropAt): void;
	/** Preview a drop, always derived from the layout without the carried pane. */
	preview(rest: DockNode, kind: PaneKind, at: DropAt | null): void;
	setShare(path: number[], index: number, fraction: number): void;
	focus(kind: PaneKind): void;
	toggleMaximized(kind: PaneKind): void;
	reset(): void;

	beginDrag(drag: DragState): void;
	dragTo(pointer: { x: number; y: number }, at: DropAt | null): void;
	endDrag(cancelled?: boolean): void;

	/** Point the dock at a project, saving whatever the last one had. */
	adopt(scope: string | null, allowed: PaneKind[]): void;
}

/**
 * Where a pane goes when it is opened from the menu rather than dragged.
 *
 * Two rules, and between them they reproduce what the reference app does: the first panel opens
 * as a column beside the conversation, and every one after it stacks under the last. Stacking
 * rather than opening another column is what keeps the conversation from being squeezed thinner
 * with each panel — the column is established once, and then shared.
 */
function defaultDrop(tree: DockNode): DropAt {
	const others = kinds(tree).filter((kind) => kind !== "conversation");
	if (others.length === 0) return { side: "right", kind: null };
	return { side: "bottom", kind: others[others.length - 1] };
}

/** Persist, unless the dock has not been pointed at a project yet. */
function save(scope: string | null, tree: DockNode): void {
	writeTree(storageKey(scope), tree);
}

export const useDock = create<DockState>((set, get) => {
	/**
	 * Every mutation goes through here, so nothing can change the tree without saving it.
	 *
	 * `persist` is false for the frames of a drag. Those trees are provisional — and one of them is
	 * a tree with the carried pane missing entirely, which is exactly the arrangement that must not
	 * be what a crash mid-drag leaves behind. The drag saves once, when it is let go.
	 */
	const commit = (tree: DockNode, extra?: Partial<DockState>, persist = true) => {
		const { scope, focused, maximized } = get();
		const present = kinds(tree);
		set({
			tree,
			// A pane that left the tree cannot go on being the focused or maximised one; the
			// conversation is the one thing guaranteed to still be there.
			focused: present.includes(focused) ? focused : "conversation",
			maximized: maximized && present.includes(maximized) ? maximized : null,
			...extra,
		});
		if (persist) save(scope, tree);
	};

	return {
		tree: defaultTree(),
		focused: "conversation",
		maximized: null,
		drag: null,
		scope: null,
		adopted: false,

		open: (kind) => {
			const tree = get().tree;
			// Already open: bring it to attention rather than doing nothing, which is what the
			// narrow layout and the keyboard both need from this.
			if (has(tree, kind)) {
				set({ focused: kind });
				return;
			}
			commit(insert(tree, kind, defaultDrop(tree)), { focused: kind });
		},

		close: (kind) => commit(remove(get().tree, kind)),

		toggle: (kind) => {
			const { tree, focused } = get();
			if (!has(tree, kind)) {
				get().open(kind);
				return;
			}
			/*
			 * A shortcut pressed twice puts the pane away.
			 *
			 * Only when it is already the one being looked at, so ⌘P from inside the terminal
			 * moves you to the files rather than closing them — which is the behaviour the old
			 * `toggleTab` had, and the one that makes a shortcut usable as "go there".
			 */
			if (focused === kind) commit(remove(tree, kind));
			else set({ focused: kind });
		},

		moveTo: (kind, at) => commit(move(get().tree, kind, at)),

		/**
		 * Show what a drop would do, by inserting into the layout the carried pane has left.
		 *
		 * `rest`, never the current tree, and that is the whole reason this exists. The preview
		 * rearranges the panes, so applying the next preview to the rearranged layout would make
		 * each answer depend on the one before it — and it oscillates. Concretely: drag a pane onto
		 * the conversation's bottom edge and the two become stacked; the pointer has not moved, but
		 * it is now a quarter of the way down a pane half as tall, which is that pane's *top* band,
		 * so the next frame moves it again and the frame after that moves it back.
		 *
		 * Inserting into a fixed `rest` makes it idempotent: one pointer position means one layout,
		 * however many frames it is held there and whatever route it took. `null` — over no landing
		 * region at all — shows `rest` itself, with the carried pane simply not in the dock. It is
		 * being carried; the ghost is where it is.
		 */
		preview: (rest, kind, at) => commit(at ? insert(rest, kind, at) : rest, undefined, false),

		// Not through `commit`: this runs on every frame of a splitter drag, and the pane set is
		// unchanged by definition — a resize cannot orphan the focused pane.
		setShare: (path, index, fraction) => {
			const tree = resize(get().tree, path, index, fraction);
			set({ tree });
			save(get().scope, tree);
		},

		// Guarded, because this is called on every pointer-down anywhere in a pane: without the
		// check, clicking around inside the conversation would re-render the whole dock per click.
		focus: (kind) => {
			if (get().focused !== kind) set({ focused: kind });
		},

		toggleMaximized: (kind) => set({ maximized: get().maximized === kind ? null : kind }),

		reset: () => commit(defaultTree(), { focused: "conversation", maximized: null }),

		beginDrag: (drag) => set({ drag }),

		dragTo: (pointer, at) => {
			const drag = get().drag;
			if (!drag) return;
			set({ drag: { ...drag, pointer, at } });
		},

		endDrag: (cancelled) => {
			const drag = get().drag;
			set({ drag: null });
			if (!drag) return;
			/*
			 * Put the layout back when the drag lands nowhere — and it *has* to be put back, not
			 * merely left alone: while a drag is in flight the carried pane is not in the tree, so
			 * "leaving it" would be losing it. Escape takes the same path.
			 */
			if (cancelled || !drag.at) commit(drag.before);
			// The drag's own frames were not persisted; this is the one write it makes.
			else save(get().scope, get().tree);
		},

		adopt: (scope, allowed) => {
			if (get().adopted && get().scope === scope) return;
			// The outgoing project's pending write must land under its own key, before the key
			// changes — otherwise its layout is saved as the incoming project's.
			flushTree();
			const stored = readTree(storageKey(scope), allowed);
			set({
				scope,
				adopted: true,
				tree: stored ?? defaultTree(),
				focused: "conversation",
				maximized: null,
				drag: null,
			});
		},
	};
});

/**
 * Save on the way out.
 *
 * The write is debounced, so a change made in the last tenth of a second before the window closes
 * would otherwise be the one change that never survives — and that is exactly the change someone
 * would notice, because it is the one they just made.
 */
if (typeof window !== "undefined") window.addEventListener("beforeunload", flushTree);
