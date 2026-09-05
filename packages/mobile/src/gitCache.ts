import type { BranchList, GitCommit, GitStatus } from "./protocol";

interface GitCacheEntry {
	status: GitStatus | null;
	commits: GitCommit[];
	branchList: BranchList | null;
	lastUpdated: number;
}

const gitCacheByCwd = new Map<string, GitCacheEntry>();

export function getGitCache(cwd: string): GitCacheEntry | undefined {
	return gitCacheByCwd.get(cwd);
}

export function setGitStatusCache(cwd: string, status: GitStatus | null) {
	const prev = gitCacheByCwd.get(cwd) || {
		status: null,
		commits: [],
		branchList: null,
		lastUpdated: 0,
	};
	gitCacheByCwd.set(cwd, {
		...prev,
		status,
		lastUpdated: Date.now(),
	});
}

export function setGitHistoryCache(cwd: string, commits: GitCommit[]) {
	const prev = gitCacheByCwd.get(cwd) || {
		status: null,
		commits: [],
		branchList: null,
		lastUpdated: 0,
	};
	gitCacheByCwd.set(cwd, {
		...prev,
		commits,
		lastUpdated: Date.now(),
	});
}

export function setGitBranchesCache(cwd: string, branchList: BranchList | null) {
	const prev = gitCacheByCwd.get(cwd) || {
		status: null,
		commits: [],
		branchList: null,
		lastUpdated: 0,
	};
	gitCacheByCwd.set(cwd, {
		...prev,
		branchList,
		lastUpdated: Date.now(),
	});
}
