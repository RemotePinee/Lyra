/**
 * The registry contract.
 *
 * Nothing here touches a filesystem, a network or a DOM — it is types and pure functions, because
 * it is imported by a Node main process, a V8 isolate at the edge and a browser bundle, and the
 * only code that can be all three is code that assumes none of them.
 */

export {
	BUNDLE_KINDS,
	isBundleKind,
	isEntryStatus,
	isValidId,
	normalise,
	readIndex,
	slugOf,
	type BundleKind,
	type EntryStatus,
	type RegistryEntry,
	type RegistryIndex,
} from "./entry.ts";

export {
	DEFAULT_PAGE_SIZE,
	ERROR_STATUS,
	MAX_PAGE_SIZE,
	isEntrySort,
	type ApiError,
	type ApiErrorCode,
	type BuildResult,
	type EntryDetail,
	type EntryQuery,
	type EntrySort,
	type EntrySummary,
	type Page,
	type RegistryStats,
	type ReviewRequest,
	type SubmitRequest,
	type VersionInfo,
	type Viewer,
} from "./api.ts";

export { normalisePath, ownerAvatar, parseRepo, tarballUrl, type RepoRef } from "./repo.ts";
