'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { SearchTab } from '@/lib/search-tabs';

/**
 * 搜索结果顶部的类型切换条（方案 E 的 tab 部分）。
 *
 * 三个刻意的设计决定：
 *
 * 1. **分段控件而不是下划线 tab**。分段控件的「一组按钮」形态能直接传达
 *    「这些是互斥选项」，且小屏横滚时不会出现下划线对不齐。爱奇艺 / 腾讯视频 /
 *    豆瓣搜索结果页用的都是这种形态。
 *
 * 2. **每个 tab 带条数**。「电影 61」先说清值不值得切——计数为 0 的分类
 *    根本不会传进来（见 `visibleTabs`），所以这里不需要处理空 tab 的灰态。
 *
 * 3. **溢出时两侧渐隐**。手机上 tab 数超过 4 个就会溢出，横向滚动条在触屏上
 *    几乎看不见；不提示「右边还有」，用户会以为只有这几个 tab。
 *    渐隐只在真的溢出、且该侧真的还有内容时出现，不遮挡任何可点区域。
 */
export function SearchTabBar({
  tabs,
  active,
  onChange,
  /** 搜索进行中：计数还在长，用脉冲提示「数字会变」 */
  pending,
}: {
  tabs: { tab: SearchTab; label: string; count: number }[];
  active: SearchTab;
  onChange: (tab: SearchTab) => void;
  pending?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdge({
      left: el.scrollLeft > 2,
      // 2px 容差：子像素宽度会让「刚好滚到底」算出 0.5 之类的残值
      right: max > 2 && el.scrollLeft < max - 2,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el) return;
    // ResizeObserver 覆盖「旋转屏幕 / 窗口缩放 / tab 数变化」三种重排
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length]);

  // 选中的 tab 可能滚到视野外（点「其他」再刷新，它不在首屏范围）：
  // 只滚容器、不滚页面，避免整页跳到别处
  useEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="按类型筛选搜索结果"
        onScroll={measure}
        className="flex items-center gap-2 overflow-x-auto scrollbar-thin pb-1 -mb-1"
      >
        {tabs.map(({ tab, label, count }) => {
          const on = tab === active;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={on}
              data-tab={tab}
              data-active={on ? '1' : undefined}
              onClick={() => onChange(tab)}
              className={cn(
                'shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 h-8',
                'text-[13px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                on
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface text-muted border border-line hover:text-content hover:bg-hover'
              )}
            >
              {label}
              <span
                className={cn(
                  'tabular-nums text-[11px] font-bold leading-none rounded-full px-1.5 py-0.5',
                  on ? 'bg-black/20' : 'bg-chip text-faint',
                  pending && 'animate-pulse'
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 渐隐遮罩：pointer-events-none 保证不挡点击 */}
      {edge.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-page to-transparent"
        />
      )}
      {edge.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-page to-transparent"
        />
      )}
    </div>
  );
}
