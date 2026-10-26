'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { db, type HistoryEntry } from '@/lib/db';
import { useAppStore, resolveSource } from '@/lib/store';
import { buildWatchUrl, cn, formatTime } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Icon } from './icon';

/**
 * 首页「继续观看」条带。
 *
 * 为什么要有：续播数据一直都在（`db.progress` 与 `db.history`），但入口藏在
 * 顶栏「收藏 → 在看」标签里，要先点两下才能继续。主流平台（Netflix / YouTube /
 * B 站 / 爱奇艺）一律把「继续观看」放在首页第一屏——这是回访用户最高频的动作。
 *
 * 数据源用 `history` 而非 `watchlist`：观看历史在进播放页时就写入，覆盖面最广；
 * 而 `watchlist` 里只有用户主动标记过「在看」或被自动收录的条目，
 * 直接看片但没收藏的情况不会出现在那里。
 */

/** 低于这个秒数不算「看过」：点开即退的记录不该占据首屏 */
const MIN_RESUME_SECONDS = 30;
/** 看到这个比例就算看完，不再提示续播 */
const FINISHED_RATIO = 0.9;
/** 最多展示的条目数：首屏只留最可能续看的几条，多了要横向滚动才看得全 */
const MAX_ITEMS = 8;

function isResumable(entry: HistoryEntry): boolean {
  if (entry.playbackPosition < MIN_RESUME_SECONDS) return false;
  if (entry.duration <= 0) return true; // 时长未知时以位置为准，宁可多给一条
  return entry.playbackPosition / entry.duration < FINISHED_RATIO;
}

export function ContinueWatching() {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  // 只订这两个数组（引用稳定），不要 useAppStore() 整体订阅：
  // 那会在任何设置变更时重渲染整个条带
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);

  // 只取最近 40 条再本地筛：历史上限 100 条，全表读也不慢，
  // 但按时间倒序取前 40 已足够覆盖「最近在追的几部」
  const rows = useLiveQuery(async () => {
    const recent = await db.history.orderBy('timestamp').reverse().limit(40).toArray();
    return recent.filter(isResumable).slice(0, MAX_ITEMS);
  }, []);

  if (!rows || rows.length === 0) return null;

  return (
    <section aria-label="继续观看" className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-content flex items-center gap-1.5">
          <Icon name="play" className="w-4 h-4 text-accent" />
          继续观看
        </h2>
        <span className="text-xs text-faint">上次看到哪，从哪接着看</span>
      </div>

      {/* 横向滚动条带：主流平台都是这个形态，比换行堆砌更省纵向空间 */}
      <div className="-mx-4 px-4 overflow-x-auto">
        <ul className="flex gap-3 w-max pb-1">
          {rows.map((entry) => (
            <ContinueCard
              key={entry.id}
              entry={entry}
              imageMode={imageProxyMode}
              customProxy={customImageProxy}
              hasSource={Boolean(resolveSource({ customAPIs, envSources }, entry.sourceKey))}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ContinueCard({
  entry,
  imageMode,
  customProxy,
  hasSource,
}: {
  entry: HistoryEntry;
  imageMode: 'direct' | 'proxy' | 'custom';
  customProxy: string;
  hasSource: boolean;
}) {
  const percent =
    entry.duration > 0
      ? Math.min(100, Math.round((entry.playbackPosition / entry.duration) * 100))
      : null;

  // 源还在：直接回到上次那一集、带上次的进度续播。
  // 源已被删（用户清理过自定义源）：退回按片名搜索，让用户重新选源，
  // 这比给一个点了必然报「点播源不存在」的链接要有用。
  const href = hasSource
    ? `${buildWatchUrl({
        sourceKey: entry.sourceKey,
        vodId: entry.vodId,
        index: entry.episodeIndex,
        title: entry.title,
        sourceUrl: entry.sourceUrl,
      })}&position=${Math.floor(entry.playbackPosition)}`
    : `/?s=${encodeURIComponent(entry.title)}`;

  return (
    <li className="w-[168px] shrink-0">
      <Link
        href={href}
        className="group block"
        title={
          hasSource
            ? `续看「${entry.title}」第 ${entry.episodeIndex + 1} 集，从 ${formatTime(entry.playbackPosition)} 开始`
            : `点播源已失效，按片名重新搜索「${entry.title}」`
        }
      >
        <div className="relative aspect-[2/3] rounded-[var(--radius-card)] overflow-hidden bg-chip">
          {entry.pic ? (
            <SmartImage
              url={entry.pic}
              mode={imageMode}
              customProxy={customProxy}
              alt={entry.title}
              className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Icon name="play" className="w-6 h-6 text-faint" />
            </div>
          )}
          {/* 播放遮罩：hover 才浮现，避免静止时一堆圆圈压在海报上 */}
          <div className="absolute inset-0 flex items-center justify-center bg-page/40 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-content/90">
              <Icon name="play" className="w-4 h-4 text-page translate-x-[1px]" />
            </span>
          </div>
          {/* 进度条压在封面底部：与收藏面板同款 3px 规格 */}
          {percent !== null && (
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-line/80">
              <div
                className={cn('h-full bg-accent')}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
        <div className="mt-1.5 min-w-0">
          <div className="text-xs font-medium text-content truncate">{entry.title}</div>
          <div className="text-[11px] text-faint truncate">
            {entry.totalEpisodes > 1 ? `第 ${entry.episodeIndex + 1} 集` : '电影'}
            {percent !== null && ` · 已看 ${percent}%`}
            {!hasSource && ' · 需重新选源'}
          </div>
        </div>
      </Link>
    </li>
  );
}
