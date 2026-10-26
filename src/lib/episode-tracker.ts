'use client';

import { api } from './client-api';
import { db, notifySync } from './db';
import { resolveSource, useAppStore } from './store';
import { watchlistKeyOf, type WatchlistEntry } from './watchlist';

/**
 * 追剧「新增集数」检测。
 *
 * 背景：收藏里存着 knownEpisodes（用户已知的集数），但采集站会持续更新。
 * 定期比对一次最新集数，多出来的就是「新增 N 集」——这样用户不必自己
 * 记住每部剧更新到第几集了。
 *
 * 设计取舍：
 * - **只检查「在看」和「想看」**：已看/废弃的片子没有追更意义，白耗请求。
 * - **节流到 6 小时**：采集站不欢迎高频请求，集数也不会分钟级变化。
 * - **失败静默**：某个源挂了不该影响收藏列表展示，检查纯粹是锦上添花。
 * - 用 lastSourceKey 拉详情即可；那个源失效时就跳过，等下次换源播放后
 *   线索会更新，自然会重新生效。
 * - **跨源不比较**：knownEpisodes 的基准绑定在同一源上（换源时由
 *   watchlist.ts 清零重建），否则 A 源 10 集、B 源 20 集会误报「新增 10 集」。
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'libretv-episode-check-at';

/**
 * 同时进行的详情请求数。
 * 串行时 50 部「在看」×300ms ≈ 15 秒，虽不阻塞界面但白占带宽；
 * 也不宜太大——采集站普遍对突发并发敏感，3 是保守值。
 */
const CONCURRENCY = 3;

/** 解析结果的合理上限，超过基本是备注里的无关数字被误读（年份、清晰度等） */
const MAX_PLAUSIBLE_EPISODES = 2000;

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

/**
 * 从采集站的 vod_remarks 里解析集数。
 *
 * 为什么不直接数播放地址：vod_play_url 里常混进预告、花絮，长度会虚高；
 * 有的源更新时整体重建地址列表但总数不变，又会漏报。而 remarks 是站点
 * 自己写的「更新至第 12 集」，正是最权威的那句话。
 *
 * 只在格式明确时返回数字，认不出来就返回 0 让调用方回落到地址数量——
 * 宁可不判，也不要拿「HD 国语」「第 2 季」里的数字当集数。
 */
export function parseEpisodeCount(remarks?: string): number {
  if (!remarks) return 0;
  const text = remarks.replace(/\s+/g, '');

  // 「更新至第12集」「更新到12话」「已更新至12期」「连载至第12回」
  let m = text.match(/(?:更新至|更新到|已更新至|连载至|连载到)第?(\d+)[集话期回]/);
  if (m) return clampEpisodes(Number(m[1]));

  // 「全24集」「共24集」「全集24集」
  m = text.match(/(?:全|共)集?(\d+)[集话期回]/);
  if (m) return clampEpisodes(Number(m[1]));

  // 整段就是「24集」「第24集」这种纯集数标注
  m = text.match(/^第?(\d+)[集话期回]?$/);
  if (m) return clampEpisodes(Number(m[1]));

  return 0;
}

function clampEpisodes(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > MAX_PLAUSIBLE_EPISODES ? 0 : Math.floor(n);
}

export interface EpisodeUpdate {
  title: string;
  /** 新增的集数 */
  added: number;
  /** 最新总集数 */
  latest: number;
}

/** 并发受限地遍历，结果与输入同序 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
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

  const perEntry = await mapWithConcurrency(tracking, CONCURRENCY, async (entry) => {
    const source = resolveSource(store, entry.lastSourceKey!, {
      url: entry.lastSourceUrl,
    });
    if (!source) return null;

    try {
      const detail = await api.detail(entry.lastVodId!, source);
      // 备注里认得出集数就用它，认不出才回落到数播放地址
      const latest = parseEpisodeCount(detail.videoInfo?.remarks) || detail.episodes.length;
      if (latest <= 0) return null;

      // knownEpisodes 是唯一基准：0 表示「还没在当前源上建立基线」。
      // 不回落到 totalEpisodes——换源时 totalEpisodes 可能还是旧源的口径，
      // 拿它比对会把「B 源比 A 源多几集」误判成更新。
      const known = entry.knownEpisodes;
      if (known <= 0) {
        await db.watchlist.update(entry.id, {
          knownEpisodes: latest,
          totalEpisodes: latest,
        });
        return null;
      }

      if (latest > known) {
        await db.watchlist.update(entry.id, {
          hasNewEpisodes: true,
          totalEpisodes: latest,
          // 不动 knownEpisodes：红点要一直亮到用户真的点开看过
        } as Partial<WatchlistEntry>);
        notifySync('watchlist', entry.id);
        return { title: entry.title, added: latest - known, latest } satisfies EpisodeUpdate;
      }
      return null;
    } catch {
      // 单个源失败不影响其他条目
      return null;
    }
  });

  markChecked();
  return perEntry.filter((u): u is EpisodeUpdate => u !== null);
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
