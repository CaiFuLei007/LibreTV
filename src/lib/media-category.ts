/**
 * 收藏夹「媒体分类」——判定层。
 *
 * ## 策略：信任采集站自己声明的类型，不推断
 *
 * 每条收藏都带 `typeName`（采集站的 `vod_type_name`），这就是源站对这部片的
 * 自我描述。分类只做一次**翻译**：把几十个方言词（恐怖片 / 国产动漫 / 韩国剧…）
 * 归到少数几个固定桶里，供收藏夹分区展示。
 *
 * 为什么不做语义推断：
 * - TMDB 的 `genre_ids`（16 = Animation）拿不到——本项目无 TMDB key，实测 401；
 * - 豆瓣 `j/search_subjects` 只回片名/封面/评分，不含类型；
 * - 采集站片名的年份、类型都不可信（实测「招魂3」被写成 2013 年的悬疑片），
 *   除了 `typeName` 本身没有第二个可靠信号。
 *
 * 所以：**源站说它是什么，就当它是什么**。判错时用户仍能从分区标题看出归类依据，
 * 不会出现「莫名其妙被分到别处」的黑盒感。
 *
 * ## 判定顺序（写死的优先级，不能调换）
 *
 * 1. 附属物：解说 / 预告 / 花絮 —— 不是「一部作品」，分区时应排除
 * 2. 动漫：动漫 / 动画 / 漫剧 / 番剧 —— **必须排在「片」后缀规则之前**，
 *    否则 `动漫片` 会以「片」结尾被判成电影，动漫就永远挑不出来了
 * 3. 综艺
 * 4. 体育
 * 5. 成人：伦理 / 理论 / 福利
 * 6. 短剧：竖屏微短剧（采集站把题材词当 type_name 用：重生民国、古装仙侠…）
 * 7. 后缀兜底：`…片` → 电影，`…剧` → 剧集
 * 8. 无类型 → 其他
 *
 * 第 7 步为什么必须按**后缀**而不是「包含」：`剧情片`、`喜剧片` 都含「剧」，
 * 用包含关系会把电影判成剧集——实测会错掉一半电影。
 *
 * ## 「动漫」的口径：纯 animation
 *
 * 只要带「动漫/动画」标签就进动漫桶，不区分连载番剧与动画电影。
 * 《你的名字》（type=动画片）与《仙逆》（type=国产动漫）同桶。
 *
 * 这是刻意的选择：采集站只有「动画片」一个标签，没有 TV/剧场版之分；
 * 若引入集数做二次判断，会把「全集打包成 1 个地址」的连载动画误判成电影。
 * 宁可口径粗一点，也不要让分类忽左忽右。
 */

/** 分类桶。顺序即 UI 展示顺序：内容多的在前，其他垫底 */
export const CATEGORY_ORDER = [
  'movie',
  'tv',
  'anime',
  'variety',
  'short',
  'sport',
  'adult',
  'other',
] as const;

export type MediaCategory = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_LABEL: Record<MediaCategory, string> = {
  movie: '电影',
  tv: '剧集',
  anime: '动漫',
  variety: '综艺',
  short: '短剧',
  sport: '体育',
  adult: '成人',
  other: '其他',
};

/** 附属物：解说 / 预告 / 花絮。不是「一部作品」，分区展示时应排除 */
const ACCESSORY_KW = ['解说', '预告', '花絮', '片段', '抢先版', '枪版'] as const;

/** 动漫：必须最先判（见文件头注释第 2 条） */
const ANIME_KW = ['动漫', '动画', '漫剧', '番剧', '里番'] as const;

const VARIETY_KW = ['综艺'] as const;

const SPORT_KW = ['体育', '足球', '篮球', '网球', '斯诺克', '赛事'] as const;

const ADULT_KW = ['伦理', '理论', '福利'] as const;

/** 短剧关键词：既含「短剧」本身，也含采集站当类型用的题材词 */
const SHORT_KW = ['短剧'] as const;
const SHORT_GENRE_KW = [
  '重生',
  '穿越',
  '言情',
  '爽文',
  '总裁',
  '闪婚',
  '脑洞',
  '仙侠',
] as const;

/**
 * 附属物判定：这些条目不该出现在任何分类分区里。
 * 注意它与 `series-group.ts` 的 `isAccessoryTitle` 分工不同——
 * 那边看**片名**（`招魂4[预告片]`），这里看**类型**（`电影解说`）。
 */
export function isAccessoryCategory(typeName: string | undefined): boolean {
  const t = (typeName ?? '').trim();
  if (!t) return false;
  return ACCESSORY_KW.some((k) => t.includes(k));
}

/**
 * 把一个采集站类型名翻译成分类桶。
 *
 * 判定只看 `typeName`，不接收片名/年份/集数——保持单输入单输出，
 * 便于测试与解释「为什么这部片在这个分区」。
 */
export function categoryOf(typeName: string | undefined): MediaCategory {
  const t = (typeName ?? '').trim();
  if (!t) return 'other';

  // 1. 动漫优先（动漫片 / 动画片 都以「片」结尾，必须先判）
  if (ANIME_KW.some((k) => t.includes(k))) return 'anime';

  // 2. 其余按关键词
  if (VARIETY_KW.some((k) => t.includes(k))) return 'variety';
  if (SPORT_KW.some((k) => t.includes(k))) return 'sport';
  if (ADULT_KW.some((k) => t.includes(k))) return 'adult';
  if (SHORT_KW.some((k) => t.includes(k))) return 'short';
  if (SHORT_GENRE_KW.some((k) => t.includes(k))) return 'short';

  // 3. 后缀兜底：片 → 电影，剧 → 剧集。
  //    必须是「按后缀」：剧情片/喜剧片 含「剧」但是电影。
  if (t.endsWith('片')) return 'movie';
  if (t.endsWith('剧')) return 'tv';

  // 4. 非标准写法兜底：既不以「片」也不以「剧」结尾，但词里带了主类字
  if (t.includes('剧')) return 'tv';
  if (t.includes('片')) return 'movie';

  return 'other';
}

export interface CategoryBucket<T> {
  category: MediaCategory;
  label: string;
  items: T[];
  /** 分区内条目数，供块头显示；与 items.length 相同，单独留字段便于 UI 读 */
  count: number;
}

/**
 * 按分类把条目分桶，返回**固定顺序**的全部分区（含空桶）。
 *
 * 为什么保留空桶：方案 D 的设计是「空分类也显示块头 + 0」，用户可以点开看空态。
 * 比「悄悄消失」更让人放心——后者容易让人以为片子丢了。
 *
 * @param items     条目
 * @param getType   取 typeName
 * @param excludeAccessory 是否剔除附属物（默认剔除，它们不是一部作品）
 */
export function groupByCategory<T>(
  items: T[],
  getType: (item: T) => string | undefined,
  excludeAccessory = true
): CategoryBucket<T>[] {
  const buckets = new Map<MediaCategory, T[]>();
  for (const c of CATEGORY_ORDER) buckets.set(c, []);

  for (const item of items) {
    const type = getType(item);
    if (excludeAccessory && isAccessoryCategory(type)) continue;
    buckets.get(categoryOf(type))!.push(item);
  }

  return CATEGORY_ORDER.map((category) => {
    const list = buckets.get(category)!;
    return { category, label: CATEGORY_LABEL[category], items: list, count: list.length };
  });
}

/**
 * 判断某个分类分区是否值得显示。
 *
 * 规则：有条目就显示；空分区只在「用户手动展开过」时显示。
 * 后者由 UI 决定（见 category-section.tsx），这里只给「有没有内容」这一个事实。
 */
export function hasContent<T>(bucket: CategoryBucket<T>): boolean {
  return bucket.count > 0;
}
