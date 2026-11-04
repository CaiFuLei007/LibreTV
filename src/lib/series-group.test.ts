import { describe, expect, it } from 'vitest';
import {
  groupBySeries,
  isAccessoryTitle,
  matchGroup,
  normalizeSeriesTitle,
  parseSeriesPart,
  stripSeriesNoise,
} from './series-group';

/**
 * 归组判定的回归基线。
 *
 * 用例来源分三类：
 * 1. 8090 上真实收藏（12 条）—— 用户的真实数据；
 * 2. 非凡/暴风两个采集站对「招魂」的实搜返回 —— 真实片名形态，含解说/预告；
 * 3. 人工构造的错组陷阱 —— 保证「不可错组」这条硬约束不被后续改动破坏。
 */

const titles = (items: { title: string }[]) => items.map((i) => i.title);

describe('normalizeSeriesTitle / stripSeriesNoise', () => {
  it('全角空格与全角标点归一', () => {
    expect(normalizeSeriesTitle('招魂　2')).toBe('招魂 2');
    expect(normalizeSeriesTitle('招魂４：终章')).toBe('招魂4:终章');
  });

  it('剥掉清晰度/语言标注，可叠多层', () => {
    expect(stripSeriesNoise('招魂2 HD中字')).toBe('招魂2');
    expect(stripSeriesNoise('招魂2（国语版）')).toBe('招魂2');
    expect(stripSeriesNoise('死寂 [HD]')).toBe('死寂');
  });

  it('剥掉括号年份，但不碰片名里的裸数字', () => {
    expect(stripSeriesNoise('招魂(2013)')).toBe('招魂');
    expect(stripSeriesNoise('招魂2[2016]')).toBe('招魂2');
    // 裸数字是片名本体，必须原样保留
    expect(stripSeriesNoise('2012')).toBe('2012');
    expect(stripSeriesNoise('1408幻影凶间')).toBe('1408幻影凶间');
  });
});

describe('isAccessoryTitle 附属物识别', () => {
  it('解说 / 预告 / 花絮都算附属物', () => {
    expect(isAccessoryTitle('招魂[电影解说]')).toBe(true);
    expect(isAccessoryTitle('招魂2 The Conjuring 2[电影解说]')).toBe(true);
    expect(isAccessoryTitle('招魂4[预告片]')).toBe(true);
    expect(isAccessoryTitle('招魂3 花絮')).toBe(true);
  });

  it('正常片名不算附属物', () => {
    expect(isAccessoryTitle('招魂')).toBe(false);
    expect(isAccessoryTitle('招魂4：终章')).toBe(false);
    expect(isAccessoryTitle('看不见的客人')).toBe(false);
  });
});

describe('parseSeriesPart 部号解析', () => {
  it('尾部裸数字', () => {
    expect(parseSeriesPart('招魂2')).toEqual({ base: '招魂', part: 2 });
    expect(parseSeriesPart('叶问 4')).toEqual({ base: '叶问', part: 4 });
    expect(parseSeriesPart('电锯惊魂10')).toEqual({ base: '电锯惊魂', part: 10 });
  });

  it('数字 + 副标题：冒号前带部号才切', () => {
    expect(parseSeriesPart('招魂4：终章')).toEqual({ base: '招魂', part: 4 });
    expect(parseSeriesPart('复仇者联盟3：无限战争')).toEqual({ base: '复仇者联盟', part: 3 });
    expect(parseSeriesPart('指环王1：护戒使者')).toEqual({ base: '指环王', part: 1 });
  });

  it('中文数字与第 N 部 / 第 N 季', () => {
    expect(parseSeriesPart('招魂第二部')).toEqual({ base: '招魂', part: 2 });
    expect(parseSeriesPart('庆余年 第2季')).toEqual({ base: '庆余年', part: 2 });
  });

  it('只有副标题、没有部号 → 不切（否则剧场版会被并成一组）', () => {
    expect(parseSeriesPart('名侦探柯南：绀青之拳')).toBeUndefined();
    expect(parseSeriesPart('指环王：护戒使者')).toBeUndefined();
    expect(parseSeriesPart('异形：契约')).toBeUndefined();
  });

  it('整串数字是片名，不是「基名+部号」', () => {
    expect(parseSeriesPart('2012')).toBeUndefined();
    expect(parseSeriesPart('1917')).toBeUndefined();
    expect(parseSeriesPart('2046')).toBeUndefined();
  });

  it('部号上限 99，罗马数字不认', () => {
    expect(parseSeriesPart('某片100')).toBeUndefined();
    expect(parseSeriesPart('洛奇II')).toBeUndefined();
  });
});

describe('groupBySeries 真实收藏（8090 上的 12 条）', () => {
  const REAL = [
    '仙逆', '凡人修仙传', '安娜贝尔', '招魂', '招魂2', '招魂3', '招魂4：终章',
    '无人生还', '死寂', '潜伏', '潜伏2', '看不见的客人',
  ];

  it('招魂 4 部成组、潜伏 2 部成组，其余全散', () => {
    const r = groupBySeries(REAL, (t) => t);
    expect(r.groups.map((g) => g.title).sort()).toEqual(['招魂', '潜伏']);
    const zh = r.groups.find((g) => g.title === '招魂')!;
    expect(titles(zh.members)).toEqual(['招魂', '招魂2', '招魂3', '招魂4：终章']);
    expect(zh.members.map((m) => m.part)).toEqual([1, 2, 3, 4]);
    expect(r.singles.sort()).toEqual(
      ['仙逆', '凡人修仙传', '安娜贝尔', '无人生还', '死寂', '看不见的客人'].sort()
    );
  });
});

describe('groupBySeries 真实采集站片名（非凡 / 暴风实搜结果）', () => {
  const FROM_SOURCES = [
    '招魂', '招魂2', '招魂3', '招魂4：终章',
    '招魂录影', '招魂大派对', '招魂夜', '骇故事之招魂',
    '招魂[电影解说]', '招魂2 The Conjuring 2[电影解说]', '招魂4[预告片]',
    '招魂3[电影解说]', '招魂4：终章[电影解说]',
  ];

  it('只收 4 部正片；解说 / 预告不混进组', () => {
    const r = groupBySeries(FROM_SOURCES, (t) => t);
    expect(r.groups).toHaveLength(1);
    expect(titles(r.groups[0].members)).toEqual([
      '招魂', '招魂2', '招魂3', '招魂4：终章',
    ]);
  });

  it('同 IP 的其他片不误吃', () => {
    const r = groupBySeries(FROM_SOURCES, (t) => t);
    for (const t of ['招魂夜', '招魂录影', '招魂大派对', '骇故事之招魂']) {
      expect(r.singles).toContain(t);
    }
  });

  it('附属物仍留在列表里（用户可能就是来找解说的）', () => {
    const r = groupBySeries(FROM_SOURCES, (t) => t);
    expect(r.singles).toContain('招魂4[预告片]');
    expect(r.singles).toContain('招魂3[电影解说]');
  });
});

describe('groupBySeries 不可错组（硬约束）', () => {
  const CASES: { name: string; input: string[]; forbidden: [string, string][] }[] = [
    {
      name: '同宇宙不同系列',
      input: ['招魂', '招魂2', '安娜贝尔', '修女'],
      forbidden: [['招魂', '安娜贝尔'], ['招魂', '修女']],
    },
    {
      name: '同 IP 不同作',
      input: ['叶问', '叶问2', '叶问3', '叶问：终极一战'],
      forbidden: [['叶问2', '叶问：终极一战']],
    },
    {
      name: '外传不是续集',
      input: ['速度与激情', '速度与激情2', '速度与激情：特别行动'],
      forbidden: [['速度与激情2', '速度与激情：特别行动']],
    },
    {
      name: '纯副标题不并',
      input: ['名侦探柯南：绀青之拳', '名侦探柯南：万圣节的新娘', '名侦探柯南：黑铁的鱼影'],
      forbidden: [['名侦探柯南：绀青之拳', '名侦探柯南：万圣节的新娘']],
    },
    {
      name: '数字片名不并',
      input: ['2012', '1917', '2046'],
      forbidden: [['2012', '1917'], ['1917', '2046']],
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const r = groupBySeries(c.input, (t) => t);
      // 约束是「a 与 b 不能落在同一个组里」，而不是「a 不能出现在任何组里」
      for (const [a, b] of c.forbidden) {
        const host = r.groups.find((g) => titles(g.members).includes(a));
        if (!host) continue; // a 自己没成组，自然谈不上被错误合并
        expect(
          titles(host.members),
          `「${a}」和「${b}」被错误并进了同一组`
        ).not.toContain(b);
      }
      // 真续集仍要正确成组，避免「为了不错组把一切都拆散」
      if (c.name === '同 IP 不同作') {
        expect(titles(r.groups[0].members)).toEqual(['叶问', '叶问2', '叶问3']);
      }
      if (c.name === '外传不是续集') {
        expect(titles(r.groups[0].members)).toEqual(['速度与激情', '速度与激情2']);
      }
      if (c.name === '同宇宙不同系列') {
        expect(titles(r.groups[0].members)).toEqual(['招魂', '招魂2']);
      }
    });
  }
});

describe('groupBySeries 边界', () => {
  it('单条不成组', () => {
    const r = groupBySeries(['招魂'], (t) => t);
    expect(r.groups).toHaveLength(0);
    expect(r.singles).toEqual(['招魂']);
  });

  it('缺第一部也能成组（只有 2、3、4）', () => {
    const r = groupBySeries(['招魂2', '招魂3', '招魂4：终章'], (t) => t);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].members.map((m) => m.part)).toEqual([2, 3, 4]);
  });

  it('显式第 1 部与无部号视为同一部', () => {
    const r = groupBySeries(['招魂', '招魂1', '招魂2'], (t) => t);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].members.map((m) => m.part)).toEqual([1, 1, 2]);
  });

  it('同一部片的多种标注各占一行（不合并、不丢失）', () => {
    const r = groupBySeries(['招魂2', '招魂2 HD中字', '招魂2（国语版）'], (t) => t);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].size).toBe(3);
    expect(titles(r.groups[0].members)).toContain('招魂2 HD中字');
  });

  it('组内按部号升序，即使输入乱序', () => {
    const r = groupBySeries(['招魂4：终章', '招魂2', '招魂', '招魂3'], (t) => t);
    expect(titles(r.groups[0].members)).toEqual(['招魂', '招魂2', '招魂3', '招魂4：终章']);
  });
});

describe('matchGroup 搜索命中', () => {
  const r = groupBySeries(['招魂', '招魂2', '招魂3', '安娜贝尔'], (t) => t);

  it('命中组标题', () => {
    const m = matchGroup(r.groups[0], '招魂');
    expect(m.hit).toBe(true);
    expect(m.memberTitles).toHaveLength(3);
  });

  it('命中组内成员时给出该成员，供 UI 高亮', () => {
    const m = matchGroup(r.groups[0], '招魂3');
    expect(m.hit).toBe(true);
    expect(m.memberTitles).toEqual(['招魂3']);
  });

  it('不相关关键词不命中', () => {
    expect(matchGroup(r.groups[0], '安娜').hit).toBe(false);
  });
});
