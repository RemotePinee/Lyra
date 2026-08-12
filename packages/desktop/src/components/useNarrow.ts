import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether an element is too narrow for a two-column layout, measured from the element itself.
 *
 * Panel contents cannot ask the window how much room they have — the same component runs in a
 * 368px panel and across a full-width column. This watches the box it is actually given.
 *
 * The first measurement is taken synchronously rather than left to the observer's initial
 * callback. That callback lands after paint, so a component that starts at `false` renders one
 * frame of the wrong layout — and worse, anything keyed to the flip (a list/detail reset, say)
 * fires a beat after the user has already acted, undoing what they just did.
 */
export function useNarrow(threshold: number): [boolean, React.RefObject<HTMLDivElement | null>] {
	const ref = useRef<HTMLDivElement>(null);
	const [narrow, setNarrow] = useState(false);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		setNarrow(element.clientWidth > 0 && element.clientWidth < threshold);

		const observer = new ResizeObserver(([entry]) => {
			// Zero width means hidden, not narrow; a background tab would otherwise reshape itself.
			if (entry.contentRect.width > 0) setNarrow(entry.contentRect.width < threshold);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [threshold]);

	return [narrow, ref];
}
