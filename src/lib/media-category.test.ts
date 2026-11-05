import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  categoryOf,
  groupByCategory,
  isAccessoryCategory,
  type MediaCategory,
} from './media-category';

/**
 * 分类判定的回归基线。
 *
 * 用例来源：
 * 1. 8090 生产库 watchlist 表的 13 条真实收藏（type_name 实取）；
 * 2. 非凡 / 暴风两个采集站 `ac=list` 实取的 52 个去重 type_name；
 * 3. 人工构造的边界 —— 重点是「哪些必须不能被判成动漫」。
 */

/** 采集站真实类型词表（ac=list 实取，已去重） */
const SOURCE_TYPES = [
  '电影片', '连续剧', '综艺片', '动漫片', '动作片', '喜剧片', '爱情片', '科幻片',
  '恐怖片', '剧情片', '战争片', '国产剧', '香港剧', '韩国剧', '欧美剧', '记录片',
  '台湾剧', '日本剧', '海外剧', '泰国剧', '大陆综艺', '港台综艺', '日韩综艺',
  '欧美综艺', '国产动漫', '日韩动漫', '欧美动漫', '港台动漫', '海外动漫',
  '伦理片', '短剧',
  '纪录片', '理论片', '动画片', '电影解说', '预告片', '体育赛事', '足球', '篮球',
  '网球', '斯诺克', '短剧大全', '重生民国', '穿越年代', '现代言情', '反转爽文',
  '女恋总裁', '闪婚离婚', '都市脑洞', '古装仙侠', '福利', 'AI漫剧',
];

describe('categoryOf 采集站类型词表全覆盖', () => {
  it('52 个真实类型全部能落到某个分类，没有一个掉进 undefined', () => {
    for (const t of SOURCE_TYPES) {
      const c = categoryOf(t);
      expect(CATEGORY_ORDER, `${t} 判出了非法分类 ${c}`).toContain(c);
    }
    expect(new Set(SOURCE_TYPES).size).toBe(SOURCE_TYPES.length);
  });

  it('动漫类全部命中，包括以「片」结尾的「动漫片/动画片/AI漫剧」', () => {
    const animeTypes = SOURCE_TYPES.filter((t) => t.includes('动漫') || t.includes('动画'));
    for (const t of animeTypes) {
      expect(categoryOf(t), `${t} 应判为动漫`).toBe('anime');
    }
    // 这几个最容易掉进「片」规则
    expect(categoryOf('动漫片')).toBe('anime');
    expect(categoryOf('动画片')).toBe('anime');
    expect(categoryOf('AI漫剧')).toBe('anime');
  });

  it('电影类：所有「…片」结尾的（除动漫片/伦理片/预告片）都归电影', () => {
    for (const t of ['电影片', '动作片', '喜剧片', '恐怖片', '科幻片', '剧情片', '战争片', '爱情片', '纪录片', '记录片']) {
      expect(categoryOf(t), `${t} 应判为电影`).toBe('movie');
    }
  });

  it('剧集类：所有「…剧」结尾的都归剧集', () => {
    for (const t of ['连续剧', '国产剧', '香港剧', '韩国剧', '欧美剧', '日本剧', '台湾剧', '海外剧', '泰国剧']) {
      expect(categoryOf(t), `${t} 应判为剧集`).toBe('tv');
    }
  });

  it('综艺 / 体育 / 短剧 / 成人各自归位', () => {
    for (const t of ['综艺片', '大陆综艺', '港台综艺', '日韩综艺', '欧美综艺']) {
      expect(categoryOf(t)).toBe('variety');
    }
    for (const t of ['体育赛事', '足球', '篮球', '网球', '斯诺克']) {
      expect(categoryOf(t)).toBe('sport');
    }
    for (const t of ['短剧', '短剧大全', '重生民国', '穿越年代', '现代言情', '反转爽文', '女恋总裁', '闪婚离婚', '都市脑洞', '古装仙侠']) {
      expect(categoryOf(t), `${t} 应判为短剧`).toBe('short');
    }
    for (const t of ['伦理片', '理论片', '福利']) {
      expect(categoryOf(t), `${t} 应判为成人`).toBe('adult');
    }
  });
});

describe('categoryOf 关键防错：不能靠「包含剧/片」粗判', () => {
  it('剧情片 / 喜剧片 含「剧」但是电影（按后缀判才对）', () => {
    expect(categoryOf('剧情片')).toBe('movie');
    expect(categoryOf('喜剧片')).toBe('movie');
  });

  it('预告片 / 电影解说 / 电影片 里，「电影片」是电影，前两个是附属物', () => {
    expect(categoryOf('电影片')).toBe('movie');
    expect(isAccessoryCategory('预告片')).toBe(true);
    expect(isAccessoryCategory('电影解说')).toBe(true);
  });

  it('动画片 判动漫而不是电影（动漫规则必须先于片后缀）', () => {
    expect(categoryOf('动画片')).toBe('anime');
  });

  it('伦理片 判成人而不是电影', () => {
    expect(categoryOf('伦理片')).toBe('adult');
    expect(categoryOf('理论片')).toBe('adult');
  });
});

describe('categoryOf 边界与兜底', () => {
  it('空 / undefined / 纯空白 → 其他，绝不返回 undefined', () => {
    expect(categoryOf(undefined)).toBe('other');
    expect(categoryOf('')).toBe('other');
    expect(categoryOf('   ')).toBe('other');
  });

  it('认不出的类型落「其他」，不会丢', () => {
    expect(categoryOf('未知分类ABC')).toBe('other');
    expect(categoryOf('xxx')).toBe('other');
  });

  it('非标准写法：无后缀但含主类字，仍归主类', () => {
    expect(categoryOf('搞笑剧')).toBe('tv');
    expect(categoryOf('惊悚片儿')).toBe('movie');
  });
});

describe('真实收藏（8090 生产库 13 条）', () => {
  const REAL: { title: string; type: string; status: string }[] = [
    { title: '招魂', type: '恐怖片', status: 'watched' },
    { title: '招魂2', type: '恐怖片', status: 'watched' },
    { title: '招魂3', type: '悬疑片', status: 'watched' },
    { title: '招魂4：终章', type: '恐怖片', status: 'watched' },
    { title: '潜伏', type: '恐怖片', status: 'watched' },
    { title: '潜伏2', type: '恐怖片', status: 'wish' },
    { title: '安娜贝尔', type: '恐怖片', status: 'watched' },
    { title: '死寂', type: '悬疑片', status: 'watched' },
    { title: '看不见的客人', type: '剧情片', status: 'watched' },
    { title: '仙逆', type: '国产动漫', status: 'watched' },
    { title: '凡人修仙传', type: '国产动漫', status: 'watched' },
    { title: '无人生还', type: '欧美剧', status: 'wish' },
    { title: '末路兼职', type: '韩国剧', status: 'watching' },
  ];

  it('13 条判出 电影 9 / 剧集 2 / 动漫 2（9+2+2=13，一条不丢）', () => {
    const buckets = groupByCategory(REAL, (r) => r.type);
    const by = Object.fromEntries(buckets.map((b) => [b.category, b.count]));
    expect(by.movie).toBe(9);
    expect(by.tv).toBe(2);
    expect(by.anime).toBe(2);
    expect(by.variety).toBe(0);
    // 总数守恒：所有分区加起来必须等于输入条数
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(REAL.length);
  });

  it('仙逆 / 凡人修仙传 落在动漫分区（不被恐怖片那条规则吃掉）', () => {
    const buckets = groupByCategory(REAL, (r) => r.type);
    const anime = buckets.find((b) => b.category === 'anime')!;
    expect(anime.items.map((i) => i.title).sort()).toEqual(['仙逆', '凡人修仙传'].sort());
  });

  it('「已看」栏（10 条）拆成 电影 8 / 动漫 2', () => {
    const watched = REAL.filter((r) => r.status === 'watched');
    const buckets = groupByCategory(watched, (r) => r.type);
    const by = Object.fromEntries(buckets.map((b) => [b.category, b.count]));
    expect(by.movie).toBe(8);
    expect(by.anime).toBe(2);
  });

  it('分区顺序固定：电影 → 剧集 → 动漫 → 综艺 → …', () => {
    const buckets = groupByCategory(REAL, (r) => r.type);
    expect(buckets.map((b) => b.category)).toEqual([...CATEGORY_ORDER]);
  });

  it('空分区也返回（方案 D 要显示「0」的块头）', () => {
    const buckets = groupByCategory(REAL, (r) => r.type);
    const empty = buckets.filter((b) => b.count === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const b of empty) {
      expect(b.items).toEqual([]);
      expect(b.label).toBe(CATEGORY_LABEL[b.category]);
    }
  });

  it('分区内保持传入顺序（调用方已按 updatedAt 倒序）', () => {
    const buckets = groupByCategory(REAL, (r) => r.type);
    const movie = buckets.find((b) => b.category === 'movie')!;
    expect(movie.items.map((i) => i.title)).toEqual([
      '招魂', '招魂2', '招魂3', '招魂4：终章', '潜伏', '潜伏2', '安娜贝尔', '死寂', '看不见的客人',
    ]);
  });
});

describe('groupByCategory 附属物剔除', () => {
  const items = [
    { title: '招魂', type: '恐怖片' },
    { title: '招魂[电影解说]', type: '电影解说' },
    { title: '招魂4[预告片]', type: '预告片' },
    { title: '仙逆', type: '国产动漫' },
  ];

  it('默认剔除附属物（解说/预告不是一部作品）', () => {
    const buckets = groupByCategory(items, (i) => i.type);
    const all = buckets.flatMap((b) => b.items.map((i) => i.title));
    expect(all).toEqual(['招魂', '仙逆']);
  });

  it('excludeAccessory=false 时保留，落到电影分区', () => {
    const buckets = groupByCategory(items, (i) => i.type, false);
    const all = buckets.flatMap((b) => b.items.map((i) => i.title));
    expect(all).toContain('招魂[电影解说]');
    expect(all).toContain('招魂4[预告片]');
  });
});

describe('「动漫」口径：纯 animation（选项 1）', () => {
  it('动画电影与连载番剧同桶，不靠集数二次判断', () => {
    // 这是刻意的口径：采集站只有「动画片」一个标签，
    // 引入集数会把「全集打包成 1 个地址」的连载动画误判成电影。
    expect(categoryOf('动画片')).toBe('anime');   // 《你的名字》这类院线动画
    expect(categoryOf('国产动漫')).toBe('anime'); // 《仙逆》这类连载
    expect(categoryOf('欧美动漫')).toBe('anime'); // 《海绵宝宝》这类
  });

  it('分类函数不接收集数，避免口径漂移', () => {
    // 签名只有一个参数：typeName。集数变化不会影响分类结果。
    expect(categoryOf.length).toBe(1);
  });
});
