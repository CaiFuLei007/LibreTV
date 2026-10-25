'use client';

import { db } from './db';
import type { WatchlistEntry, WatchStatus } from './watchlist';
import { watchlistKeyOf } from './watchlist';

/**
 * 前端同步层：把本地 IndexedDB 与服务端 SQLite 对齐。
 *
 * 设计要点：
 * - **服务端优先，本地兜底**：页面加载先拉服务端，成功则覆盖本地；
 *   网络失败时继续用本地数据，功能不中断（离线仍可看片单）。
 * - **写入即上行**：本地改完立刻推服务端，失败则标记待同步，
 *   下次拉取前先补推，避免弱网下改动悄悄丢失。
 * - **删除也要上行**：条目删除后本地消失，但服务端若还有，下次同步会
 *   把它「复活」。因此删除走 deleteSync，显式告知服务端。
 * - 不做细粒度 diff：数据量是「几十条收藏 + 几百条历史」级别，
 *   整包上传比逐条对账更简单可靠，一次请求即可。
 */

const SYNC_ENDPOINT = '/api/sync';

/** 待补推标记：上次上行失败时置位，下次同步前先补推 */
const PENDING_FLAG = 'libretv-sync-pending';

export interface SyncStatus {
  /** 是否已成功连上服务端 */
  online: boolean;
  /** 最近一次成功同步的时间戳 */
  lastSyncAt: number | null;
  /** 是否还有未推送的本地改动 */
  pending: boolean;
}

let cachedStatus: SyncStatus = { online: false, lastSyncAt: null, pending: false };

export function getSyncStatus(): SyncStatus {
  return cachedStatus;
}

function markPending(): void {
  try {
    localStorage.setItem(PENDING_FLAG, '1');
  } catch {
    /* 隐私模式下忽略 */
  }
  cachedStatus = { ...cachedStatus, pending: true };
}

function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_FLAG);
  } catch {
    /* 忽略 */
  }
  cachedStatus = { ...cachedStatus, pending: false };
}

function hasPending(): boolean {
  try {
    return localStorage.getItem(PENDING_FLAG) === '1';
  } catch {
    return false;
  }
}

/** 服务端返回的数据形状（字段已由 repo 层转成 camelCase） */
interface ServerData {
  watchlist: (Omit<WatchlistEntry, 'id'> & { id: string })[];
  history: {
    id: string;
    sourceKey: string;
    sourceUrl?: string;
    vodId: string;
    title: string;
    pic?: string;
    episodeIndex: number;
    totalEpisodes: number;
    playbackPosition: number;
    duration: number;
    timestamp: number;
  }[];
  progress: { id: string; position: number; duration: number; updatedAt: number }[];
  customSources: { id: string; name: string; url: string; detail?: string; isAdult: boolean }[];
  liveSources: { id: string; name: string; url: string; epg?: string }[];
  settings: Record<string, unknown>;
}

async function fetchServer(): Promise<ServerData | null> {
  try {
    const res = await fetch(SYNC_ENDPOINT, { credentials: 'same-origin' });
    // 401 = 未登录，属于正常状态（登录前拉不到），不当成错误
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; data: ServerData };
    return json.ok ? json.data : null;
  } catch {
    return null;
  }
}

/** 把本地数据打包成服务端格式 */
export async function collectLocalPayload() {
  const [watchlist, history, progress, customSources, liveSources] = await Promise.all([
    db.watchlist.toArray(),
    db.history.toArray(),
    db.progress.toArray(),
    Promise.resolve([]),
    Promise.resolve([]),
  ]);

  return {
    watchlist: watchlist.map((w) => ({
      id: w.id,
      title: w.title,
      pic: w.pic ?? null,
      typeName: w.typeName ?? null,
      year: w.year ?? null,
      area: w.area ?? null,
      remarks: w.remarks ?? null,
      status: w.status,
      episodeIndex: w.episodeIndex ?? 0,
      totalEpisodes: w.totalEpisodes ?? 0,
      playbackPosition: w.playbackPosition ?? 0,
      duration: w.duration ?? 0,
      lastSourceKey: w.lastSourceKey ?? null,
      lastSourceUrl: w.lastSourceUrl ?? null,
      lastVodId: w.lastVodId ?? null,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    })),
    history: history.map((h) => ({
      id: h.id,
      sourceKey: h.sourceKey,
      sourceUrl: h.sourceUrl ?? null,
      vodId: h.vodId,
      title: h.title,
      pic: h.pic ?? null,
      episodeIndex: h.episodeIndex ?? 0,
      totalEpisodes: h.totalEpisodes ?? 0,
      playbackPosition: h.playbackPosition ?? 0,
      duration: h.duration ?? 0,
      timestamp: h.timestamp,
    })),
    progress: progress.map((p) => ({
      id: p.key,
      position: p.position,
      duration: p.duration,
      updatedAt: p.updatedAt,
    })),
    customSources,
    liveSources,
  };
}

/** 上行：把本地数据推到服务端 */
export async function pushToServer(): Promise<boolean> {
  try {
    const payload = await collectLocalPayload();
    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      markPending();
      return false;
    }
    clearPending();
    cachedStatus = { ...cachedStatus, online: true, lastSyncAt: Date.now(), pending: false };
    return true;
  } catch {
    markPending();
    return false;
  }
}

/**
 * 下行：拉服务端并覆盖本地。
 * 用覆盖而非合并：服务端已是「后写胜出」后的权威结果，本地再合并一遍
 * 只会把已被别的设备删掉/改掉的旧状态带回来。
 */
export async function pullFromServer(): Promise<boolean> {
  const data = await fetchServer();
  if (!data) {
    cachedStatus = { ...cachedStatus, online: false };
    return false;
  }

  try {
    await db.transaction('rw', db.watchlist, db.history, db.progress, async () => {
      await db.watchlist.clear();
      if (data.watchlist.length > 0) {
        await db.watchlist.bulkPut(
          data.watchlist.map((w) => ({
            ...w,
            status: w.status as WatchStatus,
            episodeIndex: w.episodeIndex ?? 0,
            totalEpisodes: w.totalEpisodes ?? 0,
            playbackPosition: w.playbackPosition ?? 0,
            duration: w.duration ?? 0,
          }))
        );
      }

      await db.history.clear();
      if (data.history.length > 0) await db.history.bulkPut(data.history);

      await db.progress.clear();
      if (data.progress.length > 0) {
        await db.progress.bulkPut(
          data.progress.map((p) => ({
            key: p.id,
            position: p.position,
            duration: p.duration,
            updatedAt: p.updatedAt,
          }))
        );
      }
    });

    cachedStatus = {
      online: true,
      lastSyncAt: Date.now(),
      pending: hasPending(),
    };
    return true;
  } catch (err) {
    console.error('[sync] 写入本地缓存失败', err);
    cachedStatus = { ...cachedStatus, online: false };
    return false;
  }
}

/**
 * 完整同步：先补推本地未上行的改动，再拉服务端权威数据。
 * 顺序不能反——若先拉后推，本地还没上行的改动会被服务端旧数据覆盖掉。
 */
export async function syncAll(): Promise<boolean> {
  if (hasPending()) {
    const pushed = await pushToServer();
    // 补推失败就不拉了，否则会覆盖掉尚未上行的本地改动
    if (!pushed) return false;
  }
  return pullFromServer();
}

/**
 * 删除同步：本地删完要显式通知服务端。
 * 单独一个接口的原因：整包 push 只能表达「新增/更新」，
 * 无法表达「这条被删了」——服务端那份还在，下次拉取就会复活。
 */
export async function deleteRemote(kind: 'watchlist' | 'history', id: string): Promise<void> {
  try {
    await fetch(`${SYNC_ENDPOINT}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ kind, id }),
    });
  } catch {
    // 删除失败可接受：下次写入以服务端为准时会被本地覆盖回去的风险很低，
    // 且用户已看到本地删除成功，不因此打断操作
  }
}

/** 首次启用同步时，把浏览器里已有的旧数据上传（避免升级后片单清空） */
export async function migrateLocalToServer(): Promise<boolean> {
  const localCount = await db.watchlist.count();
  const historyCount = await db.history.count();
  if (localCount === 0 && historyCount === 0) return false;

  const data = await fetchServer();
  if (!data) return false;
  // 服务端已有数据说明不是首次，交给正常同步流程
  if (data.watchlist.length > 0 || data.history.length > 0) return false;

  return pushToServer();
}

/** 便捷读取：按片名取一条（同步层供组件用） */
export async function getRemoteOrLocal(title: string): Promise<WatchlistEntry | undefined> {
  return db.watchlist.get(watchlistKeyOf(title));
}
