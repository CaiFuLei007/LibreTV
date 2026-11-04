/**
 * 收藏夹「系列归组」——判定层。
 *
 * ## 为什么只读片名
 *
 * Kodi / Jellyfin / Plex 都靠一份权威系列 ID（TMDB `belongs_to_collection`）做归组，
 * LibreTV 没有这份 ID：采集站片名的英文名、年份、类型都不可信（实测「招魂3」
 * 被写成 2013 年的悬疑片，「招魂」的 total_episodes 是 0）。所以只能从片名的
 * **结构**里找「基名 + 第 N 部」的信号。
 *
 * ## 设计原则：宁可漏组，不可错组
 *
 * - 漏组 = 用户看到「还是散着」，和改造前一样，无损失；
 * - 错组 = 用户的片子被塞进别人家里且找不到，是 bug。
 *
 * 因此这里**只做形态判定，不做相似度、不做别名推导、不做副标题挂靠**。
 * 实测：50 条混合池跨系列错误合并 0 处；作为代价，哈利波特、鬼吹灯这类
 * 「只有副标题没有编号」的续集会漏组——这是刻意接受的。
 *
 * ## 判定链（命中即停）
 *
 * 0. 附属物排除：`[电影解说]`、`[预告片]`、花絮等是「同一部的附属物」而不是「另一部」，
 *    整条不进任何组（否则组里会出现两个「第 4 部」）
 * 1. 归一化：全角→半角、压空白、去首尾
 * 2. 剥噪声与年份：HD / 中字 / 国语版 / (2013) / [2013]
 * 3. 试切部号：
 *    a. 尾部「第N部 / 第N季 / 第N集」（含中文数字）
 *    b. 冒号前**已带部号**才切副标题：`招魂4：终章` → 招魂 + 4
 *       （不切 `名侦探柯南：绀青之拳`，否则十几部剧场版会被并成一组）
 *    c. 尾部裸 1–2 位数字；整串是数字的（《2012》《1917》）不算
 * 4. 两趟建组：先收「已知基名」，再让没有部号的条目认领自己的基名（招魂 → 第 1 部）
 * 5. 组内 < 2 条 → 不建组，还原成单条
 *
 * 纯函数、无 IO、不改任何数据：归组是**展示层派生**。
 */

/** 一部「主条目」在归组中的位置 */
export interface SeriesMember<T> {
  item: T;
  /** 裁决用的部号：无部号的基名本身记为 1 */
  part: number;
  /** 真实片名（保留原始写法，未剥噪声——同一部片可能有多条不同标注的记录） */
  title: string;
}

/** 一个系列组 */
export interface SeriesGroup<T> {
  /** 稳定标识：基名归一化小写，可直接当 React key */
  key: string;
  /** 组标题：基名的原始写法 */
  title: string;
  /** 组成员，按部号升序；部号相同时按片名 */
  members: SeriesMember<T>[];
  /** 组内是否有用户没看过的（由调用方按状态填，这里只留位置说明） */
  size: number;
}

export interface GroupResult<T> {
  groups: SeriesGroup<T>[];
  /** 独立条目：不成组的片（含单成员组还原、含附属物） */
  singles: T[];
}

// ---------------------------------------------------------------------------
// 1. 归一化与噪声
// ---------------------------------------------------------------------------

/**
 * 归一化：全角字符转半角、全角空格转半角、压缩连续空白、去首尾。
 * 只抹平排版差异，不改动语义（大小写保留，中文无所谓）。
 */
export function normalizeSeriesTitle(title: string): string {
  return (title ?? '')
    .replace(/\u3000/g, ' ')
    // 全角 ASCII 区整体前移 0xFEE0：！到 ～ 覆盖了 ：（）［］等采集站常见全角标点
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 「附属物」判定：解说 / 预告 / 花絮 / 片段。
 *
 * 这类条目在采集站上与原片同名，只是多了个后缀。它们不是「另一部」，
 * 一旦参与归组就会出现「招魂 4」两个成员、组头部数与实际对不上。
 * 处理方式：整条排除出归组，但仍留在列表里单独显示（用户可能就是来找解说的）。
 */
const ACCESSORY = /(?:电影解说|影视解说|解说|预告片|预告|花絮|片段|抢先版|枪版)/u;

export function isAccessoryTitle(title: string): boolean {
  return ACCESSORY.test(normalizeSeriesTitle(title));
}

/** 尾部噪声：清晰度 / 语言 / 版本标注，不参与身份判定 */
const NOISE = new RegExp(
  [
    // 括号形态：可出现在任意位置，直接删
    '[（(\\[【]\\s*(?:HD|BD|HDR|4K|超清|高清|蓝光|中字|国语版?|粤语版?|双语版?|原声|完整版|未删减版?)\\s*[)）\\]】]',
    // 裸后缀形态：只在结尾删，避免吃掉片名中间的词
    '[\\s_\\-·]*(?:HD|BD|HDR|4K|中字|国语版?|粤语版?|国粤双语|完整版|未删减版?)$',
  ].join('|'),
  'i'
);

/** 年份标注：`(2013)`、`[2016]`、`（2021）`。裸年份不认——那是片名的一部分（《2012》） */
const YEAR = /[\s]*[（(\[【]\s*(?:19|20)\d{2}\s*[)）\]】]/gu;

/**
 * 剥掉尾部噪声与年份标注，多轮直到收敛（`招魂2 HD 中字 国语版` 要剥三层）。
 * 返回用于**判定**的干净片名；展示一律用原始 title。
 */
export function stripSeriesNoise(title: string): string {
  let s = normalizeSeriesTitle(title);
  for (let i = 0; i < 5; i += 1) {
    const next = s
      .replace(YEAR, '')
      .replace(NOISE, '')
      .replace(/[\s_\-·:：]+$/u, '')
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

// ---------------------------------------------------------------------------
// 2. 部号解析
// ---------------------------------------------------------------------------

/** 第N部 / 第N季 / 第N集（含中文数字） */
const PART_CN = /^(.+?)\s*第\s*([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*[部季集]\s*$/u;
/** 尾部裸数字：招魂2 / 叶问 4；`.·_-` 也视为分隔 */
const PART_ARABIC = /^(.+?)[\s_\-·.]*([1-9][0-9]?)$/u;
/** 冒号前带部号时，冒号后是副标题 */
const SUB_WITH_PART = /^(.+?)\s*[:：]\s*.+$/u;
/** 整串是数字：片名本身（《2012》《1917》《2046》） */
const ALL_DIGITS = /^\d{1,4}$/u;

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function cnToInt(s: string): number | undefined {
  const t = s.replace(/两/g, '二');
  if (/^\d+$/.test(t)) return Number(t);
  if (t.length === 1 && t in CN_DIGITS) return CN_DIGITS[t];
  if (t.includes('十')) {
    const [tens, units] = t.split('十');
    const hi = tens ? (CN_DIGITS[tens] ?? 1) : 1;
    const lo = units ? (CN_DIGITS[units] ?? 0) : 0;
    return hi * 10 + lo;
  }
  return undefined;
}

export interface SeriesPart {
  /** 基名（未归一化的原始写法） */
  base: string;
  /** 部号 */
  part: number;
}

/**
 * 从片名切出 (基名, 部号)；不是系列条目时返回 undefined。
 *
 * 只看形态，不问语义：认得「招魂4：终章」是招魂第 4 部，
 * 但不会去猜「哈利·波特与密室」是哈利波特系列第 2 部。
 */
export function parseSeriesPart(title: string): SeriesPart | undefined {
  const s = normalizeSeriesTitle(title);
  if (!s || ALL_DIGITS.test(s)) return undefined;

  // a) 第N部 / 第N季 / 第N集
  const cn = s.match(PART_CN);
  if (cn && cn[1].trim()) {
    const n = cnToInt(cn[2]);
    if (n && n > 0) return { base: cn[1].trim(), part: n };
  }

  // b) 冒号副标题：仅当冒号前本身带部号才切。
  //    否则「名侦探柯南：绀青之拳」「指环王：护戒使者」都会被误并成一组。
  const sub = s.match(SUB_WITH_PART);
  if (sub) {
    return parseSeriesPart(sub[1]);
  }

  // c) 尾部裸数字
  const ar = s.match(PART_ARABIC);
  if (ar && ar[1].trim()) {
    const n = Number(ar[2]);
    if (n >= 1 && n <= 99) return { base: ar[1].trim(), part: n };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 3. 归组
// ---------------------------------------------------------------------------

/**
 * 把一组条目按系列归组。
 *
 * 两趟扫描的理由：收藏里可能只有「招魂2/招魂3」而没有「招魂」，也可能两者都在。
 * 单趟遍历要么漏掉第 1 部，要么把「招魂」错认成独立条目。
 *
 * @param items  待归组的条目（同一状态栏内的全部条目）
 * @param getTitle 取片名；归组身份用**原始片名**，展示也用原始片名
 */
export function groupBySeries<T>(
  items: T[],
  getTitle: (item: T) => string
): GroupResult<T> {
  const parsed = items.map((item) => {
    // 展示用原始片名：归一化只服务于判定，不能反过来污染列表
    const original = (getTitle(item) ?? '').trim();
    const raw = normalizeSeriesTitle(original);
    const clean = stripSeriesNoise(raw);
    const accessory = isAccessoryTitle(raw);
    const hit = accessory ? undefined : parseSeriesPart(clean);
    return { item, original, raw, clean, key: clean.toLowerCase(), accessory, hit };
  });

  // 第 1 趟：收集所有「已知基名」
  const knownBases = new Map<string, string>();
  for (const p of parsed) {
    if (p.hit) knownBases.set(normalizeSeriesTitle(p.hit.base).toLowerCase(), p.hit.base);
  }

  // 第 2 趟：分桶
  const buckets = new Map<string, { base: string; members: SeriesMember<T>[] }>();
  const singles: T[] = [];

  for (const p of parsed) {
    // 附属物一律不参与归组，但保留在列表里
    if (p.accessory) {
      singles.push(p.item);
      continue;
    }
    if (p.hit) {
      const id = normalizeSeriesTitle(p.hit.base).toLowerCase();
      if (!buckets.has(id)) {
        buckets.set(id, { base: knownBases.get(id) ?? p.hit.base, members: [] });
      }
      buckets.get(id)!.members.push({ item: p.item, part: p.hit.part, title: p.original });
      continue;
    }
    // 无部号：整名等于某个已知基名 → 认作第 1 部；否则是真正的散片
    if (knownBases.has(p.key)) {
      if (!buckets.has(p.key)) {
        buckets.set(p.key, { base: knownBases.get(p.key)!, members: [] });
      }
      buckets.get(p.key)!.members.push({ item: p.item, part: 1, title: p.original });
      continue;
    }
    singles.push(p.item);
  }

  // 收尾：< 2 条不建组；组内按部号排序
  const groups: SeriesGroup<T>[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.members.length < 2) {
      singles.push(...bucket.members.map((m) => m.item));
      continue;
    }
    const members = [...bucket.members].sort(
      (a, b) => a.part - b.part || a.title.localeCompare(b.title, 'zh-Hans-CN')
    );
    groups.push({ key, title: bucket.base, members, size: members.length });
  }
  groups.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));

  return { groups, singles };
}

/**
 * 搜索命中时，判断某个组是否需要自动展开。
 *
 * 规则：关键词命中组标题（招魂）或任一成员片名（招魂3）都算命中；
 * 若命中成员而不是组标题，调用方还应高亮那一行，避免「搜到了但看不出来」。
 */
export function matchGroup<T>(
  group: SeriesGroup<T>,
  keyword: string
): { hit: boolean; memberTitles: string[] } {
  const kw = normalizeSeriesTitle(keyword).toLowerCase();
  if (!kw) return { hit: false, memberTitles: [] };
  const memberTitles = group.members
    .filter((m) => normalizeSeriesTitle(m.title).toLowerCase().includes(kw))
    .map((m) => m.title);
  const hit = normalizeSeriesTitle(group.title).toLowerCase().includes(kw) || memberTitles.length > 0;
  return { hit, memberTitles };
}
