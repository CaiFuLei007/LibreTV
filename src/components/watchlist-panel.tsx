'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState, LoadingState } from './states';
import { Icon } from './icon';
import { useToast } from './toast';
import { SeriesCard } from './series-card';
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
import { checkNewEpisodes } from '@/lib/episode-tracker';

/**
 * 收藏夹抽屉：想看 / 在看 / 已看 / 废弃四栏共享同一份骨架。
 * 与「观看历史」的差别：这里是用户主动维护的清单，已看由播放进度自动迁入，
 * 因此每栏都支持搜索、单条删除（可撤销）与整栏清空（需确认）。
 *
 * ## 系列归组（方案 A）
 *
 * 同一系列的若干部（招魂 / 招魂2 / 招魂3 / 招魂4：终章）在列表里只占一行，
 * 点开才展开成 N 行。判定见 `@/lib/series-group`，是纯展示层派生：
 *
 * - **不动数据**：收藏记录、主键、同步、追更检测全部原样；折叠只是渲染前多归一次组。
 * - **各栏独立聚合**：组只在本栏内成立。潜伏（已看）与潜伏2（想看）分属两栏，
 *   各自按单条显示——四态语义完全不变，代价是同系列会被拆到两栏（已实测确认取舍）。
 * - **角标按条目数**：tab 上的数字仍是条目数（已看 10），不按组数（已看 7）。
 *   改成组数会让用户以为数据丢了。
 * - **展开态不落库**：sessionStorage 足够，刷新保留、换设备不关心。
 */

const TABS: WatchStatus[] = STATUS_ORDER;

const EMPTY_HINT: Record<WatchStatus, string> = {
  wish: '还没有想看的片子：在搜索结果里点「收藏」即可加入',
  watching: '还没有正在看的片子：在搜索结果里手动标记为「在看」才会加入',
  watched: '还没有看完的片子：任何视频播放到 90% 或播完，都会自动收录到这里',
  dropped: '没有废弃的片子：看不下去的在列表里改成「废弃」即可',
};

/** 展开态存 sessionStorage：刷新要保留，跨设备无意义 */
const EXPANDED_KEY = 'libretv:watchlist:expanded-series';

function loadExpanded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...keys]));
  } catch {
    // 隐私模式下 sessionStorage 可能不可写：展开态丢失不影响功能
  }
}

type Row<T> =
  | { kind: 'single'; key: string; entry: T }
  | { kind: 'group'; key: string; group: SeriesGroup<T>; matchedTitles: string[] };

export function WatchlistPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<WatchStatus>('watching');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  // 抽屉首次打开时读回上次的展开态
  useEffect(() => {
    if (open) setExpanded(loadExpanded());
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
   * 先归组、再按关键词筛。
   *
   * 顺序不能反过来：搜「招魂3」时，命中的是组内成员而不是组标题。若先按关键词
   * 过滤条目再归组，只剩「招魂3」一条，它就退化成普通单条——用户看不到它属于
   * 招魂系列，也没法顺手切到招魂2。先归组则整组保留，命中成员时自动展开并高亮。
   *
   * 代价：搜「招魂3」会连带显示招魂 1/2/4。这是有意的——同一系列的兄弟就摆在
   * 眼前，比「只留一行然后让人以为其它几部没了」更符合收藏夹的用法。
   */
  const view = useMemo<Row<WatchlistEntry>[]>(() => {
    const all = [...(rows ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
    const { groups, singles } = groupBySeries(all, (e) => e.title);

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

    // 排序：组按「组内最新更新」、单条按自身 updatedAt，混排后统一倒序
    const timeOf = (row: Row<WatchlistEntry>): number =>
      row.kind === 'single'
        ? row.entry.updatedAt
        : Math.max(...row.group.members.map((m) => m.item.updatedAt));

    return merged.sort((a, b) => timeOf(b) - timeOf(a));
  }, [rows, keyword]);

  // 搜索时命中的组强制展开（不受手动折叠状态影响），清空搜索后回到手动状态
  const isExpanded = (row: Extract<Row<WatchlistEntry>, { kind: 'group' }>): boolean =>
    expanded.has(row.group.key) || row.matchedTitles.length > 0;
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveExpanded(next);
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
      ) : view.length === 0 ? (
        <EmptyState
          variant="plain"
          title={keyword ? `没有匹配「${keyword}」的条目` : EMPTY_HINT[tab]}
        />
      ) : (
        <ul className="space-y-2" ref={listRef}>
          {view.map((row) =>
            row.kind === 'single' ? (
              <WatchlistItem key={row.key} entry={row.entry} />
            ) : (
              <SeriesCard
                key={row.key}
                group={row.group}
                expanded={isExpanded(row)}
                onToggle={() => toggle(row.group.key)}
                matchedTitles={row.matchedTitles}
              />
            )
          )}
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
