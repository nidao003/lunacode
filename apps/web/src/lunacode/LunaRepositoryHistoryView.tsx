import { useAtomValue } from "@effect/atom-react";
import {
  classifyRepositoryRef,
  filterRepositoryHistoryCommits,
  formatCommitChangeTypeLabel,
  formatCommitPeople,
  formatShortSha,
  mergeRepositoryHistoryPages,
  summarizeCommitLineage,
  type RepositoryHistoryScope,
  type RepositoryRefKind,
} from "@t3tools/client-runtime/lunacode/repository-history";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import type {
  EnvironmentId,
  RepositoryIdentity,
  ReviewCommitDetailsResult,
  ReviewCommitSha,
  ReviewRepositoryHistoryCommit,
  ReviewRepositoryHistoryCursor,
  ReviewRepositoryHistoryResult,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useMessages } from "gt-react";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  SearchIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { type MouseEvent, useState } from "react";
import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import { formatRelativeTimeLabel, formatShortTimestamp } from "~/timestampFormat";

const HISTORY_PAGE_SIZE = 50;

const historyPagesFamily = Atom.family((serializedKey: string) => {
  const parsed = JSON.parse(serializedKey) as {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly scope: RepositoryHistoryScope;
    readonly workspaceMutationId: string | null;
    readonly refreshTick: number;
    readonly cursors: ReadonlyArray<ReviewRepositoryHistoryCursor>;
  };
  return Atom.make((get) => {
    const pages: Array<AsyncResult.AsyncResult<ReviewRepositoryHistoryResult, unknown>> = [];
    const baseInput = {
      cwd: parsed.cwd,
      scope: parsed.scope,
      limit: HISTORY_PAGE_SIZE,
    };
    const firstAtom = revisionedQuery(
      reviewEnvironment.repositoryHistory({
        environmentId: parsed.environmentId,
        input: baseInput,
      }),
      parsed.workspaceMutationId,
      { detail: `${parsed.scope}:${parsed.refreshTick}` },
    );
    pages.push(get(firstAtom));
    for (const cursor of parsed.cursors) {
      const pageAtom = revisionedQuery(
        reviewEnvironment.repositoryHistory({
          environmentId: parsed.environmentId,
          input: { ...baseInput, cursor },
        }),
        parsed.workspaceMutationId,
        { detail: `${parsed.scope}:${parsed.refreshTick}` },
      );
      pages.push(get(pageAtom));
    }
    return pages;
  }).pipe(Atom.withLabel(`lunacode:repository-history-pages:${serializedKey}`));
});

function refBadgeClassName(kind: RepositoryRefKind): string {
  switch (kind) {
    case "head":
      return "border-primary/40 bg-primary/15 text-primary";
    case "remote":
      return "border-border bg-secondary text-secondary-foreground";
    case "tag":
      return "border-warning/35 bg-warning-surface text-warning-foreground";
    case "branch":
      return "border-border bg-muted/70 text-muted-foreground";
  }
}

function RefBadge({
  refName,
  kind,
}: {
  readonly refName: string;
  readonly kind: RepositoryRefKind;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-40 items-center gap-1 rounded border px-1.5 py-px font-mono text-3xs leading-tight",
        refBadgeClassName(kind),
      )}
    >
      {kind === "tag" ? (
        <TagIcon className="size-2.5 shrink-0" aria-hidden />
      ) : (
        <GitBranchIcon className="size-2.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{refName}</span>
    </span>
  );
}

function CommitRow({
  commit,
  selected,
  currentBranch,
  knownRefs,
  onSelect,
}: {
  readonly commit: ReviewRepositoryHistoryCommit;
  readonly selected: boolean;
  readonly currentBranch?: string | null | undefined;
  readonly knownRefs: ReturnType<typeof mergeRepositoryHistoryPages>["knownRefs"];
  readonly onSelect: (sha: ReviewCommitSha) => void;
}) {
  const messages = useMessages();
  const lineage = summarizeCommitLineage(commit.parentShas);

  return (
    <button
      type="button"
      onClick={() => onSelect(commit.sha)}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 border-b border-border/50 px-3 py-2 text-left transition-colors",
        selected ? "bg-accent/70" : "hover:bg-accent/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {lineage === "merge" ? (
            <GitBranchIcon className="size-3.5 text-primary" aria-hidden />
          ) : (
            <GitCommitHorizontalIcon className="size-3.5" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {commit.subject || "(无提交说明)"}
        </span>
        <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">
          {formatShortSha(commit.sha)}
        </span>
      </div>

      {commit.refs.length > 0 || lineage === "merge" || lineage === "root" ? (
        <div className="flex flex-wrap items-center gap-1 ps-5">
          {lineage === "merge" ? (
            <span className="rounded border border-primary/30 bg-primary/10 px-1 py-px text-3xs text-primary">
              合并提交
            </span>
          ) : lineage === "root" ? (
            <span className="rounded border border-border bg-muted/60 px-1 py-px text-3xs text-muted-foreground">
              初始提交
            </span>
          ) : null}
          {commit.refs.slice(0, 4).map((refName) => {
            const classified = classifyRepositoryRef(refName, currentBranch, knownRefs);
            return <RefBadge key={refName} refName={classified.name} kind={classified.kind} />;
          })}
          {commit.refs.length > 4 ? (
            <span className="text-3xs text-muted-foreground">+{commit.refs.length - 4}</span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 ps-5 text-3xs text-muted-foreground">
        <span className="min-w-0 truncate">{commit.authorName}</span>
        <span className="shrink-0 tabular-nums">
          {formatRelativeTimeLabel(commit.committedAt, undefined, messages)}
        </span>
      </div>
    </button>
  );
}

function CommitDetailsInspector({
  details,
  error,
  isPending,
  currentBranch,
  knownRefs,
  commitLinkIdentity,
  timestampFormat,
  onSelectParent,
  onOpenCommitDiff,
  onOpenCommitUrl,
  onClose,
}: {
  readonly details: ReviewCommitDetailsResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly currentBranch?: string | null | undefined;
  readonly knownRefs: ReturnType<typeof mergeRepositoryHistoryPages>["knownRefs"];
  readonly commitLinkIdentity: RepositoryIdentity | null | undefined;
  readonly timestampFormat: TimestampFormat;
  readonly onSelectParent: (sha: ReviewCommitSha) => void;
  readonly onOpenCommitDiff: (sha: ReviewCommitSha) => void;
  readonly onOpenCommitUrl: (event: MouseEvent<HTMLElement>, url: string) => void;
  readonly onClose: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  if (isPending && details === null) {
    return (
      <div className="flex items-center justify-center gap-2 border-t border-border bg-card/50 p-4 text-xs text-muted-foreground">
        <Spinner size="sm" aria-hidden />
        <span>正在加载提交详情…</span>
      </div>
    );
  }

  if (error && details === null) {
    return (
      <div className="border-t border-border bg-card/50 p-3 text-xs text-destructive">
        <div className="flex items-center justify-between gap-2">
          <span>无法读取提交详情：{error}</span>
          <Button size="icon-micro" variant="ghost" aria-label="关闭提交详情" onClick={onClose}>
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  if (!details) return null;

  const people = formatCommitPeople(details);
  const commitUrl = projectCommitUrl(commitLinkIdentity, details.sha);

  return (
    <div className="flex max-h-[52%] min-h-44 flex-col border-t border-border bg-card/50">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="font-mono text-xs font-medium text-foreground">
            {formatShortSha(details.sha)}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  aria-label="复制完整 SHA"
                  onClick={() => copyToClipboard(details.sha)}
                />
              }
            >
              {isCopied ? (
                <CheckIcon className="size-3 text-success" />
              ) : (
                <CopyIcon className="size-3 text-muted-foreground" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{isCopied ? "已复制 SHA" : "复制完整 SHA"}</TooltipPopup>
          </Tooltip>
          {commitUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="在代码托管平台查看此提交"
                    className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={(event) => onOpenCommitUrl(event, commitUrl)}
                  />
                }
              >
                <ExternalLinkIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">在远端查看提交</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" variant="secondary" onClick={() => onOpenCommitDiff(details.sha)}>
            <FileDiffIcon className="size-3.5" aria-hidden />
            <span>查看提交 Diff</span>
          </Button>
          <Button size="icon-micro" variant="ghost" aria-label="关闭提交详情" onClick={onClose}>
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 text-xs">
        <div className="space-y-1">
          <p className="font-medium text-foreground">{details.subject || "(无提交说明)"}</p>
          {details.body ? (
            <pre className="whitespace-pre-wrap wrap-break-word rounded-md bg-background/70 p-2 font-mono text-2xs leading-relaxed text-muted-foreground">
              {details.body}
            </pre>
          ) : null}
        </div>

        {details.refs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {details.refs.map((refName) => {
              const classified = classifyRepositoryRef(refName, currentBranch, knownRefs);
              return <RefBadge key={refName} refName={classified.name} kind={classified.kind} />;
            })}
          </div>
        ) : null}

        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span>作者</span>
          <span className="min-w-0 truncate text-foreground/90">{people.author}</span>
          {people.committer ? (
            <>
              <span>提交者</span>
              <span className="min-w-0 truncate text-foreground/90">{people.committer}</span>
            </>
          ) : null}
          <span>提交时间</span>
          <span className="tabular-nums text-foreground/90">
            {formatShortTimestamp(details.committedAt, timestampFormat)}
          </span>
          {details.parentShas.length > 0 ? (
            <>
              <span>父提交</span>
              <span className="flex flex-wrap gap-1">
                {details.parentShas.map((parentSha) => (
                  <button
                    key={parentSha}
                    type="button"
                    onClick={() => onSelectParent(parentSha)}
                    className="cursor-pointer rounded border border-border bg-background/80 px-1.5 py-px font-mono text-3xs text-foreground/90 transition-colors hover:bg-accent"
                  >
                    {formatShortSha(parentSha)}
                  </button>
                ))}
              </span>
            </>
          ) : null}
        </div>

        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between gap-2 text-2xs">
            <span className="font-medium text-foreground">变更文件（{details.files.length}）</span>
            <DiffStatLabel
              additions={details.insertions}
              deletions={details.deletions}
              className="text-2xs"
              layout="inline"
            />
          </div>
          {details.truncated ? (
            <p className="text-3xs text-warning-foreground">
              部分提交元数据或变更文件列表达到体积上限，已截断展示。
            </p>
          ) : null}
          {details.files.length === 0 ? (
            <p className="text-2xs text-muted-foreground">该提交没有可展示的文件变更。</p>
          ) : (
            <div className="divide-y divide-border/40 rounded-md border border-border/60 bg-background/60">
              {details.files.map((file) => (
                <div
                  key={`${file.previousPath ?? ""}:${file.path}`}
                  className="flex items-center gap-2 px-2 py-1 text-2xs"
                >
                  <span className="shrink-0 rounded bg-muted px-1 py-px text-3xs text-muted-foreground">
                    {formatCommitChangeTypeLabel(file.changeType)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                    {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                  </span>
                  <DiffStatLabel
                    additions={file.additions}
                    deletions={file.deletions}
                    className="shrink-0 text-3xs"
                    layout="inline"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LunaRepositoryHistoryView({
  environmentId,
  cwd,
  currentBranch,
  canReadFiles,
  fileAccessPending,
  fileAccessError,
  commitLinkIdentity,
  timestampFormat,
  workspaceMutationId,
  onOpenCommitDiff,
  onOpenCommitUrl,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly currentBranch?: string | null | undefined;
  readonly canReadFiles: boolean;
  readonly fileAccessPending: boolean;
  readonly fileAccessError: string | null;
  readonly commitLinkIdentity: RepositoryIdentity | null | undefined;
  readonly timestampFormat: TimestampFormat;
  readonly workspaceMutationId: string | null;
  readonly onOpenCommitDiff: (sha: string) => void;
  readonly onOpenCommitUrl: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  const messages = useMessages();
  const [scope, setScope] = useState<RepositoryHistoryScope>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [cursors, setCursors] = useState<ReadonlyArray<ReviewRepositoryHistoryCursor>>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selectedSha, setSelectedSha] = useState<ReviewCommitSha | null>(null);

  const firstPageAtom = canReadFiles
    ? revisionedQuery(
        reviewEnvironment.repositoryHistory({
          environmentId,
          input: { cwd, scope, limit: HISTORY_PAGE_SIZE },
        }),
        workspaceMutationId,
        { detail: `${scope}:${refreshTick}` },
      )
    : null;
  const firstPageRefresh = useEnvironmentQueryRefresh(firstPageAtom);

  const pagesAtom = historyPagesFamily(
    JSON.stringify({
      environmentId,
      cwd,
      scope,
      workspaceMutationId,
      refreshTick,
      cursors,
    }),
  );
  const pageResults = useAtomValue(pagesAtom);

  const settledPages = pageResults.flatMap((result) =>
    result._tag === "Success" ? [result.value] : [],
  );
  const merged = mergeRepositoryHistoryPages(settledPages);
  const filteredCommits = filterRepositoryHistoryCommits(merged.commits, searchQuery);
  const isInitialLoading = canReadFiles && pageResults.length > 0 && settledPages.length === 0;
  const isAnyPending =
    canReadFiles && pageResults.some((result) => result._tag === "Initial" || result.waiting);
  const lastResult = pageResults[pageResults.length - 1];
  const lastError = lastResult?._tag === "Failure" ? "读取仓库历史失败，请刷新重试。" : null;

  const commitDetailsQuery = useEnvironmentQuery(
    canReadFiles && selectedSha !== null
      ? reviewEnvironment.commitDetails({
          environmentId,
          input: { cwd, commitSha: selectedSha },
        })
      : null,
    messages,
  );

  const handleScopeChange = (nextScope: RepositoryHistoryScope) => {
    if (nextScope === scope) return;
    setScope(nextScope);
    setCursors([]);
    setSelectedSha(null);
  };

  const handleRefresh = () => {
    setCursors([]);
    setRefreshTick((tick) => tick + 1);
    firstPageRefresh.refresh();
  };

  const handleLoadMore = () => {
    if (!merged.nextCursor || isAnyPending) return;
    setCursors((current) => [...current, merged.nextCursor!]);
  };

  if (!canReadFiles) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        {fileAccessPending
          ? "正在校验文件读取权限…"
          : (fileAccessError ?? "当前连接没有读取本地 Git 仓库历史的权限。")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div
          role="group"
          aria-label="切换仓库历史范围"
          className="inline-flex items-center rounded-md border border-border/70 bg-card/70 p-0.5 text-2xs"
        >
          <button
            type="button"
            onClick={() => handleScopeChange("all")}
            className={cn(
              "cursor-pointer rounded px-2 py-0.5 transition-colors",
              scope === "all"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            全部分支
          </button>
          <button
            type="button"
            onClick={() => handleScopeChange("current")}
            className={cn(
              "cursor-pointer rounded px-2 py-0.5 transition-colors",
              scope === "current"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            当前分支
          </button>
        </div>

        <div className="flex min-w-36 flex-1 items-center gap-1.5">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            size="compact"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索提交信息 / SHA / 作者 / 分支…"
            aria-label="搜索已加载的提交记录"
          />
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="刷新仓库历史"
                onClick={handleRefresh}
              />
            }
          >
            <RefreshIcon size="sm" refreshing={isAnyPending} />
          </TooltipTrigger>
          <TooltipPopup side="top">刷新仓库历史</TooltipPopup>
        </Tooltip>
      </div>

      {merged.truncated ? (
        <p className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1 text-3xs text-muted-foreground">
          已启用只读安全上限（最多 200 个分支/标签引用，单次最多 100
          条提交），部分较早引用可能未完整列出。
        </p>
      ) : null}

      {lastError ? (
        <div className="shrink-0 border-b border-border/60 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          {lastError}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isInitialLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" aria-hidden />
            <span>正在读取仓库提交历史…</span>
          </div>
        ) : filteredCommits.length === 0 ? (
          <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/80">
            {merged.commits.length === 0
              ? "当前范围内暂无提交记录。"
              : "没有匹配当前搜索条件的提交记录。"}
          </div>
        ) : (
          <div>
            {filteredCommits.map((commit) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                selected={selectedSha === commit.sha}
                currentBranch={currentBranch}
                knownRefs={merged.knownRefs}
                onSelect={setSelectedSha}
              />
            ))}
            {merged.nextCursor !== null ? (
              <div className="flex items-center justify-center py-3">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={isAnyPending}
                  onClick={handleLoadMore}
                >
                  {isAnyPending ? "正在加载…" : "加载更多提交"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {selectedSha !== null ? (
        <CommitDetailsInspector
          details={commitDetailsQuery.data}
          error={commitDetailsQuery.error}
          isPending={commitDetailsQuery.isPending}
          currentBranch={currentBranch}
          knownRefs={merged.knownRefs}
          commitLinkIdentity={commitLinkIdentity}
          timestampFormat={timestampFormat}
          onSelectParent={setSelectedSha}
          onOpenCommitDiff={onOpenCommitDiff}
          onOpenCommitUrl={onOpenCommitUrl}
          onClose={() => setSelectedSha(null)}
        />
      ) : null}
    </div>
  );
}
