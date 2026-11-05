'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';
import { useToast } from './toast';
import { db } from '@/lib/db';
import {
  STATUS_LABEL,
  STATUS_ORDER,
  saveWatchlistEntry,
  toggleWatchlistStatus,
  watchlistKeyOf,
  type WatchStatus,
  type WatchlistSeed,
} from '@/lib/watchlist';
import type { SearchResultItem } from '@/lib/types';

/**
 * 「想看 / 在看 / 已看 / 废弃」四态开关（搜索卡片、详情弹窗、播放页共用）。
 *
 * 关键点：**收藏不绑定视频源**。收藏的身份是片名，因此在这里加入时
 * 不需要用户挑源——搜索结果里是哪一条都行，点一下就把这部剧记下来。
 * 真要播的时候再去搜索页重新选源（那才是选源的合适时机）。
 *
 * 交互取舍：不做四个并排按钮——卡片宽度只有约 330px，四个按钮会把标题挤没。
 * 默认展示当前状态（未收藏时是「+ 收藏」），点开才露出选项；
 * 选中某个状态后再点同一项即取消收藏。
 *
 * 三档外观 + 两种点击语义：
 *
 * | variant   | 用在哪        | 未收藏时点一下     | 已收藏时点一下 |
 * |-----------|--------------|------------------|--------------|
 * | compact   | 搜索卡片角标   | 展开菜单           | 展开菜单      |
 * | full      | 详情弹窗       | 展开菜单           | 展开菜单      |
 * | button    | 播放页头部     | **直接加入「在看」** | 展开菜单（改状态/取消） |
 *
 * 播放页单独做成「一点即收藏」：用户此刻正在看这部片，让他先展开菜单再选
 * 「在看」，等于多问一句废话。已收藏后按钮变成状态色，再点才展开菜单去改。
 */

const STATUS_ICON: Record<WatchStatus, IconName> = {
  wish: 'bookmark',
  watching: 'play',
  watched: 'check',
  dropped: 'trash',
};

/** 由搜索结果条目生成收藏入参：只取片名与展示信息，不绑定源 */
export function seedOf(item: SearchResultItem): WatchlistSeed {
  return {
    title: item.name,
    pic: item.pic,
    typeName: item.typeName,
    year: item.year,
    area: item.area,
    remarks: item.remarks,
    lastSourceKey: item.sourceKey,
    lastSourceUrl: item.sourceUrl,
    lastVodId: item.vodId,
  };
}

/** 当前收藏状态（无记录返回 null，加载中返回 undefined） */
export function useWatchStatus(title?: string): WatchStatus | null | undefined {
  return useLiveQuery(async () => {
    if (!title) return null;
    const row = await db.watchlist.get(watchlistKeyOf(title));
    return row?.status ?? null;
  }, [title]);
}

export function WatchlistActions({
  seed,
  /** 卡片内用紧凑样式，弹窗内用带文字的常规样式，播放页头部用与 btn-ghost btn-sm 一致的外观 */
  variant = 'compact',
  className,
}: {
  seed: WatchlistSeed | null;
  variant?: 'compact' | 'full' | 'button';
  className?: string;
}) {
  const { toast } = useToast();
  const status = useWatchStatus(seed?.title);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 展开期间点外部收起：与 Dropdown 行为一致
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!seed) return null;

  const pick = (target: WatchStatus) => {
    setOpen(false);
    void toggleWatchlistStatus(seed, target).then((next) => {
      if (next) toast(`已加入「${STATUS_LABEL[next]}」`, 'success');
      else toast('已取消收藏', 'info');
    });
  };

  /**
   * 播放页的「一点即收藏」。
   * 直接落「在看」并带上当前集数与进度（seed 里已备好），
   * 这样收藏列表立刻显示「第 N/M 集」而不是等下一次播放埋点。
   */
  const quickAdd = () => {
    setSaving(true);
    void saveWatchlistEntry({ ...seed, status: 'watching' })
      .then(() => toast(`已加入「在看」`, 'success'))
      .catch(() => toast('加入收藏失败，请重试', 'error'))
      .finally(() => setSaving(false));
  };

  const current = status ?? null;
  const label = current ? STATUS_LABEL[current] : '收藏';
  const icon: IconName = current ? STATUS_ICON[current] : 'plus';
  const isButton = variant === 'button';

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        // 卡片整块可点，按钮必须截断冒泡，否则会顺带打开详情
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          // 播放页且尚未收藏：一点即入「在看」，不弹菜单
          if (isButton && !current) {
            quickAdd();
            return;
          }
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={saving}
        aria-label={
          current ? `已标记为${label}，点击修改` : isButton ? '加入收藏（在看）' : '添加到收藏'
        }
        title={
          current
            ? `已标记为「${label}」（再点可改状态或取消）`
            : isButton
              ? '加入收藏，直接记为「在看」'
              : '加入到「想看 / 在看 / 已看 / 废弃」'
        }
        className={cn(
          'flex items-center gap-1 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          isButton
            ? // 与同行「下载本集 / 切换资源」完全同款，只把「已收藏」态染成强调色
              cn(
                'btn-ghost btn-sm',
                current && 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20',
                saving && 'opacity-60'
              )
            : cn(
                'rounded-md',
                variant === 'compact' ? 'px-1.5 py-1 text-[10px]' : 'px-2.5 py-1.5 text-xs',
                current
                  ? 'text-accent bg-accent/10 hover:bg-accent/20'
                  : 'text-faint hover:text-content hover:bg-hover'
              )
        )}
      >
        <Icon
          name={icon}
          className={cn('shrink-0', variant === 'compact' ? 'w-3 h-3' : isButton ? 'w-3.5 h-3.5' : 'w-4 h-4')}
        />
        {/* 播放页窄屏只留图标：头部已有标题、下载、换源，文字标签会把标题挤没 */}
        <span className={cn('truncate', isButton && 'hidden sm:inline')}>
          {saving ? '加入中' : label}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-20 right-0 mt-1 w-28 rounded-lg border border-line bg-surface-raised',
            'shadow-lg p-1 animate-fade-in'
          )}
        >
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={current === s}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                pick(s);
              }}
              className={cn(
                'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-left transition-colors',
                current === s ? 'text-accent bg-accent/10' : 'text-content hover:bg-hover'
              )}
            >
              <Icon name={STATUS_ICON[s]} className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1">{STATUS_LABEL[s]}</span>
              {current === s && <Icon name="close" className="w-3 h-3 text-faint" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
