'use client';

import { useState } from 'react';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { WatchlistItem } from './watchlist-item';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import type { WatchlistEntry } from '@/lib/watchlist';
import type { SeriesGroup } from '@/lib/series-group';

/**
 * 系列折叠卡（方案 A）。
 *
 * 折叠态：一行，占位等同一条普通收藏——叠层封面 + 组名 + 「系列 N 部」+ 进度摘要。
 * 展开态：原地展开成 N 行，每行都是完整的 WatchlistItem（可搜源、可续播、可改状态）。
 *
 * 三条硬约束（都来自实测踩过的坑）：
 * 1. **折叠 ≠ 删数据**：成员记录原样保留，只是列表层先归组再渲染；
 *    搜索、同步、追更检测全部照旧，这里不碰任何数据层。
 * 2. **单部不入组**：成员数 < 2 时由 groupBySeries 直接还原成单条，本组件不会出现 1 部组。
 * 3. **展开态不落库**：sessionStorage 足够——刷新要保留，换设备不关心。
 */

/** 组内进度摘要：「已看完 4/4」「1 部已看 · 1 部想看」 */
function summarize(members: WatchlistEntry[]): string {
  const total = members.length;
  const watched = members.filter((m) => m.status === 'watched').length;
  const dropped = members.filter((m) => m.status === 'dropped').length;
  if (watched === total) return `已看完 ${total}/${total}`;
  if (watched > 0) {
    const extra = dropped > 0 ? ` · ${dropped} 部废弃` : '';
    return `${watched}/${total} 部已看${extra}`;
  }
  if (dropped === total) return '已全部废弃';
  return `已收录 ${total} 部`;
}

export function SeriesCard({
  group,
  expanded,
  onToggle,
  /** 搜索命中的成员片名：命中时组自动展开并高亮对应行 */
  matchedTitles = [],
}: {
  group: SeriesGroup<WatchlistEntry>;
  expanded: boolean;
  onToggle: () => void;
  matchedTitles?: string[];
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);

  const members = group.members.map((m) => m.item);
  // 封面取第一部有图的：组标题可能就是第一部，也可能缺第一部
  const cover = members.find((m) => m.pic)?.pic;
  const lastUpdated = Math.max(...members.map((m) => m.updatedAt));

  return (
    <li className="rounded-lg">
      <div
        className={cn(
          'rounded-lg border transition-colors',
          expanded ? 'border-accent/40 bg-accent/5' : 'border-line/70 bg-card hover:bg-hover'
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="w-full text-left p-3 pr-10 relative rounded-lg"
          title={expanded ? `收起「${group.title}」` : `展开「${group.title}」（共 ${group.size} 部）`}
        >
          <div className="flex items-center gap-3">
            {/* 叠层封面：三层错位卡片，比文字标签更快传达「这是一摞」 */}
            <div className="relative w-10 h-14 shrink-0">
              <span className="absolute inset-0 translate-x-[3px] -translate-y-[3px] rounded bg-chip border border-line/60" />
              <span className="absolute inset-0 translate-x-[1.5px] -translate-y-[1.5px] rounded bg-chip border border-line/80" />
              {cover && !imgFailed ? (
                <SmartImage
                  url={cover}
                  mode={imageProxyMode}
                  customProxy={customImageProxy}
                  alt=""
                  className="absolute inset-0 w-10 h-14 object-cover rounded bg-chip"
                  onExhausted={() => setImgFailed(true)}
                />
              ) : (
                <span className="absolute inset-0 rounded bg-chip flex items-center justify-center">
                  <Icon name="bookmark" className="w-4 h-4 text-faint" />
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium text-content truncate">{group.title}</span>
                <span className="shrink-0 inline-flex items-center rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-[0.05em] text-accent">
                  系列 {group.size} 部
                </span>
              </div>
              <div className="text-xs text-faint mt-0.5">
                {summarize(members)} · {formatRelativeTime(lastUpdated)}
              </div>
            </div>
          </div>
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-faint">
            <Icon
              name="chevronDown"
              className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')}
            />
          </span>
        </button>

        {expanded && (
          // 左侧竖线表示归属：即使成员行样式和普通条目完全一致，也能看出它们属于上面这张卡
          <ul className="space-y-2 pl-3 pr-3 pb-3 ml-4 border-l border-accent/25">
            {group.members.map((m, i) => (
              <WatchlistItem
                key={m.item.id}
                entry={m.item}
                order={i + 1}
                highlighted={matchedTitles.includes(m.title)}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
