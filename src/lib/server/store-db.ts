import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 服务端持久化（SQLite，Node 22 内置 node:sqlite，无需额外依赖）。
 *
 * 为什么要有这一层：LibreTV 原本把收藏/历史/设置全放浏览器
 * （IndexedDB + localStorage），换设备就看不到。这里把同一份数据落到
 * 服务端文件库，前端改为「读服务端为主、本地缓存兜底」，多设备自然一致。
 *
 * 设计取舍：
 * - 单文件 + WAL：家庭自建场景并发很低，省掉独立数据库服务；
 * - 表结构按「业务对象」而非「前端存储细节」划分，前端换实现不用迁库；
 * - 时间戳统一毫秒，`updated_at` 用于跨设备冲突时取新者。
 */

/** 数据目录可由 DATA_DIR 覆盖（Docker 里指到挂载卷） */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const DB_FILE = path.join(DATA_DIR, 'libretv.db');

let db: DatabaseSync | null = null;

/** 懒初始化：首次访问时才建库，避免构建期（next build）就去写文件 */
export function getDb(): DatabaseSync {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);

  // WAL 提升并发读性能；synchronous=NORMAL 在断电下仍保证一致性
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    -- 收藏清单：主键是片名归一化结果，与视频源无关
    CREATE TABLE IF NOT EXISTS watchlist (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      pic              TEXT,
      type_name        TEXT,
      year             TEXT,
      area             TEXT,
      remarks          TEXT,
      status           TEXT NOT NULL,
      episode_index    INTEGER NOT NULL DEFAULT 0,
      total_episodes   INTEGER NOT NULL DEFAULT 0,
      playback_position REAL NOT NULL DEFAULT 0,
      duration         REAL NOT NULL DEFAULT 0,
      last_source_key  TEXT,
      last_source_url  TEXT,
      last_vod_id      TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist(status);
    CREATE INDEX IF NOT EXISTS idx_watchlist_updated ON watchlist(updated_at);

    -- 观看历史（播放足迹）：与收藏分开，进播放页就记，用于续播
    CREATE TABLE IF NOT EXISTS history (
      id                TEXT PRIMARY KEY,
      source_key        TEXT NOT NULL,
      source_url        TEXT,
      vod_id            TEXT NOT NULL,
      title             TEXT NOT NULL,
      pic               TEXT,
      episode_index     INTEGER NOT NULL DEFAULT 0,
      total_episodes    INTEGER NOT NULL DEFAULT 0,
      playback_position REAL NOT NULL DEFAULT 0,
      duration          REAL NOT NULL DEFAULT 0,
      timestamp         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp);

    -- 分集播放进度
    CREATE TABLE IF NOT EXISTS progress (
      id         TEXT PRIMARY KEY,
      position   REAL NOT NULL DEFAULT 0,
      duration   REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at);

    -- 用户添加的点播源（含订阅派生的）；服务端预置源仍走环境变量
    CREATE TABLE IF NOT EXISTS custom_sources (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      url        TEXT NOT NULL,
      detail     TEXT,
      is_adult   INTEGER NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- 用户添加/订阅的直播源
    CREATE TABLE IF NOT EXISTS live_sources (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      url        TEXT NOT NULL,
      epg        TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- 键值型杂项设置（偏好、选中的源 key、跳过标记等）
    CREATE TABLE IF NOT EXISTS settings (
      id         TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** 是否已配置服务端持久化目录可写（供健康检查） */
export function dataDirInfo(): { dir: string; file: string } {
  return { dir: DATA_DIR, file: DB_FILE };
}
