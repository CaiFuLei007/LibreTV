'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState, LoadingState } from './states';
import { Icon } from './icon';
import { useToast } from './toast';
import { SeriesCard } from './series-card';
import { CategorySection } from './category-section';
import { WatchlistItem } from './watchlist-item';
import { db } from '@/lib/db';
import {
  STATUS_LABEL,
  STATUS_ORDER,
  clearWatchlistByStatus,
  restoreWatchlistEntry,
  type WatchStatus,
  type WatchlistEntry,
} from '@/lib/watchlist';
import { cn } from '@/lib/utils';
import { groupBySeries, matchGroup, type SeriesGroup } from '@/lib/series-group';
import { groupByCategory, type MediaCategory } from '@/lib/media-category';
import { checkNewEpisodes } from '@/lib/episode-tracker';

/**
 * 收藏夹抽屉：想看 / 在看 / 已看 / 废弃四栏共享同一份骨架。
 *
 * ## 三层派生结构（全部是展示层，数据层零改动）
 *
 * ```
 * 状态栏（在看/想看/已看/废弃）      ← 回答「我看没看」，用户主动切换
 *   └─ 分类分区（电影/剧集/动漫/…）  ← 回答「这是什么」，自动判定 + 可收起
 *        └─ 系列折叠卡（招魂 ×4）    ← 回答「这是第几部」，自动归组 + 可展开
 *             └─ 单条              ← 最终条目，可搜源/续播/改状态/移除
 * ```
 *
 * 三层各管一个正交的问题，互不干扰：
 * - 状态是**用户意图**，只能手动切；
 * - 分类是**内容属性**，来自采集站 typeName（见 `@/lib/media-category`）；
 * - 系列是**片名结构**，从片名里解析部号（见 `@/lib/series-group`）。
 *
 * 为什么顺序是「分类在前、系列在后」：
 * 系列归组必须在一类**内部**做。若先归组再分类，招魂 4 部会先并成一个组，
 * 而这个组横跨不了分类（4 部都是恐怖片所以没问题，但换成一堆
 * 「招魂」+「招魂 动画版」就会打架）。先分类则每个桶的语义是纯的。
 *
 * ## 三个刻意的取舍
 *
 * 1. **空分类不渲染**。设计稿里画的是「0 也显示块头」，但实测收藏夹经常有
 *    5~6 个空分类（综艺/短剧/体育/成人/其他全空），全显示会让块头比内容还多。
 * 2. **角标按条目数**。tab 上的数字仍是条目数（已看 10），不是分类数、不是组数。
 * 3. **两层展开态分开存**。分类级和系列级各自一个 Set，都用 sessionStorage。
 */

const TABS: WatchStatus[] = STATUS_ORDER;

const EMPTY_HINT: Record<WatchStatus, string> = {
  wish: '还没有想看的片子：在搜索结果里点「收藏」即可加入',
  watching: '还没有正在看的片子：在搜索结果里手动标记为「在看」才会加入',
  watched: '还没有看完的片子：任何视频播放到 90% 或播完，都会自动收录到这里',
  dropped: '没有废弃的片子：看不下去的在列表里改成「废弃」即可',
};

/** 系列展开态：刷新保留，跨设备无意义 */
const EXPANDED_SERIES_KEY = 'libretv:watchlist:expanded-series';
/** 分类展开态：与系列分开存，避免两组 key 混在一个 Set 里互相污染 */
const COLLAPSED_CATEGORY_KEY = 'libretv:watchlist:collapsed-categories';

/**
 * 分类存的是**收起**的集合，而不是展开的集合。
 *
 * 理由：分类默认展开（首次进来就能看到全部内容），所以默认态是「空集」；
 * 若存「展开集合」，新增一个分类时它不在集合里 = 默认收起，用户会以为没内容。
 * 存「收起集合」则新增分类自动展开，符合预期。
 */
function loadCollapsedCategories(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(COLLAPSED_CATEGORY_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedCategories(keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(COLLAPSED_CATEGORY_KEY, JSON.stringify([...keys]));
  } catch {
    // 隐私模式下 sessionStorage 可能不可写：收起态丢失不影响功能
  }
}

function loadExpandedSeries(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_SERIES_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveExpandedSeries(keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(EXPANDED_SERIES_KEY, JSON.stringify([...keys]));
  } catch {
    // 同上
  }
}

type Row<T> =
  | { kind: 'single'; key: string; entry: T }
  | { kind: 'group'; key: string; group: SeriesGroup<T>; matchedTitles: string[] };

/** 一个分类分区，含它内部的系列/单条行 */
interface Section {
  category: MediaCategory;
  label: string;
  count: number;
  seriesCount: number;
  rows: Row<WatchlistEntry>[];
}

export function WatchlistPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<WatchStatus>('watching');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(() => new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => new Set());
  const { toast } = useToast();
  const listRef = useRef<HTMLUListElement>(null);

  // 四栏各自实时查询：切换标签不需要重新拉全表
  const rows = useLiveQuery(() => db.watchlist.where('status').equals(tab).toArray(), [tab]);
  const counts = useLiveQuery(async () => {
    const all = await db.watchlist.toArray();
    const acc: Record<WatchStatus, number> = { wish: 0, watching: 0, watched: 0, dropped: 0 };
    for (const r of all) acc[r.status] += 1;
    return acc;
  }, []);

  // 抽屉打开时读回上次的展开态
  useEffect(() => {
    if (!open) return;
    setExpandedSeries(loadExpandedSeries());
    setCollapsedCategories(loadCollapsedCategories());
  }, [open]);

  // 打开收藏面板时补跑一次集数检测（内部有 6 小时节流，不会每次都拉）
  useEffect(() => {
    if (!open) return;
    void checkNewEpisodes().then((updates) => {
      if (updates.length > 0) {
        const total = updates.reduce((n, u) => n + u.added, 0);
        toast(`有 ${updates.length} 部剧集更新（共 ${total} 集）`, 'info');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const keyword = query.trim();

  /**
   * 分类 → 系列 → 单条，逐层派生。
   *
   * 搜索为什么在「系列」这一层过滤、而不是在分类这一层：
   * 搜「招魂3」命中的是组内成员，若在分类层就把不匹配的条目滤掉，
   * 组里只剩招魂3 一条，它就退化成普通单条——用户看不到它属于招魂系列，
   * 也没法顺手切到招魂2。所以在系列层过滤（整组保留 + 命中成员高亮），
   * 分类层只负责「这一类的过滤结果是否为空，空了就不渲染」。
   */
  const sections = useMemo<Section[]>(() => {
    const all = [...(rows ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
    const buckets = groupByCategory(all, (e) => e.typeName);

    const out: Section[] = [];
    for (const bucket of buckets) {
      if (bucket.count === 0) continue; // 空分类不渲染

      const { groups, singles } = groupBySeries(bucket.items, (e) => e.title);
      const merged: Row<WatchlistEntry>[] = [];

      for (const group of groups) {
        const match = keyword ? matchGroup(group, keyword) : { hit: true, memberTitles: [] };
        if (!match.hit) continue;
        merged.push({
          kind: 'group',
          key: `g:${group.key}`,
          group,
          matchedTitles: match.memberTitles,
        });
      }
      const kw = keyword.toLowerCase();
      for (const entry of singles) {
        if (kw && !entry.title.toLowerCase().includes(kw)) continue;
        merged.push({ kind: 'single', key: `s:${entry.id}`, entry });
      }

      // 整类都没命中 → 这一类不渲染（搜索时不展示空分区）
      if (merged.length === 0) continue;

      // 排序：组按「组内最新更新」、单条按自身 updatedAt，混排后统一倒序
      const timeOf = (row: Row<WatchlistEntry>): number =>
        row.kind === 'single'
          ? row.entry.updatedAt
          : Math.max(...row.group.members.map((m) => m.item.updatedAt));
      merged.sort((a, b) => timeOf(b) - timeOf(a));

      out.push({
        category: bucket.category,
        label: bucket.label,
        count: bucket.count,
        seriesCount: groups.length,
        rows: merged,
      });
    }
    return out;
  }, [rows, keyword]);

  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);

  /** 分类是否展开：默认展开；搜索时强制展开（否则搜到了却看不见） */
  const isCategoryOpen = (section: Section): boolean =>
    keyword.length > 0 || !collapsedCategories.has(section.category);

  const toggleCategory = (category: MediaCategory): void => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      saveCollapsedCategories(next);
      return next;
    });
  };

  /** 系列是否展开：手动展开过 或 搜索命中成员 */
  const isSeriesExpanded = (row: Extract<Row<WatchlistEntry>, { kind: 'group' }>): boolean =>
    expandedSeries.has(row.group.key) || row.matchedTitles.length > 0;

  const toggleSeries = (key: string): void => {
    setExpandedSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveExpandedSeries(next);
      return next;
    });
  };

  const hasAny = (counts?.[tab] ?? 0) > 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="我的收藏"
      width="max-w-lg"
      subheader={
        <div className="space-y-2">
          {/* 四态标签：数量常驻，避免为了看有没有内容而逐栏点开 */}
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
                  tab === t ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-hover hover:text-content'
                )}
              >
                {STATUS_LABEL[t]}
                {counts && counts[t] > 0 && (
                  <span className="ml-1 tabular-nums opacity-70">{counts[t]}</span>
                )}
              </button>
            ))}
          </div>
          {hasAny && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Icon
                  name="search"
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none"
                />
                <input
                  type="text"
                  className="w-full h-9 pl-8 pr-8 rounded-lg border border-line bg-chip text-sm text-content placeholder:text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
                  placeholder={`搜索${STATUS_LABEL[tab]}...`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={`搜索${STATUS_LABEL[tab]}`}
                />
                {query && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                    onClick={() => setQuery('')}
                    aria-label="清空搜索"
                  >
                    <Icon name="close" className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button
                className="shrink-0 px-2 py-1.5 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
                onClick={() => setConfirmClear(true)}
              >
                清空
              </button>
            </div>
          )}
        </div>
      }
    >
      {!rows ? (
        <LoadingState />
      ) : totalRows === 0 ? (
        <EmptyState
          variant="plain"
          title={keyword ? `没有匹配「${keyword}」的条目` : EMPTY_HINT[tab]}
        />
      ) : (
        <ul className="space-y-1" ref={listRef}>
          {sections.map((section) => (
            <CategorySection
              key={section.category}
              category={section.category}
              label={section.label}
              count={section.count}
              seriesCount={section.seriesCount}
              expanded={isCategoryOpen(section)}
              onToggle={() => toggleCategory(section.category)}
            >
              {section.rows.map((row) =>
                row.kind === 'single' ? (
                  <WatchlistItem key={row.key} entry={row.entry} />
                ) : (
                  <SeriesCard
                    key={row.key}
                    group={row.group}
                    expanded={isSeriesExpanded(row)}
                    onToggle={() => toggleSeries(row.group.key)}
                    matchedTitles={row.matchedTitles}
                  />
                )
              )}
            </CategorySection>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClear}
        danger
        title={`清空「${STATUS_LABEL[tab]}」？`}
        message={counts ? `将删除 ${counts[tab]} 条记录，此操作不可撤销。` : undefined}
        confirmLabel="清空"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void clearWatchlistByStatus(tab).then((removed) => {
            setConfirmClear(false);
            toast(`已清空「${STATUS_LABEL[tab]}」（${removed.length} 条）`, 'success', {
              action: {
                label: '撤销',
                onClick: () => {
                  void Promise.all(removed.map((r) => restoreWatchlistEntry(r))).then(() =>
                    toast('已恢复', 'success')
                  );
                },
              },
            });
          });
        }}
      />
    </Drawer>
  );
}
