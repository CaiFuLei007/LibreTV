import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 跨源并发上限 / 整体死线 / 单页重试 的行为测试。
 *
 * 这三项都由模块级常量（启动时读环境变量）控制，所以每个用例用
 * vi.resetModules() + 动态 import 重建 route 模块，才能测到不同的配置。
 * 上游一律 mock，无真实网络。
 */

const ENV_KEYS = ['SEARCH_CONCURRENCY', 'SEARCH_TOTAL_TIMEOUT_MS', 'SEARCH_PAGE_RETRIES'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeRequest(body: unknown, stream = false): Request {
  const { token } = signSession();
  return new Request(`https://local.test/api/search${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify(body),
  });
}

function cmsBody(names: string[]): string {
  return JSON.stringify({
    code: 1,
    pagecount: 1,
    list: names.map((n, i) => ({ vod_id: i + 1, vod_name: n, type_name: '剧情片' })),
  });
}

/**
 * 用公网字面量 IP 构造源地址：checkUpstreamAllowed 对字面量 IP 不做 DNS 解析，
 * 避免 .example.com 这类不存在域名在测试里吃满 DNS 超时（实测单次 5s）。
 * 端口各不相同只为让 URL 互不重复。
 */
function sourcesOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    key: `s${i}`,
    name: `源${i}`,
    url: `https://93.184.216.34:${8000 + i}/api.php`,
  }));
}

/** 重建 route 模块（让新的环境变量生效） */
async function loadRoute() {
  vi.resetModules();
  return (await import('./route')) as typeof import('./route');
}

describe('跨源并发上限', () => {
  it('限制并发后同一时刻在途请求数不超过 SEARCH_CONCURRENCY', async () => {
    process.env.SEARCH_CONCURRENCY = '3';
    const route = await loadRoute();

    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return new Response(cmsBody(['测试片']), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(10) }));
    expect(res.status).toBe(200);
    expect(peak).toBeLessThanOrEqual(3);
    // 10 个源足够填满窗口，峰值应恰好等于上限
    expect(peak).toBe(3);
  });

  it('并发受限不影响结果完整性：每个源的结果都进最终列表', async () => {
    process.env.SEARCH_CONCURRENCY = '2';
    const route = await loadRoute();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        // 名字必须包含关键词，否则会被 filterRelevantResults 过滤掉；端口保证唯一
        const port = new URL(String(input)).port;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(cmsBody([`测试片${port}`]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(6) }));
    const data = (await res.json()) as { list: Array<{ name: string }>; failures: unknown[] };
    expect(data.failures).toHaveLength(0);
    expect(new Set(data.list.map((i) => i.name)).size).toBe(6);
  });

  it('流式模式同样受并发上限约束', async () => {
    process.env.SEARCH_CONCURRENCY = '2';
    const route = await loadRoute();

    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 12));
        inFlight -= 1;
        return new Response(cmsBody(['测试片']), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(8) }, true));
    const text = await res.text();
    expect(peak).toBeLessThanOrEqual(2);
    // 8 个源 + 1 个 done
    expect(text.trim().split('\n')).toHaveLength(9);
  });
});

describe('整体死线', () => {
  it('预算耗尽的排队源不再发起请求；预算不足的源被截短死线', async () => {
    process.env.SEARCH_CONCURRENCY = '1';
    process.env.SEARCH_TOTAL_TIMEOUT_MS = '5000'; // 下限，保证模块接受
    const route = await loadRoute();

    // 串行执行、预算 5s：
    //   s0 跑 4.2s 成功 → 剩 0.8s
    //   s1 死线被截到 0.8s，而 fetch 要 4.2s → 必然源超时，在 ~5.0s 交回
    //   s2 排到 5.0s 之后，剩余预算为负 → 不该发起 fetch
    // 用 4.2s 而不是刚好的 2.5s：贴近边界时 s1 可能在 4999ms 返回，
    // s2 会拿到 left=1ms 的极小死线照常启动，测试随机红。
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(new URL(String(input)).host);
        await new Promise((r) => setTimeout(r, 4200));
        return new Response(cmsBody(['慢源']), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(3) }));
    const data = (await res.json()) as { failures: Array<{ error: string; timedOut?: boolean }> };
    expect(calls).toHaveLength(2); // s2 未发起请求
    expect(data.failures).toHaveLength(2); // s1 源超时 + s2 整体超时
    expect(data.failures.some((f) => f.error.includes('整体搜索超时'))).toBe(true);
  }, 30000);

  it('整体死线正常时不影响源结果', async () => {
    process.env.SEARCH_TOTAL_TIMEOUT_MS = '5000';
    const route = await loadRoute();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(cmsBody(['测试片']), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(3) }));
    const data = (await res.json()) as { list: unknown[]; failures: unknown[] };
    expect(data.failures).toHaveLength(0);
    expect(data.list).toHaveLength(3);
  });
});

describe('单页重试', () => {
  it('首次超时后重试成功，结果正常返回', async () => {
    process.env.SEARCH_PAGE_RETRIES = '1';
    const route = await loadRoute();

    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          // 模拟首轮超时：抛出 AbortError 语义的错误
          throw new DOMException('超时', 'TimeoutError');
        }
        return new Response(cmsBody(['测试片']), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(1) }));
    const data = (await res.json()) as { list: unknown[]; failures: unknown[] };
    expect(attempt).toBe(2);
    expect(data.failures).toHaveLength(0);
    expect(data.list).toHaveLength(1);
  });

  it('重试次数用尽仍失败时记为失败源', async () => {
    process.env.SEARCH_PAGE_RETRIES = '2';
    const route = await loadRoute();

    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        throw new DOMException('超时', 'TimeoutError');
      })
    );

    const res = await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(1) }));
    const data = (await res.json()) as { failures: Array<{ timedOut?: boolean }> };
    expect(attempt).toBe(3); // 首轮 + 2 次重试
    expect(data.failures).toHaveLength(1);
  }, 20000);

  it('SEARCH_PAGE_RETRIES=0 时只打一次', async () => {
    process.env.SEARCH_PAGE_RETRIES = '0';
    const route = await loadRoute();

    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        throw new DOMException('超时', 'TimeoutError');
      })
    );

    await route.POST(makeRequest({ wd: '测试片', sources: sourcesOf(1) }));
    expect(attempt).toBe(1);
  });
});
