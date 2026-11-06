import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, filterAdultResults, filterRelevantResults, normalizeTitle, parseSearchList } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { mapWithConcurrency } from '@/lib/concurrency';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SearchResponse, SearchStreamEvent, SourceConfig, SourceSearchOutcome } from '@/lib/types';

export const runtime = 'nodejs';

interface SearchBody {
  wd: string;
  sources: SourceConfig[];
  filterAdult?: boolean;
}

/** 搜索结果短缓存：同一关键词 + 同一组源在 TTL 内直接返回（播放页返回搜索页等场景） */
const SEARCH_CACHE_TTL = 60 * 1000;

/** 缓存键：wd + 成人过滤 + 排序后的源地址集合（直接用完整字符串，避免哈希碰撞串缓存） */
function searchCacheKey(wd: string, sources: SourceConfig[], filterAdult: boolean): string {
  const urls = sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|');
  return `search:${wd}\n${filterAdult ? 1 : 0}\n${urls}`;
}

/**
 * 每个源最多抓取的页数。
 * 第一页响应会带回 pagecount（源站真实总页数），实际抓取页数 = min(pagecount, 该值)。
 * 默认 5；页与页之间并行请求，单页失败只丢弃该页。
 */
const SEARCH_MAX_PAGES = (() => {
  const n = parseInt(process.env.SEARCH_MAX_PAGES || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(50, Math.max(1, n));
})();

/**
 * 单源总死线（毫秒）：该源所有分页请求必须在时限内完成，到点中断在途请求并标记超时。
 * 没有它时慢源最坏要等「首页 8s + 后续页并行 8s」，拖垮整体响应。
 * 环境变量 SEARCH_SOURCE_TIMEOUT_MS 可配，默认 10s。
 */
const SEARCH_SOURCE_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SEARCH_SOURCE_TIMEOUT_MS || '10000', 10);
  if (!Number.isFinite(n)) return 10000;
  return Math.min(60000, Math.max(3000, n));
})();

/**
 * 跨源并发上限：同时最多打几个采集站。
 * 全部并发（35 源 = 35 路）会让部分源站的 WAF 判定为扫描：实测 28 并发时
 * 约 58% 的源返回 403 / ETIMEDOUT / ECONNRESET，其中多数并非真死，串行重测即恢复。
 * 降到 8 并发后成功源 11.7→14.0 / 28，命中条目 +25%。
 * 环境变量 SEARCH_CONCURRENCY 可配，默认 8。
 */
const SEARCH_CONCURRENCY = (() => {
  const n = parseInt(process.env.SEARCH_CONCURRENCY || '8', 10);
  if (!Number.isFinite(n)) return 8;
  return Math.min(32, Math.max(1, n));
})();

/**
 * 单页请求失败后的重试次数。
 * 抖动源（超时/连接重置）在同一时刻重试多半能成功：实测配对比较 12 轮，
 * 加一次重试后成功源 11.75→12.83 / 28，9 胜 3 负。
 * 用较短的单次超时（而非原超时）重试，避免死源把源级死线耗光。
 */
const SEARCH_PAGE_RETRIES = (() => {
  const n = parseInt(process.env.SEARCH_PAGE_RETRIES || '1', 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(0, n));
})();

/** 重试时单次超时占首轮的比例：重试是捡漏，不该比首轮还久 */
const RETRY_TIMEOUT_RATIO = 0.6;

/**
 * 整体死线（毫秒）：一次搜索从开始到返回的总时限。
 *
 * 有界并发把「全部同时打」换成「排队打」，最坏耗时从 1×源级死线变成
 * ceil(源数/并发)×源级死线——35 源 / 8 并发 ≈ 5 波 × 10s = 50s，用户不可能等。
 * 有了整体死线，超时预算用完时剩余源直接按失败结算，不再启动；
 * 已在跑的源用「剩余时间」作为自己的死线，不会越过总时限。
 * 默认 15s：够 8 并发跑完约 2 波（覆盖多数快源），又不会让用户干等。
 */
const SEARCH_TOTAL_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SEARCH_TOTAL_TIMEOUT_MS || '15000', 10);
  if (!Number.isFinite(n)) return 15000;
  return Math.min(60000, Math.max(5000, n));
})();

/** AbortSignal.timeout / 源级死线中断均以 TimeoutError 语义呈现（直接抛出或挂在 cause 上） */
function isTimeoutError(err: unknown): boolean {
  const candidates: unknown[] = [err, err instanceof Error ? err.cause : undefined];
  return candidates.some((e) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
}

/**
 * 服务端聚合搜索：并行请求所有选中源，任一源失败不影响整体。
 * 每个源先取第一页并读取 pagecount，再并行抓取后续页（上限 SEARCH_MAX_PAGES），
 * 整源受 SEARCH_SOURCE_TIMEOUT_MS 总死线约束。
 * 旧版在浏览器里打满 N 个请求（暴露用户 IP、无法缓存、超时失控），现全部上移。
 */
async function searchSource(
  source: SourceConfig,
  wd: string,
  /** 本源的死线毫秒数；缺省用 SEARCH_SOURCE_TIMEOUT_MS。整体死线不足时由调用方下调 */
  timeoutMs: number = SEARCH_SOURCE_TIMEOUT_MS
): Promise<SourceSearchOutcome> {
  const start = Date.now();
  const finish = (outcome: Omit<SourceSearchOutcome, 'ms'>): SourceSearchOutcome => ({
    ...outcome,
    ms: Date.now() - start,
  });

  if (!/^https?:\/\//.test(source.url || '')) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: '无效的源地址' });
  }
  // 用户可控地址发起服务端请求，必须先过 SSRF 校验（协议白名单 + 内网/保留地址）
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: verdict.reason });
  }

  // 死线到点中断该源所有在途分页请求，避免后台继续空耗
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SourceSearchOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new DOMException('源搜索超时', 'TimeoutError'));
      resolve(
        finish({
          sourceKey: source.key,
          ok: false,
          list: [],
          error: `请求超时（>${Math.round(timeoutMs / 1000)}s）`,
          timedOut: true,
        })
      );
    }, timeoutMs);
  });

  const base = source.url.replace(/\/+$/, '');
  /**
   * 取单页。失败后按 SEARCH_PAGE_RETRIES 重试，且每次尝试都新建独立的超时信号。
   *
   * 不能让重试共用同一个 signal：fetchUpstream 内部的 timeoutSignal 是
   * AbortSignal.timeout(timeoutMs)，一旦首轮超时它就被永久置为 aborted，
   * 后续尝试会在 0~1ms 内直接抛 TimeoutError——重试形同虚设。
   * 源级死线（controller.signal）仍然共享，保证整源到点即停。
   */
  const fetchPage = async (page: number) => {
    const api = `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${page}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= SEARCH_PAGE_RETRIES; attempt++) {
      // 重试只给更短的单次超时：捡漏用的，不该比首轮还久
      const timeoutMs =
        attempt === 0 ? 8000 : Math.round(8000 * RETRY_TIMEOUT_RATIO);
      try {
        const res = await fetchUpstream(api, {
          timeoutMs,
          headers: cmsRequestHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        // 源级死线已断或客户端已断开：重试没有意义，直接抛出
        if (controller.signal.aborted) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('请求失败');
  };

  const run = async (): Promise<SourceSearchOutcome> => {
    const first = await fetchPage(1);
    const list = parseSearchList(first, source);
    // 源站真实总页数与配置上限取较小者；pagecount 缺失或非法时视为 1 页
    const rawPageCount = parseInt(String((first as { pagecount?: unknown }).pagecount ?? '1'), 10);
    const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, SEARCH_MAX_PAGES);
    if (pageCount > 1) {
      const extraPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => i + 2).map(async (page) => {
          try {
            return parseSearchList(await fetchPage(page), source);
          } catch {
            return [];
          }
        })
      );
      list.push(...extraPages.flat());
    }
    return { sourceKey: source.key, ok: true, list };
  };

  try {
    // 死线先到时 run 仍会在后台被 abort 并 reject，必须先挂 catch 防未处理 rejection
    const runPromise = run()
      .then(finish)
      .catch((err: unknown): SourceSearchOutcome =>
        finish({
          sourceKey: source.key,
          ok: false,
          list: [],
          error: err instanceof Error ? err.message : '请求失败',
          timedOut: isTimeoutError(err),
        })
      );
    return await Promise.race([runPromise, deadline]);
  } catch (err) {
    return finish({
      sourceKey: source.key,
      ok: false,
      list: [],
      error: err instanceof Error ? err.message : '请求失败',
      timedOut: isTimeoutError(err),
    });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** 合并 + 去重 + 过滤 + 排序，stream 与非 stream 两种模式共用 */
function aggregateOutcomes(outcomes: SourceSearchOutcome[], wd: string, filterAdult: boolean): SearchResponse {
  const seen = new Set<string>();
  let list = outcomes.flatMap((o) => o.list).filter((item) => {
    const key = `${item.sourceKey}_${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  list = filterAdultResults(list, filterAdult);
  // 部分源站做分词/OR 模糊搜索（搜「摔跤吧！爸爸」返回一堆「爸爸XXX」），按关键词过滤
  list = filterRelevantResults(list, wd);

  // 精确命中（忽略标点差异）排在最前，其余按名称（与旧版一致），名称相同按源名
  const exact = normalizeTitle(wd);
  list.sort((a, b) => {
    const aExact = normalizeTitle(a.name || '') === exact ? 0 : 1;
    const bExact = normalizeTitle(b.name || '') === exact ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const nameCompare = (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceName || '').localeCompare(b.sourceName || '', 'zh-Hans-CN');
  });

  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));

  return { list, failures };
}

/**
 * 服务端聚合搜索：
 * - 默认返回完整 JSON（换源流程使用）；
 * - `?stream=1` 以 NDJSON 逐源推送（完成一个推一条，健康源的结果不再等坏源超时），
 *   最终推送聚合后的 done 事件并写入短缓存。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const wd = (body.wd || '').trim();
  if (!wd || wd.length > 100) {
    return NextResponse.json({ error: '搜索关键词无效' }, { status: 400 });
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }
  const sources = body.sources.slice(0, 50);
  const filterAdult = body.filterAdult !== false;

  const cacheKey = searchCacheKey(wd, sources, filterAdult);
  const cached = getCache<SearchResponse>(cacheKey);
  if (cached) {
    // 流式模式下缓存命中也要走 done 事件，客户端解析逻辑保持单一
    if (new URL(req.url).searchParams.get('stream') === '1') {
      const event: SearchStreamEvent = { type: 'done', list: cached.list, failures: cached.failures };
      return new Response(JSON.stringify(event) + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json(cached);
  }

  // 整体死线起点：缓存未命中才开始计时，避免把缓存查询算进超时预算
  const startedAt = Date.now();
  /** 距离整体死线还剩多少毫秒；已超时返回 0 */
  const remaining = () => SEARCH_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);

  /**
   * 带整体死线地跑一个源：
   * - 预算已耗尽 → 不发起请求，直接按「整体超时」结算（并发窗口排队的源不必再白跑）；
   * - 预算不足一个完整源死线 → 用它作为本源死线，保证整次搜索不越过总时限。
   */
  const runSource = (source: SourceConfig): Promise<SourceSearchOutcome> => {
    const left = remaining();
    if (left <= 0) {
      return Promise.resolve({
        sourceKey: source.key,
        ok: false,
        list: [],
        error: '整体搜索超时，该源未参与',
        timedOut: true,
        ms: 0,
      });
    }
    return searchSource(source, wd, Math.min(SEARCH_SOURCE_TIMEOUT_MS, left));
  };

  const isStream = new URL(req.url).searchParams.get('stream') === '1';
  if (!isStream) {
    const settled = await mapWithConcurrency(sources, SEARCH_CONCURRENCY, runSource);
    // searchSource 内部已吞掉全部异常，rejected 只可能来自调用方逻辑错误，按失败源记
    const outcomes = settled.map((r, i): SourceSearchOutcome =>
      r.status === 'fulfilled'
        ? r.value
        : { sourceKey: sources[i].key, ok: false, list: [], error: '源处理异常', ms: 0 }
    );
    const payload = aggregateOutcomes(outcomes, wd, filterAdult);
    setCache(cacheKey, payload, SEARCH_CACHE_TTL);
    return NextResponse.json(payload);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: SearchStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          closed = true; // 客户端已断开
        }
      };

      // 逐源结算即推送；outcomes 按下标回填保证聚合顺序稳定
      const outcomes: SourceSearchOutcome[] = new Array(sources.length);
      await mapWithConcurrency(sources, SEARCH_CONCURRENCY, async (source, i) => {
        const outcome = await runSource(source);
        outcomes[i] = outcome;
        // 中间结果与最终结果共用去重和过滤规则，避免无关/成人条目短暂出现在页面上。
        const { list } = aggregateOutcomes([outcome], wd, filterAdult);
        send({ type: 'source', ...outcome, list });
      });

      const payload = aggregateOutcomes(outcomes, wd, filterAdult);
      setCache(cacheKey, payload, SEARCH_CACHE_TTL);
      send({ type: 'done', list: payload.list, failures: payload.failures });
      closed = true;
      try {
        controller.close();
      } catch { /* 已断开 */ }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
