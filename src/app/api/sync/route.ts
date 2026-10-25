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

/**
 * 请求体上限 2MB。
 * 正常同步只有几十 KB（几百条收藏 + 历史），2MB 足够宽松；
 * 不设上限则一个超大 JSON 就能把内存吃满（Node 会整包读进内存再解析）。
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * 同步接口限流：每 IP 每分钟 120 次。
 * 为什么比登录宽松得多：登录是防爆破（5 次/10 分钟），
 * 而同步是正常高频操作（防抖后每次改动都会来一次），限太死会误伤。
 * 这里的目的只是防止被狂刷拖垮 SQLite，不是安全边界。
 */
const SYNC_WINDOW_MS = 60_000;
const SYNC_MAX_PER_WINDOW = 120;
const syncHits = new Map<string, { count: number; resetAt: number }>();

function allowSync(ip: string): boolean {
  const now = Date.now();
  const entry = syncHits.get(ip);
  if (!entry || now > entry.resetAt) {
    syncHits.set(ip, { count: 1, resetAt: now + SYNC_WINDOW_MS });
    return true;
  }
  if (entry.count >= SYNC_MAX_PER_WINDOW) return false;
  entry.count += 1;
  return true;
}

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

// 定期清理过期限流记录，避免长期运行下 Map 无限膨胀
if (typeof setInterval === 'function') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of syncHits) {
      if (now > entry.resetAt) syncHits.delete(ip);
    }
  }, 5 * 60_000);
  // 不要因这个定时器阻止进程退出
  timer.unref?.();
}

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

  if (!allowSync(clientIp(req))) {
    return jsonError('同步过于频繁，请稍后再试', 429);
  }

  // 先看 Content-Length 快速拒绝明显超限的请求
  const declared = Number(req.headers.get('content-length') || '0');
  if (declared > MAX_BODY_BYTES) {
    return jsonError('请求体过大', 413);
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonError('读取请求体失败', 400);
  }
  // 再按实际字节数兜底：Content-Length 可伪造或缺失
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError('请求体过大', 413);
  }

  let payload: SyncPayload;
  try {
    payload = JSON.parse(raw) as SyncPayload;
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
