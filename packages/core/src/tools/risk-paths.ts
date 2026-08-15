/**
 * Where it may write, and what it may reach.
 *
 * Two questions about places rather than commands. Both have the same shape of answer: the project
 * and the scratch areas are where work happens, and everything else is worth a moment of someone's
 * attention.
 */

import { PROTECTED_PATH } from "./risk-tables.ts";
import { SAFE, risky, underScratchRoot, type RiskVerdict } from "./risk-shared.ts";

/**
 * Whether writing to this path needs a decision.
 *
 * Inside the project, writing is the work and is not worth interrupting. Outside it — a system
 * directory, someone's SSH keys — is a different act entirely, whoever asked for it.
 */
export function assessWrite(path: string, cwd: string): RiskVerdict {
	const normalised = path.replace(/\/+$/, "");
	/*
	 * Asked first, because on macOS the system temp directory lives under `/var` — which the
	 * protected-path list quite rightly covers. A file inside a directory whose entire purpose is
	 * scratch is not the case that list is about, and checking in the other order made every
	 * temporary file look like an attempt on the system.
	 */
	if (underScratchRoot(normalised, cwd)) return SAFE;
	if (PROTECTED_PATH.test(` ${normalised}`)) return risky("写入项目之外的敏感路径");
	if (/(^|\/)\.(zshrc|bashrc|profile|zprofile)$/.test(normalised)) return risky("修改 shell 启动文件");
	if (!normalised.startsWith(`${cwd.replace(/\/+$/, "")}/`) && normalised !== cwd.replace(/\/+$/, "")) {
		return risky("写入当前项目之外的位置");
	}
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
