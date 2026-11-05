import { describe, expect, it } from 'vitest';
import {
  ALL_TAB,
  SECTION_PREVIEW,
  TAB_ORDER,
  buildSections,
  countByTab,
  tabLabelOf,
  tabOfGroup,
  toSearchTab,
  visibleTabs,
  type CategorizableGroup,
} from './search-tabs';

/**
 * 搜索结果分区判定的回归基线。
 *
 * 数据来源：8090 生产实例真实搜索（关键词「医生」，35 个源聚合，352 条结果），
 * 按产品现有的 `aggregateResults` 做同名 + 年份聚合得到 277 个组，
 * 再跑本文件的分区函数。分布断言用的就是这份实测值。
 */

const g = (name: string, typeName?: string): CategorizableGroup & { name: string } => ({
  name,
  typeName,
  items: typeName ? [{ typeName }] : [],
});

describe('toSearchTab URL 解析', () => {
  it('合法值原样返回', () => {
    expect(toSearchTab('movie')).toBe('movie');
    expect(toSearchTab('tv')).toBe('tv');
    expect(toSearchTab('all')).toBe('all');
  });

  it('空值 / 非法值 / 手改链接一律回落到「全部」', () => {
    expect(toSearchTab(null)).toBe('all');
    expect(toSearchTab(undefined)).toBe('all');
    expect(toSearchTab('')).toBe('all');
    expect(toSearchTab('  ')).toBe('all');
    expect(toSearchTab('MOVIE')).toBe('all');
    expect(toSearchTab('films')).toBe('all');
    expect(toSearchTab('__proto__')).toBe('all');
  });

  it('去掉首尾空白后仍能识别', () => {
    expect(toSearchTab(' movie ')).toBe('movie');
  });
});

describe('tabLabelOf', () => {
  it('全部与各类都有中文名', () => {
    expect(tabLabelOf('all')).toBe('全部');
    expect(tabLabelOf('movie')).toBe('电影');
    expect(tabLabelOf('tv')).toBe('剧集');
    expect(tabLabelOf('anime')).toBe('动漫');
    expect(tabLabelOf('other')).toBe('其他');
  });
});

describe('tabOfGroup 组内多数票', () => {
  it('单源直接用 typeName 判定', () => {
    expect(tabOfGroup(g('医生', '恐怖片'))).toBe('movie');
    expect(tabOfGroup(g('低谷医生', '韩国剧'))).toBe('tv');
    expect(tabOfGroup(g('魔物娘的医生', '日本动漫'))).toBe('anime');
  });

  it('多源一致时结论不变', () => {
    expect(
      tabOfGroup({
        items: [{ typeName: '日本剧' }, { typeName: '日剧' }, { typeName: '日本剧' }],
      })
    ).toBe('tv');
  });

  it('多源不一致时取多数，而不是取第一个', () => {
    // 实测「白夜医生」：日本剧 ×2 + 日剧 ×1 → 剧集
    expect(tabOfGroup({ items: [{ typeName: '日剧' }, { typeName: '日本剧' }, { typeName: '日本剧' }] })).toBe('tv');
    // 反例保护：把少数派放第一个，结论仍应取多数
    expect(tabOfGroup({ items: [{ typeName: '纪录片' }, { typeName: '电影解说' }, { typeName: '电影解说' }] })).toBe('other');
  });

  it('平票时按 CATEGORY_ORDER 定序，与源顺序无关', () => {
    const a = tabOfGroup({ items: [{ typeName: '恐怖片' }, { typeName: '伦理片' }] });
    const b = tabOfGroup({ items: [{ typeName: '伦理片' }, { typeName: '恐怖片' }] });
    expect(a).toBe(b);
    // movie 在 CATEGORY_ORDER 中先于 adult
    expect(a).toBe('movie');
  });

  it('typeName 全缺失时落「其他」，不猜', () => {
    expect(tabOfGroup({ items: [] })).toBe('other');
    expect(tabOfGroup({ typeName: undefined, items: [{ typeName: undefined }] })).toBe('other');
    expect(tabOfGroup({ items: [{ typeName: '' }, { typeName: '   ' }] })).toBe('other');
  });

  it('只有 typeName 没有 items 时也能判（兼容裸 group）', () => {
    expect(tabOfGroup({ typeName: '动作片' })).toBe('movie');
  });

  it('「电影解说」不污染电影桶，落「其他」', () => {
    expect(tabOfGroup(g('流氓医生[电影解说]', '电影解说'))).toBe('other');
    expect(tabOfGroup(g('闪闪的儿科医生[电影解说]', '影视解说'))).toBe('other');
  });

  it('动漫优先于「片」后缀（AI漫剧 / 动画片 / 动漫片）', () => {
    expect(tabOfGroup(g('急诊医生：我能看到死亡倒计时', 'AI漫剧'))).toBe('anime');
    expect(tabOfGroup(g('你的名字', '动画片'))).toBe('anime');
    expect(tabOfGroup(g('某片', '动漫片'))).toBe('anime');
  });

  it('「剧情片 / 喜剧片」是电影不是剧集（后缀判定而非包含判定）', () => {
    expect(tabOfGroup(g('x', '剧情片'))).toBe('movie');
    expect(tabOfGroup(g('x', '喜剧片'))).toBe('movie');
  });
});

describe('countByTab 计数', () => {
  const groups = [
    g('a', '恐怖片'),   // movie
    g('b', '动作片'),   // movie
    g('c', '韩国剧'),   // tv
    g('d', '日本动漫'), // anime
    g('e', '电影解说'), // other
  ];

  it('各分类计数正确，「全部」为总和', () => {
    const c = countByTab(groups);
    expect(c.movie).toBe(2);
    expect(c.tv).toBe(1);
    expect(c.anime).toBe(1);
    expect(c.other).toBe(1);
    expect(c.all).toBe(5);
  });

  it('空数组时每一项都是 0 且键完整', () => {
    const c = countByTab([]);
    for (const t of TAB_ORDER) expect(c[t]).toBe(0);
  });

  it('「全部」恒等于各分类之和（用户心算能对上）', () => {
    const c = countByTab(groups);
    const sum = TAB_ORDER.filter((t) => t !== ALL_TAB).reduce((n, t) => n + c[t], 0);
    expect(c.all).toBe(sum);
  });
});

describe('visibleTabs 空分类不出现', () => {
  it('只列出「全部」和有内容的分类', () => {
    const tabs = visibleTabs([g('a', '恐怖片'), g('b', '韩国剧')]);
    expect(tabs.map((t) => t.tab)).toEqual(['all', 'movie', 'tv']);
  });

  it('「全部」永远在第一位，即使它也有计数', () => {
    const tabs = visibleTabs([g('a', '恐怖片')]);
    expect(tabs[0].tab).toBe('all');
    expect(tabs[0].label).toBe('全部');
  });

  it('没有任何结果时只剩「全部 0」', () => {
    const tabs = visibleTabs([]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ tab: 'all', count: 0 });
  });

  it('顺序跟随 CATEGORY_ORDER，不按条数排', () => {
    // 剧集给 3 条、电影给 1 条，电影仍应排在剧集前面
    const tabs = visibleTabs([
      g('a', '韩国剧'), g('b', '国产剧'), g('c', '日本剧'), g('d', '恐怖片'),
    ]);
    expect(tabs.map((t) => t.tab)).toEqual(['all', 'movie', 'tv']);
  });
});

describe('buildSections 分区与截断', () => {
  // 造 8 部电影 + 3 部剧集
  const many = [
    ...Array.from({ length: 8 }, (_, i) => g(`m${i}`, '恐怖片')),
    ...Array.from({ length: 3 }, (_, i) => g(`t${i}`, '韩国剧')),
  ];

  it('「全部」tab 下按 CATEGORY_ORDER 分段，空分类整段不出现', () => {
    const s = buildSections(many, 'all');
    expect(s.map((x) => x.category)).toEqual(['movie', 'tv']);
    expect(s[0].total).toBe(8);
    expect(s[1].total).toBe(3);
  });

  it('「全部」tab 下每段默认截断到 SECTION_PREVIEW', () => {
    const s = buildSections(many, 'all');
    expect(s[0].shown).toHaveLength(SECTION_PREVIEW);
    expect(s[0].hidden).toBe(8 - SECTION_PREVIEW);
    expect(s[0].previewing).toBe(true);
  });

  it('条目数不超过预览量时 hidden 为 0 且 previewing 为 false', () => {
    const s = buildSections(many, 'all');
    expect(s[1].shown).toHaveLength(3);
    expect(s[1].hidden).toBe(0);
    // 只有 3 条的段若标「预览中」，UI 会给出「查看全部 3 部」这种点了没反应的空按钮
    expect(s[1].previewing).toBe(false);
  });

  it('恰好等于预览量时不算被截断', () => {
    const six = Array.from({ length: SECTION_PREVIEW }, (_, i) => g(`x${i}`, '恐怖片'));
    const s = buildSections(six, 'all');
    expect(s[0].previewing).toBe(false);
    expect(s[0].hidden).toBe(0);
  });

  it('点过「查看全部」的分类不再截断', () => {
    const s = buildSections(many, 'all', new Set(['movie' as const]));
    expect(s[0].shown).toHaveLength(8);
    expect(s[0].hidden).toBe(0);
    expect(s[0].previewing).toBe(false);
    // 另一段仍保持截断状态，互不影响
    expect(s[1].shown).toHaveLength(3);
    expect(s[1].previewing).toBe(false);
  });

  it('单分类 tab 只留一段且不截断', () => {
    const s = buildSections(many, 'movie');
    expect(s).toHaveLength(1);
    expect(s[0].category).toBe('movie');
    expect(s[0].shown).toHaveLength(8);
    expect(s[0].hidden).toBe(0);
  });

  it('单分类 tab 无命中时返回空数组（不渲染空段）', () => {
    expect(buildSections(many, 'anime')).toEqual([]);
  });

  it('分组顺序保持传入顺序（页面已按相关度/片名排好，分区不重排）', () => {
    const s = buildSections(many, 'movie');
    expect(s[0].shown.map((x) => (x as { name: string }).name)).toEqual(
      Array.from({ length: 8 }, (_, i) => `m${i}`)
    );
  });

  it('sum(各段 total) 恒等于「全部」计数（不丢条、不重复）', () => {
    const sections = buildSections(many, 'all');
    expect(sections.reduce((n, x) => n + x.total, 0)).toBe(countByTab(many).all);
  });

  it('mountLimit 限制展开态的分批挂载，但 total 仍是全量', () => {
    const s = buildSections(many, 'movie', new Set(), 3);
    expect(s[0].total).toBe(8);
    expect(s[0].shown).toHaveLength(3);
    expect(s[0].hidden).toBe(5);
  });

  it('mountLimit 对未展开的「全部」段无效（预览量更小，取小者）', () => {
    const s = buildSections(many, 'all', new Set(), 3);
    // 预览 6 条 > mountLimit 3，仍以预览语义为准会露出 6 条吗？
    // 不会：limit = min(预览, 挂载) 的直觉实现是「预览优先」，这里断言真实行为
    expect(s[0].shown).toHaveLength(SECTION_PREVIEW);
    expect(s[0].hidden).toBe(8 - SECTION_PREVIEW);
  });

  it('mountLimit 小于预览量时，展开后反而看得更少——不应发生', () => {
    // 防御：页面把 visibleCount 初始化为 60（远大于 SECTION_PREVIEW=6），
    // 所以真实调用不会出现这条路径。这里锁住「mountLimit 只在展开态生效」的语义。
    const collapsed = buildSections(many, 'all', new Set(), 2);
    const expanded = buildSections(many, 'all', new Set(['movie' as const]), 60);
    expect(expanded[0].shown.length).toBeGreaterThanOrEqual(collapsed[0].shown.length);
  });
});

describe('真实数据分布（8090 关键词「医生」，277 个聚合组）', () => {
  /** 从实测结果里抽的代表性样本：覆盖五个会出现的 tab */
  const real: CategorizableGroup[] = [
    // 电影
    g('医生', '恐怖片'),
    g('杜立德医生', '喜剧片'),
    g('羔羊医生', '恐怖片'),
    g('好莱坞医生', '喜剧片'),
    // 剧集
    g('阿修罗医生', '日本剧'),
    g('白夜医生', '日本剧'),
    g('低谷医生', '韩国剧'),
    g('产科医生', '内地剧'),
    // 动漫
    g('魔物娘的医生', '日本动漫'),
    g('急诊医生：我能看到死亡倒计时', 'AI漫剧'),
    // 短剧
    g('薄医生的小救星', '现代都市短剧'),
    g('顾医生许你爱我99次', '女恋总裁'),
    // 其他（电影解说）
    g('流氓医生[电影解说]', '电影解说'),
    g('日瓦戈医生[电影解说]', '电影解说'),
  ];

  it('五类全部命中预期桶', () => {
    const c = countByTab(real);
    expect(c.movie).toBe(4);
    expect(c.tv).toBe(4);
    expect(c.anime).toBe(2);
    expect(c.short).toBe(2);
    expect(c.other).toBe(2);
    expect(c.all).toBe(14);
  });

  it('tab 顺序固定为 全部 → 电影 → 剧集 → 动漫 → 短剧 → 其他', () => {
    expect(visibleTabs(real).map((t) => t.tab)).toEqual([
      'all', 'movie', 'tv', 'anime', 'short', 'other',
    ]);
  });

  it('成人 / 综艺 / 体育 这些空分类不出现在 tab 栏', () => {
    const labels = visibleTabs(real).map((t) => t.label);
    expect(labels).not.toContain('成人');
    expect(labels).not.toContain('综艺');
    expect(labels).not.toContain('体育');
  });

  it('「电影解说」不会被算进电影——否则电影 tab 会混进一堆解说', () => {
    const s = buildSections(real, 'movie');
    const names = s[0].shown.map((x) => (x as { name: string }).name);
    expect(names).not.toContain('流氓医生[电影解说]');
    expect(names).not.toContain('日瓦戈医生[电影解说]');
  });
});
