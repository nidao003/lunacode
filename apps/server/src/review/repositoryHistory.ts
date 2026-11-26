import {
  GitCommandError,
  REVIEW_REPOSITORY_HISTORY_DEFAULT_LIMIT,
  REVIEW_REPOSITORY_HISTORY_MAX_TIPS,
  type ReviewCommitDetailsInput,
  type ReviewCommitDetailsResult,
  type ReviewRepositoryHistoryCommit,
  type ReviewRepositoryHistoryInput,
  type ReviewRepositoryHistoryResult,
  type ReviewRepositoryRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

const HISTORY_OUTPUT_BYTES = 1024 * 1024;
const DETAILS_OUTPUT_BYTES = 64 * 1024;
const REF_FORMAT =
  "%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(refname)%00%(HEAD)";
const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s";
const DETAILS_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b";

type Git = GitVcsDriver["Service"];

const execute = (
  git: Git,
  input: { readonly cwd: string },
  operation: string,
  args: ReadonlyArray<string>,
  maxOutputBytes = HISTORY_OUTPUT_BYTES,
) =>
  git.execute({
    operation,
    cwd: input.cwd,
    args,
    env: { LC_ALL: "C", GIT_NO_LAZY_FETCH: "1" },
    timeoutMs: 10_000,
    maxOutputBytes,
  });

function repositoryRef(
  objectName: string,
  peeledName: string,
  objectType: string,
  peeledType: string,
  refname: string,
  head: string,
): ReviewRepositoryRef | null {
  const sha = objectType === "commit" ? objectName : peeledType === "commit" ? peeledName : "";
  const [kind, prefix] = refname.startsWith("refs/heads/")
    ? (["branch", "refs/heads/"] as const)
    : refname.startsWith("refs/remotes/")
      ? (["remote", "refs/remotes/"] as const)
      : refname.startsWith("refs/tags/")
        ? (["tag", "refs/tags/"] as const)
        : [null, ""];
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha) || kind === null) return null;
  const name = refname.slice(prefix.length);
  return name ? { name, kind, current: head === "*", sha: sha.toLowerCase() } : null;
}

function parseRefs(stdout: string) {
  return stdout.split("\n").flatMap((line) => {
    if (!line) return [];
    const [
      objectName = "",
      peeledName = "",
      objectType = "",
      peeledType = "",
      refname = "",
      head = "",
    ] = line.split("\0");
    const ref = repositoryRef(objectName, peeledName, objectType, peeledType, refname, head);
    return ref === null ? [] : [ref];
  });
}

const readSnapshot = Effect.fn("ReviewService.repositoryHistory.snapshot")(function* (
  git: Git,
  input: ReviewRepositoryHistoryInput,
) {
  const refsResult = yield* execute(git, input, "ReviewService.getRepositoryHistory.refs", [
    "for-each-ref",
    `--count=${REVIEW_REPOSITORY_HISTORY_MAX_TIPS + 1}`,
    "--sort=-creatordate",
    `--format=${REF_FORMAT}`,
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const allRefs = parseRefs(refsResult.stdout);
  const refs = allRefs.slice(0, REVIEW_REPOSITORY_HISTORY_MAX_TIPS);
  let tipShas = [...new Set(refs.map((ref) => ref.sha))];
  if (input.scope === "current") {
    const head = yield* execute(git, input, "ReviewService.getRepositoryHistory.head", [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]).pipe(Effect.option);
    tipShas = head._tag === "None" ? [] : [head.value.stdout.trim().toLowerCase()];
  }
  return {
    refs,
    tipShas,
    truncated: refsResult.stdoutTruncated || allRefs.length > REVIEW_REPOSITORY_HISTORY_MAX_TIPS,
  };
});

export const readRepositoryHistory = Effect.fn("ReviewService.getRepositoryHistory.read")(
  function* (
    git: Git,
    input: ReviewRepositoryHistoryInput,
  ): Effect.fn.Return<ReviewRepositoryHistoryResult, GitCommandError> {
    const limit = input.limit ?? REVIEW_REPOSITORY_HISTORY_DEFAULT_LIMIT;
    const initial = input.cursor === undefined ? yield* readSnapshot(git, input) : null;
    const tipShas = input.cursor?.tipShas ?? initial?.tipShas ?? [];
    const refs = input.cursor?.refs ?? initial?.refs ?? [];
    if (tipShas.length === 0) {
      return { commits: [], nextCursor: null, truncated: initial?.truncated ?? false };
    }
    const offset = input.cursor?.offset ?? 0;
    const result = yield* execute(git, input, "ReviewService.getRepositoryHistory.log", [
      "log",
      "--date-order",
      "--no-notes",
      "--no-show-signature",
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      `--format=${LOG_FORMAT}`,
      "-z",
      ...tipShas,
      "--",
    ]);
    const refsBySha = new Map<string, string[]>();
    for (const ref of refs) {
      refsBySha.set(ref.sha, [...(refsBySha.get(ref.sha) ?? []), ref.name]);
    }
    const fields = result.stdout.split("\0");
    const commits: ReviewRepositoryHistoryCommit[] = [];
    for (let index = 0; index + 6 < fields.length; index += 7) {
      const sha = fields[index]!.toLowerCase();
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) continue;
      commits.push({
        sha,
        parentShas: fields[index + 1]!.split(" ")
          .filter(Boolean)
          .map((sha) => sha.toLowerCase()),
        authorName: fields[index + 2]!,
        authorEmail: fields[index + 3]!,
        authoredAt: fields[index + 4]!,
        committedAt: fields[index + 5]!,
        subject: fields[index + 6]!,
        refs: refsBySha.get(sha) ?? [],
      });
    }
    const truncated = (initial?.truncated ?? false) || result.stdoutTruncated;
    return {
      commits: commits.slice(0, limit),
      nextCursor:
        commits.length > limit && !result.stdoutTruncated
          ? { offset: offset + limit, tipShas, refs }
          : null,
      truncated,
    };
  },
);

const invalidCommit = (input: ReviewCommitDetailsInput) =>
  new GitCommandError({
    operation: "ReviewService.getCommitDetails",
    command: "git show",
    cwd: input.cwd,
    detail: "Selected commit is invalid or no longer available.",
  });

export const readCommitDetails = Effect.fn("ReviewService.getCommitDetails.read")(function* (
  git: Git,
  input: ReviewCommitDetailsInput,
): Effect.fn.Return<ReviewCommitDetailsResult, GitCommandError> {
  const sha = input.commitSha.toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.commitSha)) {
    return yield* invalidCommit(input);
  }
  const [metadata, refsResult, preview] = yield* Effect.all(
    [
      execute(
        git,
        input,
        "ReviewService.getCommitDetails.metadata",
        [
          "show",
          "-s",
          "--no-notes",
          "--no-show-signature",
          `-z`,
          `--format=${DETAILS_FORMAT}`,
          `${sha}^{commit}`,
          "--",
        ],
        DETAILS_OUTPUT_BYTES,
      ),
      execute(git, input, "ReviewService.getCommitDetails.refs", [
        "for-each-ref",
        `--count=${REVIEW_REPOSITORY_HISTORY_MAX_TIPS}`,
        `--format=${REF_FORMAT}`,
        `--points-at=${sha}`,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]),
      git.getReviewDiffPreview({ cwd: input.cwd, commitSha: sha, metadataOnly: true }),
    ],
    { concurrency: 3 },
  );
  const fields = metadata.stdout.split("\0");
  if (fields.length < 10) return yield* invalidCommit(input);
  const parentShas = fields[1]!
    .split(" ")
    .filter(Boolean)
    .map((sha) => sha.toLowerCase());
  const files = preview.sources.find((source) => source.kind === "commit")?.files ?? [];
  const refs = parseRefs(refsResult.stdout).map((ref) => ref.name);
  return {
    sha,
    parentShas,
    authorName: fields[2]!,
    authorEmail: fields[3]!,
    authoredAt: fields[4]!,
    committerName: fields[5]!,
    committerEmail: fields[6]!,
    committedAt: fields[7]!,
    subject: fields[8]!,
    body: fields.slice(9).join("\0").replace(/\0$/, "").replace(/\n$/, ""),
    files,
    insertions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    refs,
    truncated:
      metadata.stdoutTruncated || refsResult.stdoutTruncated || preview.incomplete === true,
  };
});
