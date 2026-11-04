'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { useToast } from './toast';
import {
  STATUS_LABEL,
  STATUS_ORDER,
  removeWatchlistEntry,
  restoreWatchlistEntry,
  setWatchlistStatus,
  type WatchStatus,
  type WatchlistEntry,
} from '@/lib/watchlist';
import { buildWatchUrl, cn, formatRelativeTime, formatTime } from '@/lib/utils';
import { resolveSource, useAppStore } from '@/lib/store';
import { acknowledgeEpisodes } from '@/lib/episode-tracker';

/**
 * 收藏列表的**单条行**：独立条目与系列组成员共用同一个组件。
 *
 * 抽出来的理由：系列折叠后，组内成员必须和普通条目具备完全一样的能力
 * （去搜索选源、上次的源续播、改状态、移除+撤销），任何「组内只能看不能操作」
 * 的设计都会逼用户先退出分组——那是把便利变成了门槛。
 */
export function WatchlistItem({
  entry,
  /** 系列组内序号（1 基）；独立条目传 undefined 则不显示 */
  order,
  /** 搜索命中的那一行：加一圈高亮，避免「搜到了但看不出来」 */
  highlighted = false,
}: {
  entry: WatchlistEntry;
  order?: number;
  highlighted?: boolean;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 收藏不绑定源：lastSourceKey 只是上次用过的线索，可能缺失或已失效
  const source = entry.lastSourceKey
    ? resolveSource({ customAPIs, envSources }, entry.lastSourceKey, {
        url: entry.lastSourceUrl,
        name: entry.lastSourceUrl ? '上次使用的源' : undefined,
      })
    : undefined;

  // 展开期间点外部收起（与卡片上的收藏菜单一致）
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setStatusOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [statusOpen]);

  const hasPercent =
    entry.playbackPosition > 10 &&
    entry.duration > 0 &&
    entry.playbackPosition < entry.duration * 0.95;
  const percent = hasPercent ? Math.round((entry.playbackPosition / entry.duration) * 100) : 0;

  /**
   * 点击收藏项 → 跳到搜索页按片名重新搜，而不是直接进播放页。
   * 理由：收藏不绑定源，当初那个源可能失效或画质更差；
   * 「先去搜、再挑源、然后播」才是正常路径，也避免一进来就发现播不了。
   */
  const searchHref = `/?s=${encodeURIComponent(entry.title)}`;
  // 上次用的源还在配置里才给「接着看」：源被删掉时这条链接会 404
  const resumeHref =
    entry.lastSourceKey && entry.lastVodId && source
      ? buildWatchUrl({
          sourceKey: entry.lastSourceKey,
          vodId: entry.lastVodId,
          index: entry.episodeIndex,
          title: entry.title,
          sourceUrl: entry.lastSourceUrl ?? source.url,
          detail: source.detail,
        })
      : null;

  const remove = () => {
    void removeWatchlistEntry(entry.title).then(() => {
      toast('已从收藏移除', 'info', {
        action: {
          label: '撤销',
          onClick: () => {
            void restoreWatchlistEntry(entry).then(() => toast('已恢复', 'success'));
          },
        },
      });
    });
  };

  // 列表内直接改状态：改完条目会从当前栏消失，故用 toast 告知去了哪一栏
  const changeStatus = (next: WatchStatus) => {
    if (next === entry.status) return;
    void setWatchlistStatus(entry.title, next).then(() => {
      toast(`已移至「${STATUS_LABEL[next]}」`, 'success');
    });
  };

  return (
    <li className="relative group">
      <Link
        href={searchHref}
        className={cn(
          'block rounded-lg p-3 pr-10 transition-colors',
          highlighted
            ? 'bg-accent/10 ring-1 ring-accent/50 hover:bg-accent/15'
            : 'bg-card hover:bg-hover'
        )}
        title={`搜索「${entry.title}」以选择播放源`}
        onClick={() => {
          // 用户要去看这部剧了：红点使命完成，已知集数推进到最新
          void acknowledgeEpisodes(entry.title);
        }}
      >
        <div className="flex items-center gap-3">
          {order !== undefined && (
            <span className="shrink-0 w-5 text-center text-[11px] font-semibold tabular-nums text-faint">
              {order}
            </span>
          )}
          {entry.pic && !imgFailed ? (
            <SmartImage
              url={entry.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="w-10 h-14 object-cover rounded bg-chip"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-10 h-14 rounded bg-chip flex items-center justify-center shrink-0">
              <Icon name="bookmark" className="w-4 h-4 text-faint" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-medium text-content truncate">{entry.title}</div>
              {entry.hasNewEpisodes && (
                <span
                  className="shrink-0 inline-flex items-center rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-[0.05em] text-danger"
                  title={`已更新到第 ${entry.totalEpisodes} 集，点开后可清除提示`}
                >
                  新增
                </span>
              )}
            </div>
            <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">
              {entry.totalEpisodes > 0 && (
                <span>
                  第 {entry.episodeIndex + 1}/{entry.totalEpisodes} 集
                </span>
              )}
              {hasPercent && <span>· {formatTime(entry.playbackPosition)}</span>}
              <span>· {formatRelativeTime(entry.updatedAt)}</span>
            </div>
            {hasPercent && (
              <div className="mt-1.5 h-[3px] bg-line rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </div>
      </Link>
      {/* 主点击是「去搜索选源」；这里再给一个源仍有效时的快捷续播 */}
      {resumeHref && (
        <Link
          href={resumeHref}
          className="absolute right-[4.6rem] top-2 p-2 rounded-full text-faint hover:text-accent hover:bg-hover transition-colors"
          aria-label="用上次的源接着看"
          title={`用上次的源（${source?.name ?? '未知'}）接着看`}
        >
          <Icon name="play" className="w-4 h-4" />
        </Link>
      )}

      {/* 状态切换与删除并排：常驻可见，手机上无 hover 也能操作 */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            className="p-2 rounded-full text-faint hover:text-accent hover:bg-hover transition-colors"
            aria-label="修改状态"
            aria-haspopup="menu"
            aria-expanded={statusOpen}
            title="修改状态"
            onClick={() => setStatusOpen((v) => !v)}
          >
            <Icon name="edit" className="w-4 h-4" />
          </button>
          {statusOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-20 w-28 rounded-lg border border-line bg-surface-raised shadow-lg p-1 animate-fade-in"
            >
              {STATUS_ORDER.map((st) => (
                <button
                  key={st}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.status === st}
                  onClick={() => {
                    setStatusOpen(false);
                    changeStatus(st);
                  }}
                  className={cn(
                    'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-left transition-colors',
                    entry.status === st
                      ? 'text-accent bg-accent/10'
                      : 'text-content hover:bg-hover'
                  )}
                >
                  <span className="flex-1">{STATUS_LABEL[st]}</span>
                  {entry.status === st && <Icon name="check" className="w-3 h-3" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="p-2 rounded-full text-faint hover:text-danger hover:bg-hover transition-colors"
          aria-label="从收藏移除"
          title="从收藏移除（可在提示中撤销）"
          onClick={remove}
        >
          <Icon name="close" className="w-4 h-4" />
        </button>
      </div>
    </li>
  );
}
