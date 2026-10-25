'use client';

import { PERSIST_KEY } from './persist-storage';

/**
 * 设置与视频源的跨设备同步。
 *
 * 为什么不走 sync.ts 的逐表同步：视频源、勾选状态、偏好这些都躺在
 * zustand persist 的一份 JSON 快照里（localStorage 的 libretv-settings），
 * 拆开逐字段同步等于把 store 的形状复制到服务端，改动面大且极易漏字段。
 * 这里直接把快照整体当成一个「设置文档」存取——形态稳定、加字段零成本。
 *
 * 冲突策略：以服务端最后一次写入为准。设置类数据没有并发编辑的强需求
 * （同一时刻基本只有一台设备在改），整体覆盖比字段级合并更可预期。
 */

const SETTINGS_ENDPOINT = '/api/sync';

/** 取本地设置快照（未初始化时返回 null） */
function readLocalSnapshot(): string | null {
  try {
    return localStorage.getItem(PERSIST_KEY);
  } catch {
    return null;
  }
}

/** 判断快照里是否含有用户数据（空快照不该覆盖服务端） */
function snapshotHasContent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const state = parsed.state ?? {};
    const custom = Array.isArray(state.customAPIs) ? state.customAPIs.length : 0;
    const subs = Array.isArray(state.subscriptions) ? state.subscriptions.length : 0;
    const liveSubs = Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions.length : 0;
    const selected = Array.isArray(state.selectedKeys) ? state.selectedKeys.length : 0;
    return custom > 0 || subs > 0 || liveSubs > 0 || selected > 0;
  } catch {
    return false;
  }
}

/** 推送本地设置快照到服务端 */
export async function pushSettings(): Promise<boolean> {
  const raw = readLocalSnapshot();
  // 空快照不上行：否则新设备一打开就把服务端的源配置清空
  if (!snapshotHasContent(raw)) return false;
  try {
    const res = await fetch(SETTINGS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ settings: { [PERSIST_KEY]: raw } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 拉取服务端设置快照并写回本地。
 * 返回 true 表示本地被更新，调用方应触发 store.rehydrate() 让界面生效。
 */
export async function pullSettings(): Promise<boolean> {
  try {
    const res = await fetch(SETTINGS_ENDPOINT, { credentials: 'same-origin' });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      ok: boolean;
      data?: { settings?: Record<string, unknown> };
    };
    const remote = json.data?.settings?.[PERSIST_KEY];
    if (typeof remote !== 'string' || !remote) return false;
    // 服务端也是空快照时不覆盖本地
    if (!snapshotHasContent(remote)) return false;
    const local = readLocalSnapshot();
    if (local === remote) return false;
    localStorage.setItem(PERSIST_KEY, remote);
    return true;
  } catch {
    return false;
  }
}
