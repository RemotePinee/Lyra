/**
 * The browser-safe half of the trajectory.
 *
 * Reading the log needs a filesystem; filtering, labelling and highlighting what was read does not.
 * They are separated by an export path rather than by convention, because the renderer importing
 * the main barrel is how `node:os` ended up being asked for inside a browser — a mistake that
 * cannot be made twice if the door is not there.
 */

export { countBySource, filterTrajectory, matchRanges, type TrajectoryFilter } from "./trajectory/filter.ts";
export { SOURCE_LABEL, SOURCE_ORDER, type Entry, type Source } from "./trajectory/types.ts";
