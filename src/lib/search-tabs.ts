/**
 * 搜索结果「按媒体类型分开」——判定与分区层（纯函数，无 IO）。
 *
 * ## 为什么分类直接复用 `media-category.ts`
 *
 * 收藏夹的「分类折叠分区」已经有一套判定（`categoryOf`），搜索结果沿用同一套：
 * - 用户在收藏夹里学到「电影 / 剧集 / 动漫 / 短剧」这套词，搜索页不必再学一遍；
 * - 判定规则只有一处实现，两边不会漂移（改一处 → 两边同时生效）。
 *
 * ## 与收藏夹的一处刻意差异：附属物不丢弃
 *
 * 收藏夹里 `[电影解说]` 不是「一部作品」，分区时直接排除。但搜索里用户可能
 * **就是要找解说**（搜「医生」出一堆「医生[电影解说]」很常见）。
 * 所以这里让附属物落进「其他」，既不污染电影 / 剧集两桶，也不会凭空消失。
 *
 * ## 分组归属用「组内多数票」而不是取第一个 typeName
 *
 * 同名影片跨源聚合后，`group.typeName` 只是组内第一个有值的 item 的类型。
 * 实测「无良医生：爱里藏刀」在暴风是 `纪录片`、在巨量是 `纪录剧集`——
 * 取第一个会随源顺序漂移。改成统计组内全部 item 的分类，取多数；
 * 平票时按 `CATEGORY_ORDER` 的先后决定，保证同一份输入永远得到同一结果。
 */

import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  categoryOf,
  type MediaCategory,
} from './media-category';

/** 「全部」是额外的一档，不是媒体分类 */
export const ALL_TAB = 'all' as const;

export type SearchTab = typeof ALL_TAB | MediaCategory;

/** tab 展示顺序：全部在最前，其余沿用分类顺序 */
export const TAB_ORDER: readonly SearchTab[] = [ALL_TAB, ...CATEGORY_ORDER];

/**
 * 「全部」tab 内每段默认展示的卡片数。
 *
 * 6 = 三列布局下正好两行。给 3 个太少（判断不出「有没有我要的」），
 * 给 12 个则四段加起来一屏放不下，反而比不分段更难扫。
 */
export const SECTION_PREVIEW = 6;

/** tab 显示名。「全部」单独给，其余查分类词表 */
export function tabLabelOf(tab: SearchTab): string {
  return tab === ALL_TAB ? '全部' : CATEGORY_LABEL[tab];
}

/**
 * 把 URL 上的 `?t=` 解析成合法 tab。
 *
 * 非法值（手改链接、旧链接、拼错）一律回落到「全部」：
 * 「全部」等于改造前的体验，落错也不会让用户看不到结果。
 */
export function toSearchTab(raw: string | null | undefined): SearchTab {
  if (!raw) return ALL_TAB;
  const t = raw.trim();
  return (TAB_ORDER as readonly string[]).includes(t) ? (t as SearchTab) : ALL_TAB;
}

// —— 分组归属 ——

/** 参与分类判定的最小结构（`AggregatedGroup` 天然满足） */
export interface CategorizableGroup {
  typeName?: string;
  items?: { typeName?: string }[];
}

/**
 * 一个聚合组归到哪个分类。
 *
 * 统计组内**所有来源**的 typeName，取多数；平票按 CATEGORY_ORDER 先后。
 * 组里连一个 typeName 都没有（源站没填）→ 落「其他」，不猜。
 */
export function tabOfGroup(group: CategorizableGroup): MediaCategory {
  const names = (group.items?.length ? group.items : [group])
    .map((i) => i.typeName)
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '');

  if (names.length === 0) return 'other';
  if (names.length === 1) return categoryOf(names[0]);

  const tally = new Map<MediaCategory, number>();
  for (const t of names) {
    const c = categoryOf(t);
    tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  // 票数最高；平票时按固定顺序取靠前的，保证结果与源顺序无关
  let best: MediaCategory | undefined;
  let bestCount = 0;
  for (const [c, n] of tally) {
    if (best === undefined || n > bestCount ||
        (n === bestCount && CATEGORY_ORDER.indexOf(c) < CATEGORY_ORDER.indexOf(best))) {
      best = c;
      bestCount = n;
    }
  }
  return best ?? 'other';
}

// —— 分区 ——

/** 一个 tab 内的一段（「全部」tab 下有多段，单 tab 下只有一段） */
export interface SearchSection<T> {
  category: MediaCategory;
  label: string;
  /** 该段全部命中 */
  groups: T[];
  /** 该段命中总数（`groups.length`，单独留字段便于 UI 读） */
  total: number;
  /** 当前该渲染的条目（未展开时被 `SECTION_PREVIEW` 截断） */
  shown: T[];
  /** 还有多少条被折叠（预览截断 + 分批挂载都算） */
  hidden: number;
  /** 该段是否被「预览 6 条」截断——决定块头是否给「查看全部」 */
  previewing: boolean;
}

/**
 * 每个 tab 的命中数，用于 tab 上的角标。
 *
 * 「全部」= 所有分类之和（不是原始条目数），与其它 tab 同口径，
 * 用户心算「47 + 153 + …」能对上。
 */
export function countByTab<T extends CategorizableGroup>(
  groups: T[]
): Record<SearchTab, number> {
  const counts = {} as Record<SearchTab, number>;
  for (const t of TAB_ORDER) counts[t] = 0;

  for (const g of groups) {
    const c = tabOfGroup(g);
    counts[c] += 1;
    counts[ALL_TAB] += 1;
  }
  return counts;
}

/**
 * 需要渲染的 tab 列表：全部 + **有内容**的分类。
 *
 * 计数为 0 的分类不出现——点进一个空 tab 比看不到这个 tab 更糟。
 */
export function visibleTabs<T extends CategorizableGroup>(
  groups: T[]
): { tab: SearchTab; label: string; count: number }[] {
  const counts = countByTab(groups);
  return TAB_ORDER.filter((t) => t === ALL_TAB || counts[t] > 0).map((t) => ({
    tab: t,
    label: tabLabelOf(t),
    count: counts[t],
  }));
}

/**
 * 按当前 tab 切出分区。
 *
 * - `all`：按 CATEGORY_ORDER 分段（固定顺序，不按条数排——顺序稳定比「多的在前」更好记），
 *   空分类整段不渲染；每段默认只露 `SECTION_PREVIEW` 条，带「查看全部」。
 * - 单分类：只留一段，不再做预览截断（用户已经明确选了这一类，再多也不该再点一次），
 *   只受 `mountLimit` 的分批挂载约束。
 *
 * @param expanded   已点过「查看全部」的分类（`all` tab 下解除该段的预览截断）
 * @param mountLimit 展开态 / 单 tab 下的**挂载上限**（分批挂载，缺省不限）。
 *                   一个分类可能有 155 部，一次插 155 张卡会同时触发 155 个画质探测
 *                   与 155 个 IntersectionObserver——所以展开后也按页给，
 *                   由页面层的「加载更多」继续加。
 */
export function buildSections<T extends CategorizableGroup>(
  groups: T[],
  tab: SearchTab,
  expanded: ReadonlySet<MediaCategory> = new Set(),
  mountLimit = Number.POSITIVE_INFINITY
): SearchSection<T>[] {
  const buckets = new Map<MediaCategory, T[]>();
  for (const g of groups) {
    const c = tabOfGroup(g);
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c)!.push(g);
  }

  const order: MediaCategory[] =
    tab === ALL_TAB ? [...CATEGORY_ORDER] : [tab as MediaCategory];

  const out: SearchSection<T>[] = [];
  for (const category of order) {
    const list = buckets.get(category) ?? [];
    if (list.length === 0) continue;

    // 「全部」的未展开段用预览量截断；展开态与单 tab 用挂载上限截断。
    // previewing 只在**预览真的截掉了东西**时为 true：一段只有 3 条却标成
    // 「预览中」，UI 就会给出「查看全部 3 部」这种点了没反应的空按钮。
    const wantsPreview = tab === ALL_TAB && !expanded.has(category);
    const previewing = wantsPreview && list.length > SECTION_PREVIEW;
    const limit = wantsPreview ? SECTION_PREVIEW : mountLimit;
    const shown = Number.isFinite(limit) ? list.slice(0, Math.max(0, limit)) : list;

    out.push({
      category,
      label: CATEGORY_LABEL[category],
      groups: list,
      total: list.length,
      shown,
      hidden: list.length - shown.length,
      previewing,
    });
  }
  return out;
}
