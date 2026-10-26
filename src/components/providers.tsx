'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from './toast';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';
import { GlobalDownloadManager } from './download-manager';
import { useAppStore, hydrateLiveProbeResults } from '@/lib/store';
import { api, STATUS_QUERY_KEY } from '@/lib/client-api';
import { applyEnvPresets } from '@/lib/subscription-sync';
import { db, registerSyncNotifier } from '@/lib/db';
import { deleteRemote, migrateLocalToServer, pushToServer, syncAll } from '@/lib/sync';
import { pullSettings, pushSettings } from '@/lib/settings-sync';
import { checkNewEpisodes } from '@/lib/episode-tracker';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 },
        },
      })
  );

  // store 配置了 skipHydration：等挂载后再读 localStorage，
  // 保证 hydration 阶段客户端与服务端渲染结果一致。
  useEffect(() => {
    // 先等持久化状态恢复，再拉服务端下发数据：
    // 避免 setEnvSources/setLiveEnvSources 的勾选合并发生在 rehydrate 之前被覆盖
    Promise.resolve(useAppStore.persist.rehydrate())
      .then(() => {
        // 测活缓存从 IndexedDB 恢复（并顺带搬迁旧 localStorage 快照里的存量），
        // 与下方 /api/status 拉取互不依赖，失败静默
        void hydrateLiveProbeResults();
        // 拉取部署者通过 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 预置的源（失败时静默忽略）
        // 与 AuthProvider 共用同一 query key，/api/status 全站只发一次
        return queryClient.fetchQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status() });
      })
      .then((d) => {
        // 预置数据（DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES / DEFAULT_SUBSCRIPTIONS）
        // 预置订阅要经鉴权接口拉取，首屏这次可能发生在登录之前而 401 静默失败；
        // 登录成功后由 AuthProvider 再调一次 applyEnvPresets 补齐（函数幂等）
        if (d) return applyEnvPresets(d);
      })
      .catch(() => {});

    // 服务端同步初始化：登录态就绪后再跑，避免首次 401 白跑一趟。
    // 顺序很关键：先把浏览器里已有的旧数据上行（迁移），再拉服务端覆盖，
    // 否则升级后第一次打开会把原有片单冲掉。
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await migrateLocalToServer();
          await syncAll();
          // 设置/视频源：服务端有内容就覆盖本地（换了设备时把源配置带过来），
          // 本地有内容而服务端空则上行补种
          const pulled = await pullSettings();
          if (pulled) {
            await useAppStore.persist.rehydrate();
          } else {
            await pushSettings();
          }
          // 启动时补跑一次追更检测：只在打开收藏面板时才检测的话，顶栏角标
          // 永远等不到数据——用户不打开面板就看不到红色提醒，提醒等于不存在。
          // 内部有 6 小时节流，频繁刷新页面不会重复打采集站。
          void checkNewEpisodes();
        } catch {
          /* 服务端不可用时保持本地数据可用 */
        }
      })();
    }, 1500);

    // 本地数据变更 → 累积后统一上行（防抖，避免播放进度每秒发一次请求）
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    // 用 Map 而非单变量：1.2s 内连删多条时，单变量只会记住最后一条，
    // 前面的删除漏同步，下次拉取会从服务端把它们「复活」。
    // 键为 `kind:id` 天然去重（同一项反复删只留一条）。
    const pendingDeletes = new Map<string, { kind: 'watchlist' | 'history'; id: string }>();

    registerSyncNotifier((kind, id) => {
      if (kind === 'progress') return; // 进度量大且可重建，不单独上行
      // 本地先判存不存在：能删掉说明是删除；删不掉说明是新增/更新。
      // 两者都进队列，但只有「已不存在」才需要通知服务端删除。
      pendingDeletes.set(`${kind}:${id}`, { kind, id });
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const batch = [...pendingDeletes.values()];
        pendingDeletes.clear();
        void (async () => {
          // 逐条确认该 id 在本地是否真的已不存在；存在说明是 upsert，跳过删除
          for (const item of batch) {
            const stillExists =
              item.kind === 'watchlist'
                ? await db.watchlist.get(item.id)
                : await db.history.get(item.id);
            if (!stillExists) await deleteRemote(item.kind, item.id);
          }
          await pushToServer();
          await pushSettings();
        })();
      }, 1200);
    });

    return () => {
      clearTimeout(timer);
      if (pendingTimer) clearTimeout(pendingTimer);
      registerSyncNotifier(null);
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          {/* 全站常驻：下载事件监听（enqueueDownload）依赖它存在——
              挂在 Header 里会让 /watch 等不渲染 Header 的页面派发的事件凭空丢失 */}
          <GlobalDownloadManager />
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
