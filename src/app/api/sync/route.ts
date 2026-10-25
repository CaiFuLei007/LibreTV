import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { readAll, writeAll, type SyncPayload } from '@/lib/server/sync-repo';
import { dataDirInfo } from '@/lib/server/store-db';

export const runtime = 'nodejs';
/** 数据随时在变，禁止 Next 缓存这次响应 */
export const dynamic = 'force-dynamic';

/**
 * 跨设备同步接口。
 *
 * GET  ：全量拉取（收藏 / 历史 / 进度 / 自定义源 / 设置）
 * POST ：增量写入（upsert，按 updatedAt 取新者）
 *
 * 鉴权复用站点密码：未登录一律 401，避免把私人片单暴露给同网络任何人。
 */

export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  try {
    return NextResponse.json({ ok: true, data: readAll() });
  } catch (err) {
    console.error('[sync] 读取失败', err);
    return jsonError('读取服务端数据失败', 500);
  }
}

export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  let payload: SyncPayload;
  try {
    payload = (await req.json()) as SyncPayload;
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }

  if (typeof payload !== 'object' || payload === null) {
    return jsonError('请求体格式不正确', 400);
  }

  try {
    writeAll(payload);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[sync] 写入失败', err);
    return jsonError('写入服务端数据失败', 500);
  }
}

/** 健康检查：确认数据文件位置与是否可写（排查持久化问题用） */
export async function HEAD(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const info = dataDirInfo();
  return new NextResponse(null, {
    status: 200,
    headers: { 'x-data-dir': info.dir, 'x-data-file': info.file },
  });
}
