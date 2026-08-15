/**
 * The side-panel toggle's icon.
 *
 * Drawn rather than imported: the icon set has no glyph that says "a panel on the right, and
 * whether it is open", and the difference between the two states is the whole point of the button.
 */

export function RightPanelIcon({ active }: { active: boolean }) {
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
