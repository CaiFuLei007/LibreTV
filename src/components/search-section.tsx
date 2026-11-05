'use client';

import type { ReactNode } from 'react';
import { Icon } from './icon';
import { cn } from '@/lib/utils';
import type { MediaCategory } from '@/lib/media-category';

/**
 * 搜索结果里的一段（方案 E 的「全部」tab 内分组）。
 *
 * 与收藏夹的 `CategorySection` 是同一套视觉语言的**扁平版**：都用「色条 + 分类名 + 计数
 * + 右侧操作」，但这里刻意不做折叠——
 *
 * - 收藏夹的段可收起，是因为一个分类动辄几十条，用户想跳过整类；
 * - 搜索里的段默认只露 6 条，本身很短；再加一层「收起」，
 *   「怎么看完整」就变成两个手势（先展开再收起）。
 *
 * 所以只有两个动作，语义互不重叠：
 * - **「查看全部 N 部」**＝解除「每段 6 条」的预览截断（只存在于「全部」tab）；
 * - **「加载更多」**＝分批挂载的下一页（防止一次插上百张卡）。
 */

/** 分类色条：与收藏夹一致的语义色，让两类界面能对上号 */
const TONE: Record<MediaCategory, string> = {
  movie: 'bg-accent',
  tv: 'bg-purple-500',
  anime: 'bg-success',
  variety: 'bg-pink-500',
  short: 'bg-warning',
  sport: 'bg-info',
  adult: 'bg-danger',
  other: 'bg-faint',
};

export function SearchSection({
  category,
  label,
  total,
  /** 当前渲染之后还剩多少条没出现（预览截断 + 分批挂载都算在内） */
  hidden,
  /** 是否处于「全部」tab：只有这里才有「预览 6 条」这一步 */
  expandable,
  /** 该段是否被「预览 6 条」截断 */
  previewing,
  /** 该段是否已解除预览截断 */
  expanded,
  onExpand,
  onCollapse,
  onLoadMore,
  children,
}: {
  category: MediaCategory;
  label: string;
  total: number;
  hidden: number;
  previewing: boolean;
  expandable: boolean;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onLoadMore: () => void;
  children: ReactNode;
}) {
  // 「查看全部」只在「预览确实在截断」时出现：一段只有 3 部却给出
  // 「查看全部 3 部」是空动作，点下去什么都不会变。
  const showExpandAll = expandable && previewing;
  const showCollapse = expandable && expanded;
  // 预览截断还在时不让「加载更多」与「查看全部」并存——两个按钮都指向前进，
  // 用户不知道该点哪个。先解除预览，再按页加载。
  const showLoadMore = hidden > 0 && !previewing;

  return (
    <section
      data-search-section={category}
      data-expanded={expanded ? '1' : undefined}
      aria-label={`${label} ${total} 部`}
      className="mb-6 last:mb-0"
    >
      <div className="flex items-center gap-2 mb-2.5">
        {/* 色条：分类身份的视觉锚点，扫视时比读文字快 */}
        <span className={cn('w-[3px] h-4 rounded-full shrink-0', TONE[category])} />
        <h3 className="text-[15px] font-semibold text-content">{label}</h3>
        <span className="text-[11px] text-faint tabular-nums">{total} 部</span>

        {(showExpandAll || showCollapse) && (
          <button
            type="button"
            onClick={showExpandAll ? onExpand : onCollapse}
            aria-expanded={expanded}
            data-section-action={showExpandAll ? 'expand' : 'collapse'}
            className={cn(
              'ml-auto inline-flex items-center gap-0.5 text-[12px] rounded px-1.5 py-0.5',
              'text-accent hover:bg-accent/10 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            )}
          >
            {showExpandAll ? (
              <>
                查看全部 {total} 部
                <Icon name="chevronDown" className="w-3.5 h-3.5" />
              </>
            ) : (
              <>
                收起
                <Icon name="chevronDown" className="w-3.5 h-3.5 rotate-180" />
              </>
            )}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
        {children}
        {showLoadMore && (
          <div className="col-span-full flex justify-center pt-1">
            <button type="button" className="btn-ghost btn-sm" onClick={onLoadMore}>
              加载更多（还有 {hidden} 部）
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
