import { db } from './db';

/**
 * 追番/观影清单（想看 / 在看 / 已看 / 废弃 四态）。
 *
 * 身份设计：**以片名为唯一标识，不与视频源绑定**。
 * 同一部片在十个采集站都有条目，用户关心的是「这部剧我什么状态」，
 * 而不是「我在哪个源上标的」。因此：
 * - 在搜索页看到任何一个源，都能直接加入收藏，无需先选源；
 * - 点开收藏项时去搜索页重新选源，而不是锁死在当初那个源上
 *   （那个源可能已失效，换源观看才是常态）。
 * 最近一次播放的 sourceKey/vodId 只作为附带线索保存，不参与身份判定。
 *
 * 与 `history` 表的分工：
 * - history 是「播放足迹」：进过播放页就写，用于续播与最近观看，纯客观记录；
 * - watchlist 是「我的收藏」：想看/在看/废弃完全由用户选择；唯一的自动行为
 *   是播放到 90% 或播完时落到「已看」（废弃除外）。
 */

export type WatchStatus = 'wish' | 'watching' | 'watched' | 'dropped';

/** 状态展示顺序：运营中的在前，废弃垫底 */
export const STATUS_ORDER: WatchStatus[] = ['watching', 'wish', 'watched', 'dropped'];

export interface WatchlistEntry {
  /** 主键：归一化后的片名，见 watchlistKeyOf */
  id: string;
  title: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  status: WatchStatus;
  /** 最近看到第几集（0 基） */
  episodeIndex: number;
  totalEpisodes: number;
  playbackPosition: number;
  duration: number;
  /** 最近一次播放用的源，仅作线索（换源后会被覆盖），不参与身份判定 */
  lastSourceKey?: string;
  lastSourceUrl?: string;
  lastVodId?: string;
  updatedAt: number;
  createdAt: number;
}

/** 进度达到该比例即视为「已看」（真的看完，挂机不算） */
export const WATCHED_THRESHOLD = 0.9;

export const STATUS_LABEL: Record<WatchStatus, string> = {
  wish: '想看',
  watching: '在看',
  watched: '已看',
  dropped: '废弃',
};

/**
 * 片名归一化：去首尾空格、内部连续空白压成一个、忽略大小写与全角空格。
 * 采集站的片名常有「[HD]」「(2024)」之外的细微差异，这里只抹平空白与大小写，
 * 不做模糊匹配——模糊匹配会把「招魂」和「招魂2」并成一部。
 */
export function normalizeTitle(title: string): string {
  return title.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 收藏主键：片名归一化结果 */
export function watchlistKeyOf(title: string): string {
  return normalizeTitle(title);
}

/** 依据播放进度判断是否已看完 */
export function isFinished(position: number, duration: number): boolean {
  if (!duration || duration <= 0) return false;
  if (position <= 0) return false;
  return position / duration >= WATCHED_THRESHOLD;
}

export async function getWatchlistEntry(title: string): Promise<WatchlistEntry | undefined> {
  return db.watchlist.get(watchlistKeyOf(title));
}

export async function listWatchlist(status?: WatchStatus): Promise<WatchlistEntry[]> {
  const rows = status
    ? await db.watchlist.where('status').equals(status).toArray()
    : await db.watchlist.toArray();
  // 最近变动的排前面：各栏共用同一种序，切栏不用重新适应
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 收藏入参：片名必填，其余可选。
 * 搜索结果卡片只有标题/封面，拿不到集数与进度；硬性要求齐全会逼调用方伪造 0，
 * 这里统一在写入时补默认值，播放页再逐次覆盖。
 */
export interface WatchlistSeed {
  title: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  status?: WatchStatus;
  episodeIndex?: number;
  totalEpisodes?: number;
  playbackPosition?: number;
  duration?: number;
  lastSourceKey?: string;
  lastSourceUrl?: string;
  lastVodId?: string;
}

/** 新增或整体更新一条收藏（用户显式操作：改状态即刷新 updatedAt） */
export async function saveWatchlistEntry(seed: WatchlistSeed): Promise<void> {
  const id = watchlistKeyOf(seed.title);
  if (!id) return;
  const now = Date.now();
  const existing = await db.watchlist.get(id);
  const merged: WatchlistEntry = {
    id,
    episodeIndex: 0,
    totalEpisodes: 0,
    playbackPosition: 0,
    duration: 0,
    ...existing,
    ...seed,
    // 片名以本次传入为准（seed 里的已是 trim 前的原始值，这里统一规范化）
    title: seed.title.trim(),
    status: seed.status ?? existing?.status ?? 'wish',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  merged.episodeIndex = merged.episodeIndex ?? 0;
  merged.totalEpisodes = merged.totalEpisodes ?? 0;
  merged.playbackPosition = merged.playbackPosition ?? 0;
  merged.duration = merged.duration ?? 0;
  await db.watchlist.put(merged);
}

/**
 * 切换状态；目标状态与当前相同时视为「取消收藏」。
 * 返回新状态，null 表示已移除。
 */
export async function toggleWatchlistStatus(
  seed: WatchlistSeed,
  target: WatchStatus
): Promise<WatchStatus | null> {
  const id = watchlistKeyOf(seed.title);
  if (!id) return null;
  const existing = await db.watchlist.get(id);
  if (existing?.status === target) {
    await db.watchlist.delete(id);
    return null;
  }
  await saveWatchlistEntry({ ...seed, status: target });
  return target;
}

/**
 * 只改状态、保留其余字段（收藏列表里直接切换用）。
 * 不经过 saveWatchlistEntry：那条路径按「用户新增收藏」语义会重建缺省字段，
 * 而这里条目一定已存在，只需改状态与时间戳。
 */
export async function setWatchlistStatus(title: string, status: WatchStatus): Promise<void> {
  await db.watchlist.update(watchlistKeyOf(title), {
    status,
    updatedAt: Date.now(),
  });
}

export async function removeWatchlistEntry(title: string): Promise<void> {
  await db.watchlist.delete(watchlistKeyOf(title));
}

/** 撤销删除：按原样回填（保留原始时间戳，不会把恢复的记录顶到最前） */
export async function restoreWatchlistEntry(entry: WatchlistEntry): Promise<void> {
  await db.watchlist.put(entry);
}

export async function clearWatchlistByStatus(status: WatchStatus): Promise<WatchlistEntry[]> {
  const rows = await db.watchlist.where('status').equals(status).toArray();
  await db.watchlist.bulkDelete(rows.map((r) => r.id));
  return rows;
}

export interface EpisodeProgress {
  sourceKey: string;
  sourceUrl?: string;
  vodId: string;
  episodeIndex: number;
  position: number;
  duration: number;
}

/** 播放页需要提供的最小元数据（片名是身份，必填） */
export interface PlaybackMeta {
  title: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  totalEpisodes?: number;
}

/**
 * 播放进度驱动的状态迁移（播放页埋点调用）。
 *
 * 规则：**播完或进度跨过 90% 即进入「已看」**，不论此前是否收藏过——
 * 看完就是看完，不该因为忘了点收藏就丢失记录（没有记录会自动建档）。
 *
 * 其余行为一律不自动发生：
 * - 播放**不会**把片子加入「在看」（加入只能由用户手动选择）；
 * - 也不会把「已看」「想看」改成别的状态：重刷一部已看的片，它留在已看；
 * - 「废弃」是用户主动放弃的结论，播完也不改判，否则补看完一集就会
 *   把丢掉的片子拽回「已看」，等于推翻用户的选择；
 * - 进度只在「在看」项上顺带刷新，用于展示「看到第几集」。
 */
export async function applyPlaybackProgress(
  p: EpisodeProgress,
  meta: PlaybackMeta
): Promise<void> {
  const title = (meta.title ?? '').trim();
  // 拿不到有效片名就不能建档：否则所有无标题播放会挤进同一条「未知视频」
  if (!title || title === '未知视频') return;
  const id = watchlistKeyOf(title);
  if (!id) return;

  const existing = await db.watchlist.get(id);
  const now = Date.now();
  const finished = isFinished(p.position, p.duration);
  const sourcePatch = {
    lastSourceKey: p.sourceKey,
    lastSourceUrl: p.sourceUrl,
    lastVodId: p.vodId,
  };

  // 未建档：只有「看完」才建档进已看；没看完就直接忽略
  if (!existing) {
    if (!finished) return;
    await db.watchlist.put({
      id,
      title,
      pic: meta.pic,
      typeName: meta.typeName,
      year: meta.year,
      area: meta.area,
      remarks: meta.remarks,
      status: 'watched',
      episodeIndex: p.episodeIndex,
      totalEpisodes: meta.totalEpisodes ?? 0,
      playbackPosition: p.position,
      duration: p.duration,
      ...sourcePatch,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  // 废弃是用户结论，播放不改判
  if (existing.status === 'dropped') return;

  // 已建档：看完则落到已看；顺带把最新的源线索记下来
  if (finished) {
    await db.watchlist.update(id, {
      status: 'watched',
      episodeIndex: p.episodeIndex,
      playbackPosition: p.position,
      duration: p.duration || existing.duration,
      ...sourcePatch,
      updatedAt: now,
    });
    return;
  }

  // 未看完：只刷新「在看」项的进度与源线索
  if (existing.status !== 'watching') return;
  const patch: Partial<WatchlistEntry> = { ...sourcePatch };
  if (p.position > existing.playbackPosition + 1) {
    patch.playbackPosition = p.position;
    if (p.duration > 0) patch.duration = p.duration;
  }
  if (p.episodeIndex !== existing.episodeIndex) patch.episodeIndex = p.episodeIndex;
  patch.updatedAt = now;
  await db.watchlist.update(id, patch);
}
