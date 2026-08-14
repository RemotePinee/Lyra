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

export interface RiskVerdict {
	risky: boolean;
	/** Shown to the user in the approval prompt, so it says what specifically is dangerous. */
	reason?: string;
}

const SAFE: RiskVerdict = { risky: false };
const risky = (reason: string): RiskVerdict => ({ risky: true, reason });

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

/** Programs that are dangerous whatever their arguments. */
const NEVER_UNATTENDED = new Map<string, string>([
	["sudo", "以管理员身份执行"],
	["doas", "以管理员身份执行"],
	["su", "切换用户"],
	["shutdown", "关机或重启"],
	["reboot", "关机或重启"],
	["halt", "关机或重启"],
	["mkfs", "格式化磁盘"],
	["fdisk", "修改磁盘分区"],
	["diskutil", "修改磁盘"],
	["dd", "按块写设备，可能覆盖磁盘"],
	["shred", "不可恢复地擦除文件"],
	["chown", "更改文件归属"],
	["launchctl", "改动系统服务"],
	["systemctl", "改动系统服务"],
	["crontab", "改动定时任务"],
	["killall", "批量结束进程"],
]);

/** Subcommands that discard work or rewrite shared history. */
const RISKY_SUBCOMMANDS = new Map<string, Map<string, string>>([
	[
		"git",
		new Map([
			["reset", "可能丢弃未提交的改动"],
			["clean", "删除未跟踪的文件"],
			["rebase", "重写提交历史"],
			["filter-branch", "重写提交历史"],
			["checkout", "可能覆盖未提交的改动"],
			["restore", "可能丢弃未提交的改动"],
		]),
	],
	["npm", new Map([["publish", "发布到公共仓库"]])],
	["pnpm", new Map([["publish", "发布到公共仓库"]])],
	["yarn", new Map([["publish", "发布到公共仓库"]])],
	["docker", new Map([["system", "可能清理镜像与卷"]])],
	["kubectl", new Map([["delete", "删除集群资源"]])],
]);

/** Paths that are never the project, so writing to them is out of scope by definition. */
const PROTECTED_PATH = /(^|\s)(\/(bin|sbin|usr|etc|var|System|Library|Applications)\b|~\/\.(ssh|aws|gnupg|config\/gh)\b)/;

function firstWord(command: string): string {
	// Leading `VAR=value` assignments are not the program being run.
	const words = command.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	return (words[0] ?? "").replace(/^.*\//, "");
}

/**
 * Judge one command — no chaining, no substitution; `assessCommand` splits those first.
 */
function judgeSingle(command: string, contained = false): RiskVerdict {
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
				(t) => !t || t.startsWith("/") || t.startsWith("~") || t === "." || t === ".." || t.includes("*"),
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
			const outside = targets.some((t) => t.startsWith("/") || t.startsWith("~"));
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
		const verdict = judgeSingle(piece, contained);
		if (verdict.risky) return verdict;
	}
	return SAFE;
}

/**
 * Whether writing to this path needs a decision.
 *
 * Inside the project, writing is the work and is not worth interrupting. Outside it — a system
 * directory, someone's SSH keys — is a different act entirely, whoever asked for it.
 */
export function assessWrite(path: string, cwd: string): RiskVerdict {
	const normalised = path.replace(/\/+$/, "");
	if (PROTECTED_PATH.test(` ${normalised}`)) return risky("写入项目之外的敏感路径");
	if (/(^|\/)\.(zshrc|bashrc|profile|zprofile)$/.test(normalised)) return risky("修改 shell 启动文件");
	if (!normalised.startsWith(cwd.replace(/\/+$/, ""))) return risky("写入当前项目之外的位置");
	return SAFE;
}

/**
 * Whether reaching this address needs a decision.
 *
 * The machine's own ports are not the internet. An agent that has just started a dev server has
 * to open it to know whether it works, and asking about `http://localhost:4000/` interrupts the
 * one turn where the answer is obviously yes — while teaching the habit of clicking through, so
 * the prompt that does matter gets clicked through too.
 *
 * Anything that leaves the machine still asks: that is where data can go somewhere it cannot be
 * taken back from.
 */
export function assessNetwork(target: string): RiskVerdict {
	let host: string;
	try {
		host = new URL(target.trim()).hostname.toLowerCase();
	} catch {
		// Unparseable is not obviously safe, so it goes the careful way.
		return risky("无法解析的地址");
	}
	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return SAFE;
	// `*.localhost` resolves to the loopback by specification, and dev servers do use it.
	if (host.endsWith(".localhost")) return SAFE;
	return risky("访问外部网络");
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
			if (target !== root && !target.startsWith(`${root}/`)) return false;
			continue;
		}
		// A relative `cd` can still climb out with `..`.
		if (target.split("/").includes("..")) return false;
	}
	return true;
}
