/**
 * The session log, read for a person.
 *
 * One stream, four uses: viewing it by source, searching it, forking from a point in it, and
 * replaying it. They share a reader deliberately — three separate definitions of "what happened"
 * is three chances to disagree about it.
 */

export { readTrajectory, type TrajectorySource } from "./read.ts";
export { countBySource, filterTrajectory, matchRanges, type TrajectoryFilter } from "./filter.ts";
export { forkSession, type ForkResult } from "./fork.ts";
export { messagesUpTo, replaySession } from "./replay.ts";
export { SOURCE_LABEL, SOURCE_ORDER, type Entry, type Source } from "./types.ts";
