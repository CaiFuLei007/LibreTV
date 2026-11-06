import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

/**
 * 有界并发工具单测：窗口上限、结果顺序、单个任务失败不拖累其余、
 * 瞬时并发峰值不越界（这是本模块存在的理由，必须被直接断言）。
 */

/** 记录调用过程中的瞬时并发峰值 */
function tracker() {
  let active = 0;
  let peak = 0;
  return {
    enter() {
      active += 1;
      peak = Math.max(peak, active);
    },
    leave() {
      active -= 1;
    },
    get peak() {
      return peak;
    },
  };
}

/** 让出若干次宏任务，模拟真实异步耗时 */
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('返回结果顺序与输入一致（即使完成顺序相反）', async () => {
    const items = [30, 20, 10];
    const out = await mapWithConcurrency(items, 3, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 20, 10]);
  });

  it('并发峰值不超过 limit', async () => {
    const t = tracker();
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      t.enter();
      await tick(3);
      t.leave();
      return 1;
    });
    expect(t.peak).toBeLessThanOrEqual(4);
    expect(t.peak).toBe(4); // 20 个任务足够填满窗口，峰值应恰好等于 limit
  });

  it('limit 大于任务数时退化为全并发，峰值等于任务数', async () => {
    const t = tracker();
    await mapWithConcurrency([1, 2, 3], 10, async (n) => {
      t.enter();
      await tick(2);
      t.leave();
      return n;
    });
    expect(t.peak).toBe(3);
  });

  it('单个任务抛错只标记该项 rejected，其余照常完成', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(out[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(out[1].status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 30 });
  });

  it('空输入返回空数组，不调用 worker', async () => {
    let called = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      called += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it('非法 limit（0 / 负数 / NaN / 小数）至少按 1 串行执行', async () => {
    for (const bad of [0, -3, Number.NaN, 0.4]) {
      const t = tracker();
      const out = await mapWithConcurrency([1, 2, 3], bad, async (n) => {
        t.enter();
        await tick(1);
        t.leave();
        return n;
      });
      expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(t.peak).toBe(1);
    }
  });

  it('worker 收到正确的下标', async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => {
      seen.push([item, i]);
      return item;
    });
    expect(seen.sort((x, y) => x[1] - y[1])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('慢任务不阻塞后续任务补位（滑动窗口而非分批）', async () => {
    const order: number[] = [];
    // 第 0 个任务最慢；若是分批执行，1/2 必须等 0 完成才会开始
    await mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
      await tick(n === 0 ? 40 : 1);
      order.push(n);
      return n;
    });
    // 1 和 2 必须在 0 之前完成 —— 证明没有分批等待
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(0));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(0));
  });
});
