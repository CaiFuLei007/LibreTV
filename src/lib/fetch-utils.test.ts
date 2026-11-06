import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpstream } from './fetch-utils';

/**
 * 安全跳转测试：mock 全局 fetch，验证 302 跳转到内网地址会被拒绝，
 * 跳转到公网地址则正常跟随。使用字面量公网 IP 避免 DNS 依赖。
 */

const PUBLIC_URL = 'https://93.184.216.34/a';

function mockFetch(handlers: Array<(url: string) => Response>) {
  const fn = vi.fn((url: string | URL) => {
    const handler = handlers.shift();
    if (!handler) throw new Error('意外的额外请求: ' + url);
    return Promise.resolve(handler(String(url)));
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUpstream 安全跳转', () => {
  it('302 跳转到内网地址时拒绝，且不发起第二跳请求', async () => {
    const spy = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } }),
    ]);
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy.mock.calls.length).toBe(1); // 预检在请求前拦截，内网地址未实际请求
  });

  it('302 跳转到公网地址时正常跟随并返回最终响应', async () => {
    mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/b' } }),
      () => new Response('ok', { status: 200 }),
    ]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('无跳转时直接返回响应', async () => {
    const spy = mockFetch([() => new Response('direct', { status: 200 })]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(await res.text()).toBe('direct');
    expect(spy.mock.calls.length).toBe(1);
  });

  it('重定向超过上限时抛错', async () => {
    mockFetch(Array.from({ length: 10 }, () => (url: string) =>
      new Response(null, { status: 302, headers: { location: url } })
    ));
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/重定向次数过多/);
  });
});

describe('fetchUpstream 重试', () => {
  it('每次重试都使用新的超时信号（首轮超时后仍会真的重发请求）', async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new DOMException('超时', 'TimeoutError');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fn);

    const res = await fetchUpstream(PUBLIC_URL, { retries: 2 });
    expect(await res.text()).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('外部 signal 已触发时不在重试上浪费预算', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        throw new DOMException('已取消', 'AbortError');
      })
    );

    await expect(
      fetchUpstream(PUBLIC_URL, { retries: 3, signal: controller.signal })
    ).rejects.toThrow();
    expect(attempt).toBe(1); // 外部叫停后不再重试
  });

  it('retries=0 时只发一次请求', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        throw new DOMException('超时', 'TimeoutError');
      })
    );
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow();
    expect(attempt).toBe(1);
  });
});
