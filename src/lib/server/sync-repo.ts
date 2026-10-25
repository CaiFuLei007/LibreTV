import { getDb } from './store-db';

/**
 * 同步仓库层：把前端的数据结构翻译成 SQL。
 * 单独成文件的原因：API 路由只做「鉴权 + 解析请求」，SQL 细节不该散在路由里，
 * 也方便将来换库（例如换 Postgres）时只改这一层。
 */

export interface SyncWatchlist {
  id: string;
  title: string;
  pic?: string | null;
  typeName?: string | null;
  year?: string | null;
  area?: string | null;
  remarks?: string | null;
  status: string;
  episodeIndex?: number;
  totalEpisodes?: number;
  playbackPosition?: number;
  duration?: number;
  knownEpisodes?: number;
  hasNewEpisodes?: boolean | number;
  lastSourceKey?: string | null;
  lastSourceUrl?: string | null;
  lastVodId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SyncHistory {
  id: string;
  sourceKey: string;
  sourceUrl?: string | null;
  vodId: string;
  title: string;
  pic?: string | null;
  episodeIndex?: number;
  totalEpisodes?: number;
  playbackPosition?: number;
  duration?: number;
  timestamp: number;
}

export interface SyncProgress {
  id: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface SyncSource {
  id: string;
  name: string;
  url: string;
  detail?: string | null;
  isAdult?: boolean;
  epg?: string | null;
}

export interface SyncPayload {
  watchlist?: SyncWatchlist[];
  history?: SyncHistory[];
  progress?: SyncProgress[];
  customSources?: SyncSource[];
  liveSources?: SyncSource[];
  settings?: Record<string, unknown>;
}

/** 全量读取（首次打开页面时拉一次） */
export function readAll() {
  const db = getDb();

  const watchlist = db
    .prepare(
      `SELECT id, title, pic, type_name AS typeName, year, area, remarks, status,
              episode_index AS episodeIndex, total_episodes AS totalEpisodes,
              playback_position AS playbackPosition, duration,
              known_episodes AS knownEpisodes, has_new_episodes AS hasNewEpisodes,
              last_source_key AS lastSourceKey, last_source_url AS lastSourceUrl,
              last_vod_id AS lastVodId, created_at AS createdAt, updated_at AS updatedAt
       FROM watchlist ORDER BY updated_at DESC`
    )
    .all();

  const history = db
    .prepare(
      `SELECT id, source_key AS sourceKey, source_url AS sourceUrl, vod_id AS vodId,
              title, pic, episode_index AS episodeIndex, total_episodes AS totalEpisodes,
              playback_position AS playbackPosition, duration, timestamp
       FROM history ORDER BY timestamp DESC LIMIT 500`
    )
    .all();

  const progress = db
    .prepare(`SELECT id, position, duration, updated_at AS updatedAt FROM progress`)
    .all();

  // SQLite 没有布尔类型，统一在出口转成 true/false，前端拿到的形状才稳定
  const watchlistNormalized = (watchlist as Record<string, unknown>[]).map((row) => ({
    ...row,
    hasNewEpisodes: Boolean(row.hasNewEpisodes),
  }));

  const customRows = db
    .prepare(
      `SELECT id, name, url, detail, is_adult AS isAdult
       FROM custom_sources ORDER BY position`
    )
    .all() as Record<string, unknown>[];
  const customSources = customRows.map((row) => ({ ...row, isAdult: Boolean(row.isAdult) }));

  const liveSources = db
    .prepare(`SELECT id, name, url, epg FROM live_sources ORDER BY position`)
    .all();

  const settings: Record<string, unknown> = {};
  const settingRows = db.prepare(`SELECT id, value FROM settings`).all() as {
    id: string;
    value: string;
  }[];
  for (const row of settingRows) {
    try {
      settings[row.id] = JSON.parse(row.value);
    } catch {
      /* 损坏的单项忽略，不影响其余设置 */
    }
  }

  return {
    watchlist: watchlistNormalized,
    history,
    progress,
    customSources,
    liveSources,
    settings,
  };
}

/**
 * 写入（增量合并）。
 * 冲突策略：同主键时 **updatedAt 更新的胜出**——两台设备先后改动时，
 * 后改的生效；这与「以最后一次操作为准」的直觉一致，也避免旧设备
 * 打开页面就把新改动覆盖回去。
 */
export function writeAll(payload: SyncPayload): void {
  const db = getDb();

  db.exec('BEGIN');
  try {
    for (const item of payload.watchlist ?? []) {
      if (!item.id || !item.title || !item.status) continue;
      db.prepare(
        `INSERT INTO watchlist (
           id, title, pic, type_name, year, area, remarks, status,
           episode_index, total_episodes, playback_position, duration,
           known_episodes, has_new_episodes,
           last_source_key, last_source_url, last_vod_id, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, pic=excluded.pic, type_name=excluded.type_name,
           year=excluded.year, area=excluded.area, remarks=excluded.remarks,
           status=excluded.status, episode_index=excluded.episode_index,
           total_episodes=excluded.total_episodes,
           playback_position=excluded.playback_position, duration=excluded.duration,
           known_episodes=excluded.known_episodes,
           has_new_episodes=excluded.has_new_episodes,
           last_source_key=excluded.last_source_key, last_source_url=excluded.last_source_url,
           last_vod_id=excluded.last_vod_id, updated_at=excluded.updated_at
         WHERE excluded.updated_at >= watchlist.updated_at`
      ).run(
        item.id, item.title, item.pic ?? null, item.typeName ?? null, item.year ?? null,
        item.area ?? null, item.remarks ?? null, item.status,
        item.episodeIndex ?? 0, item.totalEpisodes ?? 0,
        item.playbackPosition ?? 0, item.duration ?? 0,
        item.knownEpisodes ?? 0, item.hasNewEpisodes ? 1 : 0,
        item.lastSourceKey ?? null, item.lastSourceUrl ?? null, item.lastVodId ?? null,
        item.createdAt ?? Date.now(), item.updatedAt ?? Date.now()
      );
    }

    for (const item of payload.history ?? []) {
      if (!item.id || !item.sourceKey || !item.vodId || !item.title) continue;
      db.prepare(
        `INSERT INTO history (
           id, source_key, source_url, vod_id, title, pic,
           episode_index, total_episodes, playback_position, duration, timestamp
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, pic=excluded.pic,
           episode_index=excluded.episode_index,
           total_episodes=excluded.total_episodes,
           playback_position=excluded.playback_position,
           duration=excluded.duration, timestamp=excluded.timestamp
         WHERE excluded.timestamp >= history.timestamp`
      ).run(
        item.id, item.sourceKey, item.sourceUrl ?? null, item.vodId, item.title,
        item.pic ?? null, item.episodeIndex ?? 0, item.totalEpisodes ?? 0,
        item.playbackPosition ?? 0, item.duration ?? 0, item.timestamp ?? Date.now()
      );
    }

    // 历史表上限对齐本地 MAX_HISTORY：只留最近 100 条。
    // 不做这个淘汰，服务端会无限增长（本地有淘汰、服务端没有，长期跑会失控）。
    const HISTORY_CAP = 100;
    db.prepare(
      `DELETE FROM history WHERE id NOT IN (
         SELECT id FROM history ORDER BY timestamp DESC LIMIT ?
       )`
    ).run(HISTORY_CAP);

    for (const item of payload.progress ?? []) {
      if (!item.id) continue;
      db.prepare(
        `INSERT INTO progress (id, position, duration, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           position=excluded.position, duration=excluded.duration,
           updated_at=excluded.updated_at
         WHERE excluded.updated_at >= progress.updated_at`
      ).run(item.id, item.position ?? 0, item.duration ?? 0, item.updatedAt ?? Date.now());
    }

    for (const item of payload.customSources ?? []) {
      if (!item.id || !item.url) continue;
      db.prepare(
        `INSERT INTO custom_sources (id, name, url, detail, is_adult, position, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, url=excluded.url, detail=excluded.detail,
           is_adult=excluded.is_adult, position=excluded.position,
           updated_at=excluded.updated_at`
      ).run(
        item.id, item.name || item.url, item.url, item.detail ?? null,
        item.isAdult ? 1 : 0, 0, Date.now()
      );
    }

    for (const item of payload.liveSources ?? []) {
      if (!item.id || !item.url) continue;
      db.prepare(
        `INSERT INTO live_sources (id, name, url, epg, position, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, url=excluded.url, epg=excluded.epg,
           position=excluded.position, updated_at=excluded.updated_at`
      ).run(item.id, item.name || item.url, item.url, item.epg ?? null, 0, Date.now());
    }

    const now = Date.now();
    for (const [settingKey, settingValue] of Object.entries(payload.settings ?? {})) {
      db.prepare(
        `INSERT INTO settings (id, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).run(settingKey, JSON.stringify(settingValue), now);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 删除单个收藏（列表里删除要走服务端，否则下次同步又回来） */
export function deleteWatchlist(id: string): void {
  getDb().prepare(`DELETE FROM watchlist WHERE id = ?`).run(id);
}

export function deleteHistory(id: string): void {
  getDb().prepare(`DELETE FROM history WHERE id = ?`).run(id);
}

export function clearHistory(): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM history');
    db.exec('DELETE FROM progress');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
