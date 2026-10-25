'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState, LoadingState } from './states';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { useToast } from './toast';
import { db } from '@/lib/db';
import {
  STATUS_LABEL,
  STATUS_ORDER,
  clearWatchlistByStatus,
  removeWatchlistEntry,
  restoreWatchlistEntry,
  setWatchlistStatus,
  type WatchStatus,
  type WatchlistEntry,
} from '@/lib/watchlist';
import { buildWatchUrl, cn, formatRelativeTime, formatTime } from '@/lib/utils';
import { resolveSource, useAppStore } from '@/lib/store';

/**
 * 收藏夹抽屉：想看 / 在看 / 已看三个标签共享同一份骨架。
 * 与「观看历史」的差别：这里是用户主动维护的清单，已看由播放进度自动迁入，
 * 因此每栏都支持搜索、单条删除（可撤销）与整栏清空（需确认）。
 */

const TABS: WatchStatus[] = STATUS_ORDER;

const EMPTY_HINT: Record<WatchStatus, string> = {
  wish: '还没有想看的片子：在搜索结果里点「收藏」即可加入',
  watching: '还没有正在看的片子：在搜索结果里手动标记为「在看」才会加入',
  watched: '还没有看完的片子：任何视频播放到 90% 或播完，都会自动收录到这里',
  dropped: '没有废弃的片子：看不下去的在列表里改成「废弃」即可',
};

export function WatchlistPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<WatchStatus>('watching');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const { toast } = useToast();

  // 三栏各自实时查询：切换标签不需要重新拉全表
  const rows = useLiveQuery(
    () => db.watchlist.where('status').equals(tab).toArray(),
    [tab]
  );
  const counts = useLiveQuery(async () => {
    const all = await db.watchlist.toArray();
    const acc: Record<WatchStatus, number> = { wish: 0, watching: 0, watched: 0, dropped: 0 };
    for (const r of all) acc[r.status] += 1;
    return acc;
  }, []);

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const all = [...(rows ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!keyword) return all;
    return all.filter((r) => r.title.toLowerCase().includes(keyword));
  }, [rows, keyword]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="我的收藏"
      width="max-w-lg"
      subheader={
        <div className="space-y-2">
          {/* 三态标签：数量常驻，避免为了看有没有内容而逐栏点开 */}
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
          {(counts?.[tab] ?? 0) > 0 && (
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
      ) : visible.length === 0 ? (
        <EmptyState
          variant="plain"
          title={keyword ? `没有匹配「${query.trim()}」的条目` : EMPTY_HINT[tab]}
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((entry) => (
            <WatchlistItem key={entry.id} entry={entry} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClear}
        danger
        title={`清空「${STATUS_LABEL[tab]}」？`}
        message={
          counts ? `将删除 ${counts[tab]} 条记录，此操作不可撤销。` : undefined
        }
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

function WatchlistItem({ entry }: { entry: WatchlistEntry }) {
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
        className="block bg-card hover:bg-hover rounded-lg p-3 pr-10 transition-colors"
        title={`搜索「${entry.title}」以选择播放源`}
      >
        <div className="flex items-center gap-3">
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
            <div className="text-sm font-medium text-content truncate">{entry.title}</div>
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
              <div className="mt-1.5 h-1 bg-hover rounded-full overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
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
