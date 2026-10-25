'use client';

import { api } from './client-api';
import { db, notifySync } from './db';
import { resolveSource, useAppStore } from './store';
import { watchlistKeyOf, type WatchlistEntry } from './watchlist';

/**
 * 追剧「新增集数」检测。
 *
 * 背景：收藏里存着 totalEpisodes（上次看到的总集数），但采集站会持续更新。
 * 定期比对一次最新集数，多出来的就是「新增 N 集」——这样用户不必自己
 * 记住每部剧更新到第几集了。
 *
 * 设计取舍：
 * - **只检查「在看」和「想看」**：已看/废弃的片子没有追更意义，白耗请求。
 * - **节流到 6 小时**：采集站不欢迎高频请求，集数也不会分钟级变化。
 * - **失败静默**：某个源挂了不该影响收藏列表展示，检查纯粹是锦上添花。
 * - 用 lastSourceKey 拉详情即可；那个源失效时就跳过，等下次换源播放后
 *   线索会更新，自然会重新生效。
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'libretv-episode-check-at';

/** 是否到了该检查的时间（节流判断，避免每次打开都狂拉详情） */
function shouldCheck(): boolean {
  try {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) || '0');
    return Date.now() - last > CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

function markChecked(): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* 忽略 */
  }
}

export interface EpisodeUpdate {
  title: string;
  /** 新增的集数 */
  added: number;
  /** 最新总集数 */
  latest: number;
}

/**
 * 检查所有追更中的收藏，给有更新的条目打上 hasNewEpisodes 标记。
 * 返回有更新的条目摘要，供界面提示用。
 */
export async function checkNewEpisodes(): Promise<EpisodeUpdate[]> {
  if (!shouldCheck()) return [];

  const store = useAppStore.getState();
  const rows = await db.watchlist.toArray();
  // 只追踪「在看」和「想看」：已看完不必再提醒，废弃的更是刻意放弃
  const tracking = rows.filter(
    (r) => (r.status === 'watching' || r.status === 'wish') && r.lastSourceKey && r.lastVodId
  );
  if (tracking.length === 0) {
    markChecked();
    return [];
  }

  const updates: EpisodeUpdate[] = [];

  for (const entry of tracking) {
    const source = resolveSource(store, entry.lastSourceKey!, {
      url: entry.lastSourceUrl,
    });
    if (!source) continue;

    try {
      const detail = await api.detail(entry.lastVodId!, source);
      const latest = detail.episodes.length;
      if (latest <= 0) continue;

      // 已知集数是基准；首轮没记录过就先用当前总集数当基准，不误报
      const known = entry.knownEpisodes > 0 ? entry.knownEpisodes : entry.totalEpisodes;
      if (known <= 0) {
        await db.watchlist.update(entry.id, { knownEpisodes: latest });
        continue;
      }

      if (latest > known) {
        await db.watchlist.update(entry.id, {
          hasNewEpisodes: true,
          totalEpisodes: latest,
          // 不动 knownEpisodes：红点要一直亮到用户真的点开看过
        } as Partial<WatchlistEntry>);
        notifySync('watchlist', entry.id);
        updates.push({ title: entry.title, added: latest - known, latest });
      }
    } catch {
      // 单个源失败不影响其他条目
    }
  }

  markChecked();
  return updates;
}

/**
 * 用户查看某条目后清除「新增」标记，并把已知集数推进到最新。
 * 在收藏列表点击条目时调用（那时用户确实要去看这部剧了）。
 */
export async function acknowledgeEpisodes(title: string): Promise<void> {
  const id = watchlistKeyOf(title);
  const entry = await db.watchlist.get(id);
  if (!entry || !entry.hasNewEpisodes) return;
  await db.watchlist.update(id, {
    hasNewEpisodes: false,
    knownEpisodes: entry.totalEpisodes,
  });
  notifySync('watchlist', id);
}
