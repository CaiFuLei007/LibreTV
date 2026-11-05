'use client';

import type { ReactNode } from 'react';
import { Icon } from './icon';
import { cn } from '@/lib/utils';
import type { MediaCategory } from '@/lib/media-category';

/**
 * 分类折叠分区（方案 D）。
 *
 * 与 `SeriesCard` 是同一套交互语言：块头可点、点一下收起整块、箭头翻转。
 * 用户在收藏夹里只需要学一种「折叠」的手势，而不是两种。
 *
 * 三个刻意的设计决定：
 *
 * 1. **空分区不渲染**。设计稿里画的是「0 也显示块头」，但实测发现收藏夹
 *    经常有 5~6 个空分类（综艺/短剧/体育/成人/其他），全显示会让块头比内容还多。
 *    改成：有条目才渲染。用户不会因为「综艺 0」消失而以为丢了片——他本来就没有综艺。
 *
 * 2. **默认展开**。默认收起的话每次进收藏都要先展开一轮，反而多两步。
 *    收起是「我这一类现在不想看」的临时动作，不是默认态。
 *
 * 3. **块头吸顶**。分类块之间滚动时，当前分类的块头贴在抽屉顶部，
 *    用户始终知道自己滚到了哪一类。这比在分段之间插标题更省纵向空间。
 */
export function CategorySection({
  category,
  label,
  count,
  expanded,
  onToggle,
  children,
  /** 分区内的系列数（用于块头副标题：「8 部 · 2 个系列」） */
  seriesCount,
}: {
  category: MediaCategory;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  seriesCount?: number;
}) {
  // 「其他」用中性色，避免和主分类抢注意力
  const tone = category === 'other' ? 'muted' : 'accent';

  return (
    <li className="list-none">
      <div
        className={cn(
          'sticky top-0 z-10 -mx-1 px-1 py-1',
          // 吸顶要有底色，否则滚动时内容会从块头下面透出来
          'bg-surface/95 backdrop-blur'
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={cn(
            'w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
            'bg-chip hover:bg-hover'
          )}
          title={
            expanded ? `收起「${label}」` : `展开「${label}」（${count} 条）`
          }
          data-category={category}
        >
          {/* 左侧色条：分类身份的视觉锚点，比文字标签更快识别 */}
          <span
            className={cn(
              'shrink-0 w-[3px] h-4 rounded-full',
              tone === 'accent' ? 'bg-accent' : 'bg-faint'
            )}
          />
          <span className="text-[13px] font-semibold text-content">{label}</span>
          <span
            className={cn(
              'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none tabular-nums',
              tone === 'accent' ? 'bg-accent/15 text-accent' : 'bg-line text-muted'
            )}
          >
            {count}
          </span>
          {seriesCount !== undefined && seriesCount > 0 && (
            <span className="text-[10.5px] text-faint">
              · {seriesCount} 个系列
            </span>
          )}
          <span className="ml-auto text-faint">
            <Icon
              name="chevronDown"
              className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')}
            />
          </span>
        </button>
      </div>

      {expanded && (
        // 左侧竖线表示归属，和系列折叠卡的视觉语言一致
        <ul className="mt-1.5 mb-1 space-y-2 pl-3 border-l border-line/70 ml-3">
          {children}
        </ul>
      )}
    </li>
  );
}
