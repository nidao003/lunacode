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
import {
  EnvironmentId,
  type ReviewCommitDetailsResult,
  type ReviewCommitSha,
  type ReviewRepositoryHistoryCommit,
  type ReviewRepositoryHistoryCursor,
  type ReviewRepositoryHistoryResult,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useEffect, useRef, useState } from "react";
import { Platform, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { AppBar } from "../components/ui/AppBar";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { EmptyState } from "../components/ui/EmptyState";
import { ListRow } from "../components/ui/ListRow";
import { ListSection } from "../components/ui/ListSection";
import { RefreshControl } from "../components/ui/RefreshControl";
import { RowPressable } from "../components/ui/RowPressable";
import { ScreenContent } from "../components/ui/ScreenContent";
import { SearchField } from "../components/ui/SearchField";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { SheetPane } from "../components/ui/SheetPane";
import { groupedListInsets } from "../components/ui/listMetrics";
import { PullRequestGlyph } from "../features/pull-requests/pullRequestGlyphs";
import { cn } from "../lib/cn";
import { NativeScrollView } from "../native/NativeScrollViewMarker";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import {
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
} from "../state/thread-git-target";
import { useSelectedThreadWorktree } from "../state/use-selected-thread-worktree";

const HISTORY_PAGE_SIZE = 40;

type GitHistorySheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
  } & GitRepositoryRouteParams
>;

const extraHistoryPagesFamily = Atom.family((serializedKey: string) => {
  const parsed = JSON.parse(serializedKey) as {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly scope: RepositoryHistoryScope;
    readonly cursors: ReadonlyArray<ReviewRepositoryHistoryCursor>;
  };
  return Atom.make((get) => {
    const pages: Array<AsyncResult.AsyncResult<ReviewRepositoryHistoryResult, unknown>> = [];
    for (const cursor of parsed.cursors) {
      pages.push(
        get(
          reviewEnvironment.repositoryHistory({
            environmentId: parsed.environmentId,
            input: {
              cwd: parsed.cwd,
              scope: parsed.scope,
              limit: HISTORY_PAGE_SIZE,
              cursor,
            },
          }),
        ),
      );
    }
    return pages;
  }).pipe(Atom.withLabel(`lunacode:mobile:repository-history-pages:${serializedKey}`));
});

const EMPTY_ASYNC_PAGES_ATOM = Atom.make<
  ReadonlyArray<AsyncResult.AsyncResult<ReviewRepositoryHistoryResult, unknown>>
>([]).pipe(Atom.withLabel("lunacode:mobile:repository-history-pages:empty"));

function formatHistoryDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function refBadgeClassName(kind: RepositoryRefKind): string {
  switch (kind) {
    case "head":
      return "border-primary/40 bg-primary/15 text-primary-text";
    case "remote":
      return "border-border bg-subtle-strong text-foreground-muted";
    case "tag":
      return "border-warning/40 bg-warning/15 text-warning";
    case "branch":
      return "border-border bg-subtle text-foreground-muted";
  }
}

function RefTagChip({
  refName,
  kind,
}: {
  readonly refName: string;
  readonly kind: RepositoryRefKind;
}) {
  return (
    <View
      className={cn(
        "max-w-[180px] flex-row items-center gap-1 rounded-md border px-1.5 py-0.5",
        refBadgeClassName(kind),
      )}
    >
      <SymbolView
        name={kind === "tag" ? "tag" : "arrow.triangle.branch"}
        size={11}
        tintColorClassName={kind === "head" ? "accent-primary-text" : "accent-foreground-muted"}
      />
      <Text
        textRole="caption"
        numberOfLines={1}
        className="shrink font-mono text-[11px] text-foreground"
      >
        {refName}
      </Text>
    </View>
  );
}

function CommitRow({
  commit,
  knownRefs,
  separated,
  onPress,
}: {
  readonly commit: ReviewRepositoryHistoryCommit;
  readonly knownRefs: ReturnType<typeof mergeRepositoryHistoryPages>["knownRefs"];
  readonly separated: boolean;
  readonly onPress: () => void;
}) {
  const lineage = summarizeCommitLineage(commit.parentShas);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${commit.subject || "(无提交说明)"}, ${formatShortSha(commit.sha)}`}
      onPress={onPress}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card px-4 py-3"
    >
      {separated ? <View className="absolute inset-x-4 top-0 h-px bg-border" /> : null}
      <View className="flex-row items-start gap-3">
        <View className="mt-0.5 size-6 items-center justify-center rounded-md bg-subtle">
          <SymbolView
            name={lineage === "merge" ? PullRequestGlyph.merged : "git.commit"}
            size={14}
            tintColorClassName="accent-foreground-muted"
          />
        </View>
        <View className="min-w-0 flex-1 gap-1.5">
          <Text textRole="body" numberOfLines={2} className="font-t3-medium text-foreground">
            {commit.subject || "(无提交说明)"}
          </Text>
          {commit.refs.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {commit.refs.slice(0, 4).map((refName) => {
                const classified = classifyRepositoryRef(refName, undefined, knownRefs);
                return (
                  <RefTagChip key={refName} refName={classified.name} kind={classified.kind} />
                );
              })}
              {commit.refs.length > 4 ? (
                <View className="rounded-md border border-border bg-subtle px-1.5 py-0.5">
                  <Text textRole="caption" className="font-mono text-foreground-muted">
                    +{commit.refs.length - 4}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          <View className="flex-row flex-wrap items-center gap-2">
            <Text textRole="caption" className="font-mono text-foreground-muted">
              {formatShortSha(commit.sha)}
            </Text>
            <Text textRole="caption" numberOfLines={1} className="shrink text-foreground-muted">
              {commit.authorName}
            </Text>
            <Text textRole="caption" className="text-foreground-muted">
              {formatHistoryDate(commit.committedAt)}
            </Text>
            {lineage === "merge" ? (
              <Chip label="合并" size="small" />
            ) : lineage === "root" ? (
              <Chip label="根提交" size="small" />
            ) : null}
          </View>
        </View>
        <View className="mt-1">
          <SymbolView
            name="chevron.right"
            size={15}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        </View>
      </View>
    </RowPressable>
  );
}

function CommitDetailContent({
  detail,
  knownRefs,
  copiedSha,
  onCopySha,
  onSelectParent,
}: {
  readonly detail: ReviewCommitDetailsResult;
  readonly knownRefs: ReturnType<typeof mergeRepositoryHistoryPages>["knownRefs"];
  readonly copiedSha: boolean;
  readonly onCopySha: (sha: ReviewCommitSha) => void;
  readonly onSelectParent: (sha: ReviewCommitSha) => void;
}) {
  const people = formatCommitPeople(detail);
  const lineage = summarizeCommitLineage(detail.parentShas);

  return (
    <View className="gap-5">
      <View className="gap-3 rounded-[20px] border border-border bg-grouped-card p-4">
        <View className="flex-row flex-wrap items-center gap-2">
          <View className="rounded-md border border-border bg-subtle px-2 py-0.5">
            <Text textRole="caption" className="font-mono text-foreground">
              {formatShortSha(detail.sha)}
            </Text>
          </View>
          {lineage === "merge" ? (
            <Chip label={`合并提交 (${detail.parentShas.length} 个父提交)`} size="small" />
          ) : lineage === "root" ? (
            <Chip label="根提交" size="small" />
          ) : null}
        </View>

        <Text selectable textRole="headline" className="font-t3-bold text-foreground">
          {detail.subject || "(无提交说明)"}
        </Text>

        {detail.body ? (
          <View className="rounded-xl bg-subtle/70 p-3">
            <Text
              selectable
              textRole="footnote"
              className="font-mono leading-relaxed text-foreground"
            >
              {detail.body}
            </Text>
          </View>
        ) : null}

        {detail.refs.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5">
            {detail.refs.map((refName) => {
              const classified = classifyRepositoryRef(refName, undefined, knownRefs);
              return <RefTagChip key={refName} refName={classified.name} kind={classified.kind} />;
            })}
          </View>
        ) : null}

        <View className="gap-1.5 border-t border-border pt-3">
          <Text textRole="footnote" className="text-foreground-muted">
            作者：{people.author}
          </Text>
          {people.committer ? (
            <Text textRole="footnote" className="text-foreground-muted">
              提交者：{people.committer}
            </Text>
          ) : null}
          <Text textRole="footnote" className="text-foreground-muted">
            提交时间：{formatHistoryDate(detail.committedAt)}
          </Text>
          <Text selectable textRole="caption" className="font-mono text-foreground-muted">
            SHA: {detail.sha}
          </Text>
        </View>

        <View className="pt-1">
          <Button
            tone="secondary"
            size="compact"
            icon={copiedSha ? "checkmark" : undefined}
            label={copiedSha ? "已复制完整 SHA" : "复制完整 SHA"}
            onPress={() => onCopySha(detail.sha)}
          />
        </View>
      </View>

      {detail.parentShas.length > 0 ? (
        <ListSection title={`父提交 (${detail.parentShas.length})`}>
          {detail.parentShas.map((parentSha, index) => (
            <View key={parentSha}>
              {index > 0 ? <View className="mx-4 h-px bg-border" /> : null}
              <ListRow
                icon="git.commit"
                label={formatShortSha(parentSha)}
                description={parentSha}
                onPress={() => onSelectParent(parentSha)}
              />
            </View>
          ))}
        </ListSection>
      ) : null}

      <ListSection
        title={`改动文件 (${detail.files.length})`}
        footer={
          detail.truncated
            ? "文件列表已截断，仅展示该提交的部分统计信息。"
            : `总计 +${detail.insertions} / -${detail.deletions}`
        }
      >
        {detail.files.length === 0 ? (
          <View className="px-4 py-4">
            <Text textRole="footnote" className="text-foreground-muted">
              该提交没有记录文件变更（例如空提交或初始提交）。
            </Text>
          </View>
        ) : (
          detail.files.map((file, index) => (
            <View
              key={`${file.previousPath ?? ""}:${file.path}`}
              className="bg-grouped-card px-4 py-3"
            >
              {index > 0 ? <View className="absolute inset-x-4 top-0 h-px bg-border" /> : null}
              <View className="flex-row items-center justify-between gap-3">
                <View className="min-w-0 flex-1 flex-row items-center gap-2">
                  <View className="rounded bg-subtle px-1.5 py-0.5">
                    <Text textRole="caption" className="font-mono text-foreground-muted">
                      {formatCommitChangeTypeLabel(file.changeType)}
                    </Text>
                  </View>
                  <Text
                    selectable
                    textRole="footnote"
                    numberOfLines={2}
                    className="min-w-0 flex-1 font-mono text-foreground"
                  >
                    {file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path}
                  </Text>
                </View>
                <Text textRole="caption" className="shrink-0 font-mono text-foreground-muted">
                  +{file.additions} / -{file.deletions}
                </Text>
              </View>
            </View>
          ))
        )}
      </ListSection>
    </View>
  );
}

export function LunaMobileGitHistorySheet(props: GitHistorySheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the route link names a blank environment or thread
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return <LunaMobileGitHistorySheetContent {...props} />;
}

function LunaMobileGitHistorySheetContent(props: GitHistorySheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const searchInputRef = useRef<TextInputInstance | null>(null);
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const repository = gitRepositoryTargetFromRoute(props.route.params);
  const threadWorktree = useSelectedThreadWorktree();
  const targetCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;

  const [scope, setScope] = useState<RepositoryHistoryScope>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSha, setSelectedSha] = useState<ReviewCommitSha | null>(null);
  const [copiedSha, setCopiedSha] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cursorState, setCursorState] = useState<{
    readonly key: string;
    readonly cursors: ReadonlyArray<ReviewRepositoryHistoryCursor>;
  }>({ key: "", cursors: [] });

  const activeQueryKey = targetCwd ? `${environmentId}:${targetCwd}:${scope}` : "";
  const extraCursors = cursorState.key === activeQueryKey ? cursorState.cursors : [];

  const firstPageAtom = targetCwd
    ? reviewEnvironment.repositoryHistory({
        environmentId,
        input: {
          cwd: targetCwd,
          scope,
          limit: HISTORY_PAGE_SIZE,
        },
      })
    : null;
  const firstPageQuery = useEnvironmentQuery(firstPageAtom);

  const extraPagesAtom =
    targetCwd && extraCursors.length > 0
      ? extraHistoryPagesFamily(
          JSON.stringify({
            environmentId,
            cwd: targetCwd,
            scope,
            cursors: extraCursors,
          }),
        )
      : EMPTY_ASYNC_PAGES_ATOM;
  const extraPageResults = useAtomValue(extraPagesAtom);

  const commitDetailAtom =
    targetCwd && selectedSha
      ? reviewEnvironment.commitDetails({
          environmentId,
          input: {
            cwd: targetCwd,
            commitSha: selectedSha,
          },
        })
      : null;
  const commitDetailQuery = useEnvironmentQuery(commitDetailAtom);

  const loadedPages: Array<ReviewRepositoryHistoryResult> = [];
  if (firstPageQuery.data) {
    loadedPages.push(firstPageQuery.data);
  }
  for (const result of extraPageResults) {
    const pageData = AsyncResult.getOrElse(result, () => null);
    if (pageData) {
      loadedPages.push(pageData);
    }
  }

  const merged = mergeRepositoryHistoryPages(loadedPages);
  const filteredCommits = filterRepositoryHistoryCommits(merged.commits, searchQuery);
  const lastExtraResult =
    extraPageResults.length > 0 ? extraPageResults[extraPageResults.length - 1] : undefined;
  const isLoadingMore = Boolean(lastExtraResult?.waiting);
  const loadMoreError =
    lastExtraResult && lastExtraResult._tag === "Failure"
      ? formatEnvironmentQueryError(lastExtraResult.cause)
      : null;
  const nextCursor = merged.nextCursor;

  const handleRefresh = () => {
    setIsRefreshing(true);
    if (selectedSha) {
      commitDetailQuery.refresh();
    } else {
      setCursorState({ key: activeQueryKey, cursors: [] });
      firstPageQuery.refresh();
    }
    setIsRefreshing(false);
  };

  const handleCopySha = (sha: ReviewCommitSha) => {
    setCopiedSha(true);
    void Clipboard.setStringAsync(sha).catch(() => undefined);
  };

  const title = selectedSha
    ? `提交 ${formatShortSha(selectedSha)}`
    : repository
      ? `${repository.name} · 仓库历史`
      : "仓库历史";
  const subtitle = selectedSha
    ? repository?.name
    : scope === "all"
      ? "全部分支与标签"
      : "当前分支历史";

  return (
    <SheetPane surface="sheet">
      <AppBar
        title={title}
        subtitle={subtitle}
        hideBottomBorder
        onBack={
          selectedSha
            ? () => {
                setSelectedSha(null);
                setCopiedSha(false);
              }
            : undefined
        }
        onClose={() => navigation.goBack()}
        refresh={{
          accessibilityLabel: selectedSha ? "刷新提交详情" : "刷新仓库历史",
          disabled: isRefreshing || firstPageQuery.isPending || commitDetailQuery.isPending,
          onPress: handleRefresh,
        }}
      />
      <ScreenContent>
        <NativeScrollView
          nestedScrollEnabled
          alwaysBounceVertical
          className="flex-1 bg-screen"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            ...groupedListInsets(false),
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            gap: 14,
          }}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
        >
          {!targetCwd ? (
            <EmptyState
              title="暂无仓库目录"
              detail="当前线程或受管仓库尚未关联可用的 Git 工作目录。"
            />
          ) : selectedSha ? (
            commitDetailQuery.error && !commitDetailQuery.data ? (
              <EmptyState
                title="无法读取提交详情"
                detail={commitDetailQuery.error}
                actionLabel="重试"
                onAction={() => commitDetailQuery.refresh()}
              />
            ) : !commitDetailQuery.data ? (
              <EmptyState
                title="正在读取提交详情"
                detail={`正在加载 ${formatShortSha(selectedSha)}...`}
              />
            ) : (
              <CommitDetailContent
                detail={commitDetailQuery.data}
                knownRefs={merged.knownRefs}
                copiedSha={copiedSha}
                onCopySha={handleCopySha}
                onSelectParent={(parentSha) => {
                  setCopiedSha(false);
                  setSelectedSha(parentSha);
                }}
              />
            )
          ) : (
            <>
              <View className="gap-3">
                <SegmentedControl
                  options={[
                    { value: "all", label: "全部分支" },
                    { value: "current", label: "当前分支" },
                  ]}
                  selected={scope}
                  onSelect={(nextScope) => {
                    setScope(nextScope);
                  }}
                />
                <SearchField
                  inputRef={searchInputRef}
                  autoFocus={false}
                  accessibilityLabel="搜索仓库提交历史"
                  clearAccessibilityLabel="清空搜索条件"
                  placeholder="按主题、SHA、作者或分支标签过滤"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                />
              </View>

              {firstPageQuery.error && merged.commits.length === 0 ? (
                <EmptyState
                  title="无法加载仓库历史"
                  detail={firstPageQuery.error}
                  actionLabel="重试"
                  onAction={() => firstPageQuery.refresh()}
                />
              ) : firstPageQuery.isPending && merged.commits.length === 0 ? (
                <EmptyState title="正在加载仓库历史" detail="正在读取 Git 提交记录..." />
              ) : filteredCommits.length === 0 ? (
                <EmptyState
                  title={searchQuery.trim().length > 0 ? "没有匹配的提交" : "暂无提交记录"}
                  detail={
                    searchQuery.trim().length > 0
                      ? "尝试更换关键词，或加载更多提交后再搜索。"
                      : "当前仓库还没有可展示的提交历史。"
                  }
                />
              ) : (
                <ListSection
                  title={`已显示 ${filteredCommits.length} 条提交${searchQuery.trim() ? `（共 ${merged.commits.length} 条已加载）` : ""}`}
                >
                  {filteredCommits.map((commit, index) => (
                    <CommitRow
                      key={commit.sha}
                      commit={commit}
                      knownRefs={merged.knownRefs}
                      separated={index > 0}
                      onPress={() => {
                        setCopiedSha(false);
                        setSelectedSha(commit.sha);
                      }}
                    />
                  ))}
                </ListSection>
              )}

              {loadMoreError ? (
                <EmptyState
                  title="加载更多提交失败"
                  detail={loadMoreError}
                  actionLabel="重试"
                  onAction={() => {
                    setCursorState((current) => ({
                      key: activeQueryKey,
                      cursors: current.key === activeQueryKey ? current.cursors.slice(0, -1) : [],
                    }));
                  }}
                />
              ) : null}

              {nextCursor && !loadMoreError ? (
                <View className="items-center pt-1">
                  <Button
                    tone="secondary"
                    size="compact"
                    loading={isLoadingMore}
                    label={isLoadingMore ? "正在加载更多..." : "加载更多提交"}
                    onPress={() => {
                      if (isLoadingMore) return;
                      setCursorState((current) => {
                        const base = current.key === activeQueryKey ? current.cursors : [];
                        const alreadyRequested = base.some(
                          (item) => item.offset === nextCursor.offset,
                        );
                        if (alreadyRequested) return current;
                        return {
                          key: activeQueryKey,
                          cursors: [...base, nextCursor],
                        };
                      });
                    }}
                  />
                </View>
              ) : null}
            </>
          )}
        </NativeScrollView>
      </ScreenContent>
    </SheetPane>
  );
}
