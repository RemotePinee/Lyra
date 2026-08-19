import { withinOrIs } from "../platform.ts";
import { SAFE, risky, scratchRoots, underScratchRoot, wipesScratchRoot, type RiskVerdict } from "./risk-shared.ts";
import { NEVER_UNATTENDED, PROTECTED_PATH, RISKY_SUBCOMMANDS } from "./risk-tables.ts";
import { splitCommands } from "./shell-split.ts";
/**
 * How dangerous an operation is, so that "帮我批准" can mean what it says.
 *
 * The first version of this was an allow-list: a command was waved through only if its first
 * word was one of about thirty read-only programs, and *any* shell metacharacter disqualified
 * it outright. The reasoning was sound in isolation — `ls && rm -rf /` really does start with
 * `ls` — but the effect was that a mode advertised as "only ask about risky things" asked about
 * nearly everything, because models write `cd x && git log; echo ---` rather than bare `ls`.
 * A permission prompt that fires constantly is not a safety feature; it is something people
 * learn to click through, which is strictly worse than not having it.
 *
 * So this inverts: everything is allowed unless it matches something genuinely destructive.
 * The list below is not "things that write" — writing is the job — but "things you cannot take
 * back": deleting, force-pushing, rewriting history, escalating privileges, piping the network
 * into a shell, touching anything outside the project.
 */




function firstWord(command: string): string {
	// Leading `VAR=value` assignments are not the program being run.
	const program = command.split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	return (program ?? "").replace(/^.*\//, "");
}

/**
 * Judge one command — no chaining, no substitution; `assessCommand` splits those first.
 */
/**
 * A wildcard with nothing in front of it.
 *
 * `rm -rf *` is the working directory and everything in it — the command people mean when they
 * warn you about `rm -rf`. `rm -rf server/data/uploads/*` is a named directory being emptied,
 * which is what re-seeding a database or clearing an upload folder looks like, and is no more
 * dangerous than deleting that directory. Treating the two as the same thing meant ordinary
 * housekeeping stopped an unattended run.
 *
 * The test is whether anything survives removing the wildcard segments: `*` and `./*` leave
 * nothing; `a/b/*` leaves `a/b`.
 */
function bareGlob(target: string): boolean {
	if (!/[*?]/.test(target)) return false;
	const prefix = target
		.split("/")
		.filter((segment) => !/[*?]/.test(segment))
		.filter((segment) => segment !== "" && segment !== ".");
	return prefix.length === 0 || prefix.includes("..");
}




function judgeSingle(command: string, contained = false, cwd?: string): RiskVerdict {
	const head = firstWord(command);
	if (!head) return SAFE;

	const never = NEVER_UNATTENDED.get(head);
	if (never) return risky(never);

	// `rm` is the one worth reading closely: removing a file is routine, removing a tree is not.
	if (head === "rm") {
		/*
		 * A recursive delete is judged by its target, at the user's direction.
		 *
		 * Clearing `src/data` to reseed a database, or `dist` to rebuild, is a step inside work
		 * that was asked for, and stopping at each one is what stops an unattended run being
		 * unattended. The user chose this trade explicitly: relative paths inside the workspace
		 * proceed; the workspace itself (`.`), a bare wildcard, a home or absolute path, anything
		 * climbing out with `..`, and any chain that has `cd`-ed elsewhere first still ask.
		 */
		if (/\s-[a-zA-Z]*[rR]/.test(command)) {
			const targets = command.split(/\s+/).slice(1).filter((word) => !word.startsWith("-"));
			const reckless = targets.some(
				(t) =>
					!t ||
					t.startsWith("~") ||
					t === "." ||
					t === ".." ||
					bareGlob(t) ||
					wipesScratchRoot(t, cwd) ||
					(t.startsWith("/") && !underScratchRoot(t, cwd)),
			);
			const climbs = targets.some((t) => t.split("/").includes(".."));
			if (targets.length === 0 || reckless || climbs || !contained) return risky("递归删除目录");
		}
		/*
		 * A glob delete is judged by where it points, not by the glob.
		 *
		 * Rebuilding a database or clearing a build directory is ordinary work — and it is what
		 * `rm -f data/blog.db*` is. What cannot be taken back is the same command aimed outside
		 * the project, so that is what this asks about: an absolute or home-relative target, or
		 * a chain that has stepped out of the workspace first.
		 */
		if (/\s-[a-zA-Z]*f/.test(command) && /[*?]/.test(command)) {
			const targets = command.split(/\s+/).slice(1).filter((word) => !word.startsWith("-"));
			const outside = targets.some(
				(t) => t.startsWith("~") || wipesScratchRoot(t, cwd) || (t.startsWith("/") && !underScratchRoot(t, cwd)),
			);
			if (outside || !contained) return risky("强制删除通配匹配的文件");
		}
		if (/(^|\s)\/(\s|$)|\s~\/?(\s|$)/.test(command)) return risky("删除根目录或主目录");
	}

	if (head === "git") {
		const sub = command.split(/\s+/)[1] ?? "";
		// A force push replaces what other people have; a plain push does not.
		// `--force-with-lease` is the careful form, but it still replaces the remote branch.
		if (sub === "push" && /(--force|(^|\s)-f(\s|$))/.test(command)) return risky("强制推送会覆盖远程历史");
		if (sub === "reset" && /--hard/.test(command)) return risky("丢弃所有未提交的改动");
		const table = RISKY_SUBCOMMANDS.get("git");
		const reason = table?.get(sub);
		// `git checkout -b` and `git restore --staged` take nothing away.
		if (sub === "checkout" && /\s-b(\s|$)/.test(command)) return SAFE;
		if (sub === "restore" && /--staged/.test(command) && !/--worktree/.test(command)) return SAFE;
		if (sub === "reset" || sub === "clean") return reason ? risky(reason) : SAFE;
		if (reason && (sub === "rebase" || sub === "filter-branch")) return risky(reason);
		return SAFE;
	}

	const table = RISKY_SUBCOMMANDS.get(head);
	if (table) {
		const reason = table.get(command.split(/\s+/)[1] ?? "");
		if (reason) return risky(reason);
	}

	// A redirect into a system location, or an edit of the shell's own startup files.
	if (/>\s*[^&\s]/.test(command) && PROTECTED_PATH.test(command)) return risky("写入项目之外的系统路径");
	if (/>\s*~?\/?\.(zshrc|bashrc|profile|zprofile)\b/.test(command)) return risky("修改 shell 启动文件");

	return SAFE;
}

/**
 * Judge a whole command line, including everything it chains or substitutes.
 *
 * A pipeline is risky if any stage is: `cat x | sudo tee /etc/hosts` is not made safe by
 * starting with `cat`.
 */
export function assessCommand(command: string, cwd?: string): RiskVerdict {
	/*
	 * Checked against the whole line, before it is taken apart.
	 *
	 * Downloading something and handing it straight to a shell is the classic way to run code
	 * nobody has read — and it is invisible once split, because `curl url` and `sh` are each
	 * unremarkable on their own. The danger is in the join.
	 */
	if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/.test(command)) return risky("下载并直接执行脚本");

	/*
	 * Whether the command stays inside the project.
	 *
	 * `cd` is what makes a relative path ambiguous: `rm -f build/*` is housekeeping, and
	 * `cd /etc && rm -f *` is the same three characters somewhere it must never happen. If every
	 * `cd` in the chain lands inside the workspace, a relative path is a path within it.
	 */
	const contained = cwd ? staysInside(command, cwd) : false;

	for (const piece of splitCommands(command)) {
		const verdict = judgeSingle(piece, contained, cwd);
		if (verdict.risky) return verdict;
	}
	return SAFE;
}


/**
 * Whether every directory the command changes into is within the workspace.
 *
 * Conservative by construction: a `cd` whose destination cannot be read literally — a variable,
 * a substitution, `-` — counts as leaving, because what it resolves to is not knowable here.
 */
function staysInside(command: string, cwd: string): boolean {
	const root = cwd.replace(/\/+$/, "");
	for (const piece of splitCommands(command)) {
		const match = /^\s*cd\s+(\S+)/.exec(piece);
		if (!match) continue;
		const target = match[1].replace(/^['"]|['"]$/g, "");
		if (target.startsWith("~") || target === "-" || /[$`]/.test(target)) return false;
		if (target.startsWith("/")) {
			if (withinOrIs(root, target)) continue;
			/*
			 * A scratch directory is somewhere work legitimately happens, not somewhere it escaped
			 * to — and here the root itself counts. `cd /tmp` is working there; `rm -rf /tmp` is
			 * something else entirely, and that is judged separately.
			 */
			if (underScratchRoot(target, cwd) || scratchRoots(cwd).includes(target.replace(/\/+$/, ""))) continue;
			return false;
		}
		// A relative `cd` can still climb out with `..`.
		if (target.split("/").includes("..")) return false;
	}
	return true;
}

export { splitCommands } from "./shell-split.ts";

export { assessWrite } from "./risk-paths.ts";
export { assessNetwork, isPrivateAddress, type NetworkVerdict } from "./risk-network.ts";
