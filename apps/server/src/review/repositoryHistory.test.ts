import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { readCommitDetails, readRepositoryHistory } from "./repositoryHistory.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-history-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "ReviewService.repositoryHistory.test",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

it.live("reads stable repository history pages and commit details", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-history-repository-" });
    yield* git(cwd, ["init", "-b", "main"]);
    yield* git(cwd, ["config", "user.name", "Test User"]);
    yield* git(cwd, ["config", "user.email", "test@example.com"]);

    assert.deepStrictEqual(yield* readRepositoryHistory(driver, { cwd, scope: "current" }), {
      commits: [],
      nextCursor: null,
      truncated: false,
    });

    yield* fs.writeFileString(`${cwd}/README.md`, "one\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* git(cwd, ["commit", "-m", "initial"]);
    const initial = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["tag", "-a", "v1.0", "-m", "Version 1"]);

    yield* fs.writeFileString(`${cwd}/README.md`, "two\n");
    yield* git(cwd, ["commit", "-am", "second", "-m", "Body line 1\n\nBody line 2"]);
    const second = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["branch", "feature", second]);
    yield* git(cwd, ["update-ref", "refs/remotes/origin/feature", second]);

    yield* fs.writeFileString(`${cwd}/README.md`, "three\n");
    yield* git(cwd, ["commit", "-am", "third"]);

    const firstPage = yield* readRepositoryHistory(driver, { cwd, limit: 2 });
    assert.deepStrictEqual(
      firstPage.commits.map((commit) => commit.subject),
      ["third", "second"],
    );
    assert.deepStrictEqual(firstPage.commits[0]?.refs, ["main"]);
    assert.sameMembers([...(firstPage.commits[1]?.refs ?? [])], ["feature", "origin/feature"]);
    assert.isNotNull(firstPage.nextCursor);
    assert.isFalse(firstPage.truncated);

    const secondPage = yield* readRepositoryHistory(driver, {
      cwd,
      limit: 2,
      ...(firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor }),
    });
    assert.deepStrictEqual(
      secondPage.commits.map((commit) => commit.subject),
      ["initial"],
    );
    assert.deepStrictEqual(secondPage.commits[0]?.refs, ["v1.0"]);
    assert.isNull(secondPage.nextCursor);

    const details = yield* readCommitDetails(driver, { cwd, commitSha: second });
    assert.strictEqual(details.sha, second);
    assert.deepStrictEqual(details.parentShas, [initial]);
    assert.strictEqual(details.authorName, "Test User");
    assert.strictEqual(details.authorEmail, "test@example.com");
    assert.strictEqual(details.subject, "second");
    assert.strictEqual(details.body, "Body line 1\n\nBody line 2");
    assert.isFalse(details.body.includes("\0"));
    assert.strictEqual(details.insertions, 1);
    assert.strictEqual(details.deletions, 1);
    assert.deepStrictEqual(
      details.files.map((file) => file.path),
      ["README.md"],
    );
    assert.sameMembers([...details.refs], ["feature", "origin/feature"]);

    const invalid = yield* readCommitDetails(driver, { cwd, commitSha: "--help" }).pipe(
      Effect.flip,
    );
    assert.strictEqual(invalid._tag, "GitCommandError");
    assert.strictEqual(invalid.operation, "ReviewService.getCommitDetails");
  }).pipe(Effect.provide(TestLayer)),
);
