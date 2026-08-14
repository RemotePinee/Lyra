/**
 * What to call the waiting.
 *
 * A turn is mostly silence — a spinner and a number counting up. The number says how long, the
 * spinner says it is alive, and neither says what kind of waiting this is. Reading a file, running
 * a test and hunting through a codebase feel different to sit through, and naming the difference
 * is most of what makes a long turn bearable.
 *
 * Written here, not asked of the model. Making it produce a status line would cost a request per
 * phrase, arrive too late to describe what it is doing now, and put one more thing in the way of
 * the actual answer. These are picked from what the agent has just done, which the window already
 * knows.
 *
 * The tone is deliberately colloquial, and in English — it sits beside `42s · 63.6k tokens`, and
 * a Chinese phrase in that row read as a different voice interrupting a technical readout. This
 * is the app muttering to itself in the corner of the screen, not a progress dialog reporting to
 * a manager.
 */

/** The kinds of waiting worth distinguishing, in the order they get checked. */
export type Mood = "reading" | "writing" | "running" | "searching" | "testing" | "browsing" | "planning" | "thinking";

const WORDS: Record<Mood, string[]> = {
	reading: ["Reading up", "Skimming", "Digging in", "Getting the lay of it", "Poking around the source"],
	writing: ["Writing", "Drafting", "Putting it down", "Getting it on paper", "Laying down code"],
	running: ["Running it", "Kicking it off", "Letting it rip", "Waiting on the shell", "Turning the crank"],
	searching: ["Hunting", "Rummaging", "Casting about", "Following the thread", "Combing through"],
	testing: ["Proving it", "Running the gauntlet", "Making sure", "Putting it through its paces"],
	browsing: ["Having a look", "Loading the page", "Peeking at the web"],
	planning: ["Plotting", "Lining it up", "Sketching the order", "Working out the steps"],
	thinking: ["Thinking", "Mulling", "Turning it over", "Chewing on it", "Working it out", "Pondering"],
};

/** After this long on one step, the wording acknowledges that it is taking a while. */
const PATIENCE_MS = 45_000;
const LONG_WORDS = ["Still at it", "This one's stubborn", "Taking its time", "Nearly there", "Wrestling with it"];

const BY_TOOL: Record<string, Mood> = {
	read: "reading",
	symbol: "reading",
	write: "writing",
	edit: "writing",
	bash: "running",
	bash_output: "running",
	glob: "searching",
	grep: "searching",
	ls: "searching",
	todo_write: "planning",
	task: "planning",
	web_fetch: "browsing",
	web_search: "browsing",
	browser_act: "browsing",
	preview: "writing",
};

/** Commands that are really a test run, whatever tool they arrived through. */
const TEST_HINT = /\b(test|jest|vitest|pytest|spec|coverage)\b/i;

export function moodFor(toolName: string | undefined, summary: string | undefined): Mood {
	if (summary && TEST_HINT.test(summary)) return "testing";
	if (!toolName) return "thinking";
	return BY_TOOL[toolName] ?? "thinking";
}

/**
 * One phrase, chosen without a random number generator.
 *
 * Seeded by the mood and a slowly advancing tick so the same mood does not repeat the same word
 * back to back, and so a re-render never swaps the phrase on its own — only time does. Random
 * would change it on every paint, which is the flicker this is meant to avoid.
 */
export function phraseFor(mood: Mood, tick: number, elapsedMs: number): string {
	if (elapsedMs > PATIENCE_MS) return LONG_WORDS[tick % LONG_WORDS.length];
	const pool = WORDS[mood];
	return pool[tick % pool.length];
}
