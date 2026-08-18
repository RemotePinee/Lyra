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
import { MIN_FRACTION } from "./geometry.ts";
import { flushTree, readTree, storageKey, writeTree } from "./persist.ts";
import {
	defaultTree,
	has,
	insert,
	kinds,
	areAdjacent,
	move,
	nodeAt,
	pathTo,
	remove,
	resize,
	type DockNode,
	type DropAt,
	type DropSide,
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
	/**
	 * What is filling the dock, and how the room is divided when it is a pair.
	 *
	 * A pair, because the file tree and the open file are one tool between them: enlarging half of
	 * it to read something leaves you unable to reach the next thing.
	 *
	 * `ratio` is the first pane's share *of the two*, held here rather than derived from the tree.
	 * It is read from the tree on the way in and written back on the way out, so a width dragged
	 * full screen survives leaving it and a width dragged in the ordinary layout survives entering
	 * it — but while full screen is on, the two panes fill the dock and their split is its own
	 * number. Deriving it from the tree instead means clamping against a row that also holds the
	 * conversation, and a boundary that barely moves.
	 */
	maximized: { panes: PaneKind[]; ratio: number } | null;
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

	/**
	 * Open a pane, or focus it if it is already open.
	 *
	 * `beside` is where it belongs when it has a declared partner — see `companion` on
	 * `PanelDefinition`. Passed in rather than looked up, because the registry knows about React
	 * components and this store deliberately does not.
	 */
	open(kind: PaneKind, beside?: { kind: PaneKind; side: DropSide; share?: number }): void;
	close(kind: PaneKind): void;
	toggle(kind: PaneKind): void;
	moveTo(kind: PaneKind, at: DropAt): void;
	/** Leave full screen. Separate from the toggle, for the callers that only ever want out. */
	restore(): void;
	/** Preview a drop, always derived from the layout without the carried pane. */
	preview(rest: DockNode, kind: PaneKind, at: DropAt | null): void;
	/**
	 * Move one boundary. `floor` is how small either side may get, defaulting to the tree's own —
	 * see `resize`, and the caller in `DockView` that scales it for a maximised pair.
	 */
	setShare(path: number[], index: number, fraction: number, floor?: number): void;
	focus(kind: PaneKind): void;
	toggleMaximized(kind: PaneKind, partner?: PaneKind): void;
	/** Move the boundary inside a maximised pair. The first pane's share of the two. */
	setMaximizedRatio(ratio: number): void;
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

/**
 * Give a freshly opened pane the share its panel asked for.
 *
 * `insert` halves whatever it splits, which is the right default and the wrong one for a pair: a
 * file tree wants a column and the file wants the rest. Expressed as *this pane's* share of the
 * two, so a panel declares how much room it needs without knowing which side it landed on.
 */
function withShare(tree: DockNode, kind: PaneKind | null, share: number | undefined): DockNode {
	if (!kind || share === undefined) return tree;
	const path = pathTo(tree, kind);
	// No parent to divide: it is the only pane there, and there is nothing to share with.
	if (!path || path.length === 0) return tree;
	const parent = path.slice(0, -1);
	const at = path[path.length - 1];
	const split = nodeAt(tree, parent);
	if (split?.type !== "split") return tree;

	// `resize` names a boundary by the child on its near side, so ask for the near one's share.
	const near = at === 0 ? 0 : at - 1;
	const pair = (split.sizes[near] ?? 0) + (split.sizes[near + 1] ?? 0);
	const mine = at === near ? share : 1 - share;
	return resize(tree, parent, near, mine * pair);
}

/** How small either half of a maximised pair may get, as a share of the two. */
const PAIR_MIN = 0.15;

/**
 * The boundary between two adjacent panes, named the way `resize` needs it.
 *
 * Null unless they really are siblings — which `areAdjacent` has already established by the time
 * anything calls this, but stating it here keeps the function honest on its own.
 */
function seamOf(tree: DockNode, panes: PaneKind[]): { path: number[]; index: number } | null {
	const [one, other] = panes;
	const first = pathTo(tree, one);
	const second = pathTo(tree, other);
	if (!first || !second || first.length !== second.length) return null;
	const parent = first.slice(0, -1);
	if (parent.join() !== second.slice(0, -1).join()) return null;
	const near = Math.min(first[first.length - 1], second[second.length - 1]);
	return { path: parent, index: near };
}

/** What the first of a pair currently holds, as a share of the two. Half for anything else. */
function ratioOf(tree: DockNode, panes: PaneKind[]): number {
	if (panes.length !== 2) return 0.5;
	const seam = seamOf(tree, panes);
	if (!seam) return 0.5;
	const split = nodeAt(tree, seam.path);
	if (split?.type !== "split") return 0.5;
	const near = split.sizes[seam.index] ?? 0;
	const far = split.sizes[seam.index + 1] ?? 0;
	return near + far > 0 ? near / (near + far) : 0.5;
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
			// A pane that left the tree cannot go on being the focused one; the conversation is the
			// one thing guaranteed to still be there.
			focused: present.includes(focused) ? focused : "conversation",
			/*
			 * Full screen is dropped by any change to the shape of the tree.
			 *
			 * It is a path, and a path means something different — or nothing — once panes have
			 * moved: closing a pane can collapse the split it was in, and the same indexes then
			 * lead somewhere unrelated. Checking that the node still exists is not enough, because
			 * a node existing at those indexes is exactly what happens when it is the wrong one.
			 * Leaving full screen is a mild surprise; showing the wrong pane full screen is not.
			 */
			maximized: maximized && tree === get().tree ? maximized : null,
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

		open: (kind, beside) => {
			const tree = get().tree;
			// Already open: bring it to attention rather than doing nothing, which is what the
			// narrow layout and the keyboard both need from this.
			if (has(tree, kind)) {
				set({ focused: kind });
				return;
			}
			// Beside its partner when it has one and the partner is here; otherwise wherever new
			// panes go. A file opening under the tree instead of next to it is the difference
			// between a file browser and two unrelated panels.
			const paired = beside && has(tree, beside.kind);
			const at = paired ? { side: beside.side, kind: beside.kind } : defaultDrop(tree);
			commit(withShare(insert(tree, kind, at), paired ? kind : null, beside?.share), { focused: kind });
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
		setShare: (path, index, fraction, floor) => {
			const tree = resize(get().tree, path, index, fraction, floor);
			set({ tree });
			save(get().scope, tree);
		},

		// Guarded, because this is called on every pointer-down anywhere in a pane: without the
		// check, clicking around inside the conversation would re-render the whole dock per click.
		focus: (kind) => {
			if (get().focused !== kind) set({ focused: kind });
		},

		/**
		 * Fill the dock with this pane — or with the pair it belongs to, when it has one here.
		 *
		 * `pairPath` only answers when the two are genuinely adjacent, so a tree and a file dragged
		 * to opposite ends of the window enlarge one at a time like anything else.
		 */
		toggleMaximized: (kind, partner) => {
			const { tree, maximized } = get();
			if (!has(tree, kind)) return;
			if (maximized?.panes.includes(kind)) {
				get().restore();
				return;
			}
			// The pair, when there is one and it is genuinely beside this pane; otherwise just this
			// one. Ordered by the tree so it reads the way the panes are laid out.
			const together = partner && has(tree, partner) && areAdjacent(tree, kind, partner);
			const panes = together ? kinds(tree).filter((each) => each === kind || each === partner) : [kind];
			set({ maximized: { panes, ratio: ratioOf(tree, panes) } });
		},

		setMaximizedRatio: (ratio) => {
			const maximized = get().maximized;
			if (!maximized) return;
			// Clamped in the frame the user is looking at, where the pair fills the dock.
			set({ maximized: { ...maximized, ratio: Math.min(1 - PAIR_MIN, Math.max(PAIR_MIN, ratio)) } });
		},

		/**
		 * Leave full screen, keeping whatever the boundary was dragged to.
		 *
		 * Written back scaled: the pair filled the dock and now goes back to holding part of a row,
		 * so the ratio between them is preserved rather than the numbers.
		 */
		restore: () => {
			const { tree, maximized } = get();
			if (!maximized) return;
			set({ maximized: null });
			if (maximized.panes.length !== 2) return;
			const seam = seamOf(tree, maximized.panes);
			if (!seam) return;
			const split = nodeAt(tree, seam.path);
			if (split?.type !== "split") return;
			const pair = (split.sizes[seam.index] ?? 0) + (split.sizes[seam.index + 1] ?? 0);
			const next = resize(tree, seam.path, seam.index, maximized.ratio * pair, MIN_FRACTION * pair);
			set({ tree: next });
			save(get().scope, next);
		},

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
