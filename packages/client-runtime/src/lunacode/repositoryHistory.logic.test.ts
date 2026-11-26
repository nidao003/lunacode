import type {
  ReviewCommitSha,
  ReviewRepositoryHistoryCommit,
  ReviewRepositoryHistoryResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyRepositoryRef,
  filterRepositoryHistoryCommits,
  formatCommitChangeTypeLabel,
  formatCommitPeople,
  formatShortSha,
  mergeRepositoryHistoryPages,
  summarizeCommitLineage,
} from "./repositoryHistory.logic.ts";

const SHA_1 = "1111111111111111111111111111111111111111" as ReviewCommitSha;
const SHA_2 = "2222222222222222222222222222222222222222" as ReviewCommitSha;
const SHA_3 = "3333333333333333333333333333333333333333" as ReviewCommitSha;

function makeCommit(
  sha: ReviewCommitSha,
  overrides: Partial<ReviewRepositoryHistoryCommit> = {},
): ReviewRepositoryHistoryCommit {
  return {
    sha,
    parentShas: [],
    subject: "feat: initial commit",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    authoredAt: "2026-11-26T00:00:00Z",
    committedAt: "2026-11-26T00:00:00Z",
    refs: [],
    ...overrides,
  };
}

describe("repositoryHistory.logic", () => {
  it("merges paginated results without duplicate commits and keeps latest cursor", () => {
    const page1: ReviewRepositoryHistoryResult = {
      commits: [
        makeCommit(SHA_3, { parentShas: [SHA_2], refs: ["lunacode"] }),
        makeCommit(SHA_2, { parentShas: [SHA_1], refs: ["origin/main"] }),
      ],
      nextCursor: {
        offset: 2,
        tipShas: [SHA_3],
        refs: [
          { name: "lunacode", kind: "branch", current: true, sha: SHA_3 },
          { name: "origin/main", kind: "remote", current: false, sha: SHA_2 },
          { name: "v0.1.12", kind: "tag", current: false, sha: SHA_1 },
        ],
      },
      truncated: false,
    };
    const page2: ReviewRepositoryHistoryResult = {
      commits: [
        makeCommit(SHA_2, { parentShas: [SHA_1], refs: ["origin/main"] }),
        makeCommit(SHA_1, { parentShas: [], refs: ["v0.1.12"] }),
      ],
      nextCursor: null,
      truncated: true,
    };

    const merged = mergeRepositoryHistoryPages([page1, page2]);
    expect(merged.commits.map((commit) => commit.sha)).toEqual([SHA_3, SHA_2, SHA_1]);
    expect(merged.nextCursor).toBeNull();
    expect(merged.truncated).toBe(true);
    expect(merged.knownRefs).toHaveLength(3);
  });

  it("filters commits across sha, subject, author, email, and refs", () => {
    const commits = [
      makeCommit(SHA_3, {
        subject: "fix: resolve websocket race",
        authorName: "Bob",
        authorEmail: "bob@example.com",
        refs: ["feature/ws-fix"],
      }),
      makeCommit(SHA_2, {
        subject: "docs: update guide",
        authorName: "Alice",
        authorEmail: "alice@example.com",
        refs: ["v0.1.12"],
      }),
    ];

    expect(filterRepositoryHistoryCommits(commits, "")).toHaveLength(2);
    expect(filterRepositoryHistoryCommits(commits, "2222222")).toEqual([commits[1]]);
    expect(filterRepositoryHistoryCommits(commits, "WEBSOCKET")).toEqual([commits[0]]);
    expect(filterRepositoryHistoryCommits(commits, "alice@")).toEqual([commits[1]]);
    expect(filterRepositoryHistoryCommits(commits, "ws-fix")).toEqual([commits[0]]);
    expect(filterRepositoryHistoryCommits(commits, "v0.1.12")).toEqual([commits[1]]);
  });

  it("classifies refs, lineage, change types, and author/committer display", () => {
    const knownRefs = [
      { name: "lunacode", kind: "branch" as const, current: true, sha: SHA_3 },
      { name: "origin/main", kind: "remote" as const, current: false, sha: SHA_2 },
      { name: "v0.1.12", kind: "tag" as const, current: false, sha: SHA_1 },
    ];

    expect(classifyRepositoryRef("lunacode", "lunacode", knownRefs)).toEqual({
      name: "lunacode",
      kind: "head",
    });
    expect(classifyRepositoryRef("origin/main", "lunacode", knownRefs)).toEqual({
      name: "origin/main",
      kind: "remote",
    });
    expect(classifyRepositoryRef("v0.1.12", "lunacode", knownRefs)).toEqual({
      name: "v0.1.12",
      kind: "tag",
    });
    expect(classifyRepositoryRef("feature/local", "lunacode")).toEqual({
      name: "feature/local",
      kind: "branch",
    });

    expect(formatShortSha(SHA_1)).toBe("1111111");
    expect(summarizeCommitLineage([])).toBe("root");
    expect(summarizeCommitLineage([SHA_1])).toBe("regular");
    expect(summarizeCommitLineage([SHA_1, SHA_2])).toBe("merge");

    expect(formatCommitChangeTypeLabel("new")).toBe("新增");
    expect(formatCommitChangeTypeLabel("deleted")).toBe("删除");
    expect(formatCommitChangeTypeLabel("rename-pure")).toBe("重命名");
    expect(formatCommitChangeTypeLabel("rename-changed")).toBe("重命名并修改");
    expect(formatCommitChangeTypeLabel("change")).toBe("修改");

    expect(
      formatCommitPeople({
        authorName: "Alice",
        authorEmail: "alice@example.com",
        committerName: "Alice",
        committerEmail: "alice@example.com",
      }),
    ).toEqual({ author: "Alice <alice@example.com>", committer: null });

    expect(
      formatCommitPeople({
        authorName: "Alice",
        authorEmail: "alice@example.com",
        committerName: "GitHub",
        committerEmail: "noreply@github.com",
      }),
    ).toEqual({
      author: "Alice <alice@example.com>",
      committer: "GitHub <noreply@github.com>",
    });
  });
});
