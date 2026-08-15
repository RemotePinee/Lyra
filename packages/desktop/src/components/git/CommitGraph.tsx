import type { GraphRow } from "./graph.ts";

/** Lane colours, drawn from the palette the rest of the app already uses. */
const LANE_COLOURS = [
  "var(--color-accent)",
  "var(--color-ok)",
  "var(--color-violet)",
  "var(--color-info)",
  "var(--color-danger)",
  "var(--color-ink-muted)",
];

export const LANE_WIDTH = 13;

function laneColour(index: number): string {
  return LANE_COLOURS[index % LANE_COLOURS.length];
}

/**
 * One row of the commit graph, drawn beside its commit.
 *
 * Per row rather than one tall SVG for the list: rows are already a scrolling column of
 * variable height — a commit expands to show its diff — and a single canvas would have to be
 * re-measured and re-drawn on every expansion. Each row draws only what crosses it, so the
 * graph stays correct however the list reflows.
 *
 * The dot sits at the row's vertical centre; lines run edge to edge, so consecutive rows join
 * up seamlessly without either row knowing anything about the other.
 */
export function CommitGraph({
  row,
  height,
  width,
}: {
  row: GraphRow;
  height: number;
  width: number;
}) {
  const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const mid = height / 2;

  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      // Stated rather than left to the attributes: inside a stretching flex row the element
      // takes the row's cross size and the strokes end up drawn at a fraction of their height.
      style={{ overflow: "visible", width, height }}
    >
      {/* Lines that pass this commit by, drawn first so the dot sits on top of them. */}
      {row.through.map((line) => (
        <line
          key={`t${line.lane}`}
          x1={x(line.lane)}
          y1={0}
          x2={x(line.lane)}
          y2={height}
          stroke={laneColour(line.colour)}
          strokeWidth={1.5}
          opacity={0.75}
        />
      ))}

      {/* The line coming down into this dot from the commits above it. */}
      <line
        x1={x(row.lane)}
        y1={0}
        x2={x(row.lane)}
        y2={mid}
        stroke={laneColour(row.colour)}
        strokeWidth={1.5}
      />

      {/*
       * Lines merging in, curved rather than angled.
       *
       * A merge is the one place two lanes meet, and a bezier reads as one line arriving
       * where a corner reads as two lines that happen to touch.
       */}
      {row.merges.map((line) => (
        <path
          key={`m${line.from}`}
          d={`M ${x(line.from)} 0 C ${x(line.from)} ${mid * 0.6}, ${x(row.lane)} ${mid * 0.4}, ${x(row.lane)} ${mid}`}
          fill="none"
          stroke={laneColour(line.colour)}
          strokeWidth={1.5}
          opacity={0.85}
        />
      ))}

      {/* Lines leaving for this commit's parents. */}
      {row.out.map((line) =>
        line.to === row.lane ? (
          <line
            key={`o${line.to}`}
            x1={x(row.lane)}
            y1={mid}
            x2={x(row.lane)}
            y2={height}
            stroke={laneColour(line.colour)}
            strokeWidth={1.5}
          />
        ) : (
          <path
            key={`o${line.to}`}
            d={`M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + (height - mid) * 0.4}, ${x(line.to)} ${mid + (height - mid) * 0.6}, ${x(line.to)} ${height}`}
            fill="none"
            stroke={laneColour(line.colour)}
            strokeWidth={1.5}
            opacity={0.85}
          />
        ),
      )}

      {/*
       * A merge commit is drawn hollow.
       *
       * It has more than one parent, which is exactly the thing worth spotting while
       * scanning a column — and the ring says it without needing a legend.
       */}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={3.5}
        fill={
          row.commit.parents.length > 1
            ? "var(--color-shell)"
            : laneColour(row.colour)
        }
        stroke={laneColour(row.colour)}
        strokeWidth={1.8}
      />
    </svg>
  );
}
