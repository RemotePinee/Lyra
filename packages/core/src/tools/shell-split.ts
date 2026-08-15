/**
 * Taking a command line apart.
 *
 * `&&`, `||`, `;`, `|` and newlines each start a new command; `$( )` and backticks nest one inside
 * another. Nothing here judges anything — it exists so that whatever does can look at one command
 * at a time, because a chain is exactly as dangerous as its most dangerous link.
 */

/**
 * Splits a command line into the individual commands it runs.
 *
 * `&&`, `||`, `;`, `|` and newlines all start a new command; `$( )` and backticks nest one
 * inside another. Every piece is judged on its own, because a chain is exactly as dangerous as
 * its most dangerous link.
 */
export function splitCommands(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let depth = 0;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (quote) {
			// Inside single quotes nothing is special; inside double quotes only `$(` still is.
			if (char === quote) quote = null;
			else if (quote === '"' && char === "$" && next === "(") {
				current += char;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "$" && next === "(") {
			depth++;
			i++;
			parts.push(current);
			current = "";
			continue;
		}
		if (char === "`") {
			parts.push(current);
			current = "";
			continue;
		}
		if (char === ")" && depth > 0) {
			depth--;
			parts.push(current);
			current = "";
			continue;
		}
		if (char === ";" || char === "\n" || (char === "&" && next === "&") || (char === "|" && next === "|")) {
			if (char === "&" || char === "|") i++;
			parts.push(current);
			current = "";
			continue;
		}
		if (char === "|" || char === "&") {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}
