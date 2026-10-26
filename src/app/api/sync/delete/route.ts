import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { clearSearchHistory, deleteHistory, deleteSearchHistory, deleteWatchlist } from '@/lib/server/sync-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 删除同步：本地删掉一条后必须通知服务端，否则下次拉取会把它复活。
 * 只接受白名单里的几类（watchlist / history / searchHistory），避免越权删别的表。
 * `id` 传 `*` 表示整表清空（搜索历史「清空全部」用）。
 */
export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  let body: { kind?: string; id?: string };
  try {
    body = (await req.json()) as { kind?: string; id?: string };
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }

  const { kind, id } = body;
  if (!id || typeof id !== 'string') return jsonError('缺少 id', 400);

  try {
    if (kind === 'watchlist') deleteWatchlist(id);
    else if (kind === 'history') deleteHistory(id);
    else if (kind === 'searchHistory') {
      // 单条删 / 整表清空共用一个接口：`*` 是保留 id，搜索框不允许出现
      if (id === '*') clearSearchHistory();
      else deleteSearchHistory(id);
    } else return jsonError('不支持的删除类型', 400);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[sync/delete] 删除失败', err);
    return jsonError('删除服务端数据失败', 500);
  }
}
