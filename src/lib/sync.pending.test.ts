import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * 同步「待补推」标记的回归测试。
 *
 * 这次修的是一个真实丢数据缺陷：上行是 1.2s 防抖的，
 * 用户点完收藏立刻离开页面时定时器被取消，改动只落在 IndexedDB，
 * 既没上行也没留痕迹；下次进入页面 syncAll() 先拉服务端覆盖本地 → 收藏消失。
 *
 * 修法：入队那一刻就置 PENDING_FLAG，pushToServer 成功时清除。
 * 这里只测标记的持久化语义（纯 localStorage，不依赖网络）。
 */

const PENDING_FLAG = 'libretv-sync-pending';

// localStorage 桩：Node 环境没有，按需最小实现
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

describe('同步待补推标记', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: MemoryStorage }).localStorage;
  });

  it('markSyncPending 写入标记，下次同步能读到「有未上行改动」', async () => {
    const sync = await import('./sync');
    expect(globalThis.localStorage.getItem(PENDING_FLAG)).toBeNull();
    sync.markSyncPending();
    expect(globalThis.localStorage.getItem(PENDING_FLAG)).toBe('1');
    expect(sync.getSyncStatus().pending).toBe(true);
  });

  it('标记可跨「页面重载」存活（localStorage 而非内存）', async () => {
    const sync1 = await import('./sync');
    sync1.markSyncPending();

    // 模拟重载：模块重新求值，同名全局 localStorage 仍在
    vi.resetModules();
    const sync2 = await import('./sync');
    expect(globalThis.localStorage.getItem(PENDING_FLAG)).toBe('1');
    // 新实例的内存态也是 false，标记只能从 localStorage 读出来——这正是它存在的意义
    expect(sync2.getSyncStatus().pending).toBe(false);
    expect(JSON.parse(JSON.stringify(localStorage.getItem(PENDING_FLAG)))).toBe('1');
  });

  it('localStorage 不可写时不抛错（隐私模式兜底）', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    (globalThis as unknown as { localStorage: unknown }).localStorage = throwing;
    const sync = await import('./sync');
    expect(() => sync.markSyncPending()).not.toThrow();
  });
});
