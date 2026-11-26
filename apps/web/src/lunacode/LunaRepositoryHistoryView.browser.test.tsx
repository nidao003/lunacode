import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type ReviewCommitDetailsResult,
  type ReviewCommitSha,
  type ReviewRepositoryHistoryResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const SHA_1 = "1111111111111111111111111111111111111111" as ReviewCommitSha;
const SHA_2 = "2222222222222222222222222222222222222222" as ReviewCommitSha;
const SHA_3 = "3333333333333333333333333333333333333333" as ReviewCommitSha;

const state = vi.hoisted(() => ({
  historyAtoms: new Map<string, ResultAtom<ReviewRepositoryHistoryResult>>(),
  detailAtoms: new Map<string, ResultAtom<ReviewCommitDetailsResult>>(),
}));

vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    repositoryHistory: ({
      input,
    }: {
      input: { scope?: "all" | "current"; cursor?: { offset: number } };
    }) => {
      const key = `${input.scope ?? "all"}:${input.cursor?.offset ?? 0}`;
      const atom = state.historyAtoms.get(key);
      if (!atom) {
        throw new Error(`Unexpected repositoryHistory query: ${key}`);
      }
      return atom;
    },
    commitDetails: ({ input }: { input: { commitSha: string } }) => {
      const atom = state.detailAtoms.get(input.commitSha);
      if (!atom) {
        throw new Error(`Unexpected commitDetails query: ${input.commitSha}`);
      }
      return atom;
    },
  },
}));

import { LunaRepositoryHistoryView } from "./LunaRepositoryHistoryView";

function setup() {
  state.historyAtoms.clear();
  state.detailAtoms.clear();

  const allPage1: ReviewRepositoryHistoryResult = {
    commits: [
      {
        sha: SHA_3,
        parentShas: [SHA_2],
        subject: "feat: support full git history browser",
        authorName: "Alice",
        authorEmail: "alice@example.com",
        authoredAt: "2026-11-26T00:00:00Z",
        committedAt: "2026-11-26T00:00:00Z",
        refs: ["lunacode", "origin/lunacode"],
      },
    ],
    nextCursor: {
      offset: 1,
      tipShas: [SHA_3],
      refs: [
        { name: "lunacode", kind: "branch", current: true, sha: SHA_3 },
        { name: "origin/lunacode", kind: "remote", current: false, sha: SHA_3 },
        { name: "v0.1.12", kind: "tag", current: false, sha: SHA_2 },
      ],
    },
    truncated: false,
  };

  const allPage2: ReviewRepositoryHistoryResult = {
    commits: [
      {
        sha: SHA_2,
        parentShas: [SHA_1],
        subject: "chore: merge upstream v0.1.12",
        authorName: "Bob",
        authorEmail: "bob@example.com",
        authoredAt: "2026-11-25T10:00:00Z",
        committedAt: "2026-11-25T10:00:00Z",
        refs: ["v0.1.12"],
      },
    ],
    nextCursor: null,
    truncated: false,
  };

  const currentPage1: ReviewRepositoryHistoryResult = {
    commits: [
      {
        sha: SHA_1,
        parentShas: [],
        subject: "init: root commit",
        authorName: "Charlie",
        authorEmail: "charlie@example.com",
        authoredAt: "2026-11-24T00:00:00Z",
        committedAt: "2026-11-24T00:00:00Z",
        refs: [],
      },
    ],
    nextCursor: null,
    truncated: false,
  };

  const makeHistoryAtom = (
    result: ReviewRepositoryHistoryResult,
  ): ResultAtom<ReviewRepositoryHistoryResult> =>
    Atom.make<AsyncResult.AsyncResult<ReviewRepositoryHistoryResult, Error>>(
      AsyncResult.success(result),
    );
  const makeDetailAtom = (
    result: ReviewCommitDetailsResult,
  ): ResultAtom<ReviewCommitDetailsResult> =>
    Atom.make<AsyncResult.AsyncResult<ReviewCommitDetailsResult, Error>>(
      AsyncResult.success(result),
    );

  state.historyAtoms.set("all:0", makeHistoryAtom(allPage1));
  state.historyAtoms.set("all:1", makeHistoryAtom(allPage2));
  state.historyAtoms.set("current:0", makeHistoryAtom(currentPage1));

  state.detailAtoms.set(
    SHA_3,
    makeDetailAtom({
      sha: SHA_3,
      parentShas: [SHA_2],
      subject: "feat: support full git history browser",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      committerName: "Alice",
      committerEmail: "alice@example.com",
      authoredAt: "2026-11-26T00:00:00Z",
      committedAt: "2026-11-26T00:00:00Z",
      refs: ["lunacode", "origin/lunacode"],
      body: "Added read-only repository history inspection.",
      files: [
        {
          path: "apps/web/src/lunacode/LunaRepositoryHistoryView.tsx",
          previousPath: null,
          changeType: "new",
          additions: 120,
          deletions: 0,
        },
      ],
      insertions: 120,
      deletions: 0,
      truncated: false,
    }),
  );

  state.detailAtoms.set(
    SHA_2,
    makeDetailAtom({
      sha: SHA_2,
      parentShas: [SHA_1],
      subject: "chore: merge upstream v0.1.12",
      authorName: "Bob",
      authorEmail: "bob@example.com",
      committerName: "Bob",
      committerEmail: "bob@example.com",
      authoredAt: "2026-11-25T10:00:00Z",
      committedAt: "2026-11-25T10:00:00Z",
      refs: ["v0.1.12"],
      body: "",
      files: [],
      insertions: 0,
      deletions: 0,
      truncated: false,
    }),
  );

  return AtomRegistry.make();
}

it("loads paginated history, switches branch scope, navigates parent commits, and opens diff", async () => {
  const registry = setup();
  const onOpenCommitDiff = vi.fn();

  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <div className="flex h-[680px] flex-col">
        <LunaRepositoryHistoryView
          environmentId={EnvironmentId.make("env-1")}
          cwd="/repo"
          currentBranch="lunacode"
          canReadFiles
          fileAccessPending={false}
          fileAccessError={null}
          commitLinkIdentity={null}
          timestampFormat="24-hour"
          workspaceMutationId={null}
          onOpenCommitDiff={onOpenCommitDiff}
          onOpenCommitUrl={() => {}}
        />
      </div>
    </RegistryContext.Provider>,
  );

  await expect
    .element(screen.getByText("feat: support full git history browser"))
    .toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "加载更多提交" }));
  await expect.element(screen.getByText("chore: merge upstream v0.1.12")).toBeInTheDocument();

  await userEvent.click(
    screen.getByRole("button", { name: /feat: support full git history browser/ }),
  );
  await expect
    .element(screen.getByText("Added read-only repository history inspection."))
    .toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: SHA_2.slice(0, 7) }));
  await expect.element(screen.getByText("该提交没有可展示的文件变更。")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "查看提交 Diff" }));
  expect(onOpenCommitDiff).toHaveBeenCalledWith(SHA_2);

  await userEvent.click(screen.getByRole("button", { name: "当前分支" }));
  await expect.element(screen.getByText("init: root commit")).toBeInTheDocument();
});
