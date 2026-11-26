import type {
  ReviewDiffChangeType,
  ReviewRepositoryHistoryCommit,
  ReviewRepositoryHistoryCursor,
  ReviewRepositoryHistoryResult,
  ReviewRepositoryRef,
} from "@t3tools/contracts";

export type RepositoryHistoryScope = "all" | "current";
export type RepositoryRefKind = "head" | "branch" | "remote" | "tag";
export type CommitLineageKind = "root" | "regular" | "merge";

export interface ClassifiedRepositoryRef {
  readonly name: string;
  readonly kind: RepositoryRefKind;
}

export interface MergedRepositoryHistory {
  readonly commits: ReadonlyArray<ReviewRepositoryHistoryCommit>;
  readonly nextCursor: ReviewRepositoryHistoryCursor | null;
  readonly truncated: boolean;
  readonly knownRefs: ReadonlyArray<ReviewRepositoryRef>;
}

/** Formats a commit SHA to the standard 7-character short hash. */
export function formatShortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Merges paginated repository history pages, deduplicating commits by SHA in page order. */
export function mergeRepositoryHistoryPages(
  pages: ReadonlyArray<ReviewRepositoryHistoryResult>,
): MergedRepositoryHistory {
  const seen = new Set<string>();
  const commits: Array<ReviewRepositoryHistoryCommit> = [];
  let truncated = false;
  let knownRefs: ReadonlyArray<ReviewRepositoryRef> = [];

  for (const page of pages) {
    if (page.truncated) {
      truncated = true;
    }
    if (knownRefs.length === 0 && page.nextCursor?.refs.length) {
      knownRefs = page.nextCursor.refs;
    }
    for (const commit of page.commits) {
      if (seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      commits.push(commit);
    }
  }

  const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined;
  return {
    commits,
    nextCursor: lastPage?.nextCursor ?? null,
    truncated,
    knownRefs,
  };
}

/** Filters loaded repository commits by SHA, subject, author, or ref name. */
export function filterRepositoryHistoryCommits(
  commits: ReadonlyArray<ReviewRepositoryHistoryCommit>,
  rawQuery: string,
): ReadonlyArray<ReviewRepositoryHistoryCommit> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return commits;

  return commits.filter((commit) => {
    if (commit.sha.toLowerCase().includes(query)) return true;
    if (commit.subject.toLowerCase().includes(query)) return true;
    if (commit.authorName.toLowerCase().includes(query)) return true;
    if (commit.authorEmail.toLowerCase().includes(query)) return true;
    for (const ref of commit.refs) {
      if (ref.toLowerCase().includes(query)) return true;
    }
    return false;
  });
}

/** Classifies a ref label using known cursor refs when available, falling back to safe heuristics. */
export function classifyRepositoryRef(
  refName: string,
  currentBranch?: string | null,
  knownRefs?: ReadonlyArray<ReviewRepositoryRef>,
): ClassifiedRepositoryRef {
  if (currentBranch && refName === currentBranch) {
    return { name: refName, kind: "head" };
  }
  if (knownRefs) {
    const match = knownRefs.find((ref) => ref.name === refName);
    if (match) {
      return { name: refName, kind: match.current ? "head" : match.kind };
    }
  }
  if (refName.startsWith("origin/") || refName.startsWith("upstream/")) {
    return { name: refName, kind: "remote" };
  }
  return { name: refName, kind: "branch" };
}

/** Identifies whether a commit is a root commit, regular commit, or merge commit. */
export function summarizeCommitLineage(parentShas: ReadonlyArray<string>): CommitLineageKind {
  if (parentShas.length === 0) return "root";
  if (parentShas.length > 1) return "merge";
  return "regular";
}

/** Returns a concise Chinese label for a file's change type in commit details. */
export function formatCommitChangeTypeLabel(changeType?: ReviewDiffChangeType): string {
  switch (changeType) {
    case "new":
      return "新增";
    case "deleted":
      return "删除";
    case "rename-pure":
      return "重命名";
    case "rename-changed":
      return "重命名并修改";
    case "change":
    default:
      return "修改";
  }
}

/** Formats author and (when distinct) committer display strings for commit inspection. */
export function formatCommitPeople(input: {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName?: string;
  readonly committerEmail?: string;
}): { readonly author: string; readonly committer: string | null } {
  const author = input.authorEmail
    ? `${input.authorName} <${input.authorEmail}>`
    : input.authorName;
  const hasDistinctCommitter =
    input.committerName !== undefined &&
    (input.committerName !== input.authorName ||
      (input.committerEmail ?? "") !== input.authorEmail);
  if (!hasDistinctCommitter) {
    return { author, committer: null };
  }
  const committer = input.committerEmail
    ? `${input.committerName} <${input.committerEmail}>`
    : input.committerName;
  return { author, committer };
}
