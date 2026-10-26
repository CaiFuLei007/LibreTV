'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 主题上下文：亮暗（light / dark / system）+ 调色板（palette）。
 * 两者都持久化到 localStorage；亮暗写到 html.dark 类，调色板写到 html[data-palette]。
 * 首屏由 layout 中的内联脚本先行设置，避免闪烁；此处负责后续切换。
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'libretv-theme';

/** 可用调色板：cyber 是旧版默认，其余四套按设计参考重设 */
export type PaletteId = 'cyber' | 'cinema' | 'graphite' | 'violet' | 'amber';
const PALETTE_KEY = 'libretv-palette';
const DEFAULT_PALETTE: PaletteId = 'cyber';

export interface PaletteMeta {
  id: PaletteId;
  name: string;
  hint: string;
  /** 展示用的四个色块（亮色态） */
  swatch: [string, string, string, string];
}

export const PALETTES: PaletteMeta[] = [
  {
    id: 'cyber',
    name: '赛博影视',
    hint: '旧版默认：深蓝黑 + 霓虹蓝',
    swatch: ['#0b101a', '#141c29', '#00b8e6', '#e6f2ff'],
  },
  {
    id: 'cinema',
    name: '影院黑',
    hint: 'Netflix 派：近黑画布 + 签名红，无彩色发光',
    swatch: ['#141414', '#181818', '#e50914', '#b3b3b3'],
  },
  {
    id: 'graphite',
    name: '炭灰冷青',
    hint: '保守升级：中性炭灰 + 冷青点缀',
    swatch: ['#121215', '#18181b', '#22d3ee', '#f4f4f5'],
  },
  {
    id: 'violet',
    name: '深紫番剧',
    hint: 'Laftel 派：深紫黑 + 番剧紫',
    swatch: ['#0f0f14', '#191922', '#6e58ff', '#f7f7f7'],
  },
  {
    id: 'amber',
    name: '琥珀暖墨',
    hint: '复古影评：暖墨底 + 琥珀金',
    swatch: ['#1a1613', '#221d18', '#e0a94a', '#f0e9e0'],
  },
];

export const PALETTE_LABEL: Record<PaletteId, string> = {
  cyber: '赛博影视',
  cinema: '影院黑',
  graphite: '炭灰冷青',
  violet: '深紫番剧',
  amber: '琥珀暖墨',
};

interface ThemeContextValue {
  theme: ThemeChoice;
  resolved: 'light' | 'dark';
  palette: PaletteId;
  setTheme: (t: ThemeChoice) => void;
  setPalette: (p: PaletteId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  resolved: 'dark',
  palette: DEFAULT_PALETTE,
  setTheme: () => {},
  setPalette: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(choice: ThemeChoice): 'light' | 'dark' {
  const resolved = choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  return resolved;
}

function applyPalette(p: PaletteId): PaletteId {
  // cyber 是 CSS 里的默认值（:root / .dark），不必挂属性；挂上也无害，便于选择器精确匹配
  document.documentElement.setAttribute('data-palette', p);
  return p;
}

function readPalette(): PaletteId {
  const raw = localStorage.getItem(PALETTE_KEY) as PaletteId | null;
  return raw && PALETTES.some((p) => p.id === raw) ? raw : DEFAULT_PALETTE;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>('dark');
  const [resolved, setResolved] = useState<'light' | 'dark'>('dark');
  const [palette, setPaletteState] = useState<PaletteId>(DEFAULT_PALETTE);

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as ThemeChoice | null) || 'dark';
    setThemeState(stored);
    setResolved(apply(stored));
    setPaletteState(applyPalette(readPalette()));

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const current = (localStorage.getItem(STORAGE_KEY) as ThemeChoice | null) || 'dark';
      if (current === 'system') {
        setResolved(apply('system'));
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((t: ThemeChoice) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
    setResolved(apply(t));
  }, []);

  const setPalette = useCallback((p: PaletteId) => {
    localStorage.setItem(PALETTE_KEY, p);
    setPaletteState(applyPalette(p));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, palette, setTheme, setPalette }}>
      {children}
    </ThemeContext.Provider>
  );
}

function SunIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

/** 亮暗切换按钮：在 light → dark → system 三态间循环 */
export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const next: ThemeChoice = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const label = theme === 'system' ? '跟随系统（当前深色）' : theme === 'dark' ? '深色' : '浅色';
  const nextLabel = next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统';

  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={`主题：${label}，点击切换为${nextLabel}`}
      aria-label={`切换主题，当前 ${label}`}
      onClick={() => setTheme(next)}
    >
      {theme === 'system' ? <SystemIcon /> : resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

/** 调色板选择器：一排色卡，点击即切换（供设置面板使用） */
export function PalettePicker() {
  const { palette, setPalette, resolved } = useTheme();
  return (
    <div role="radiogroup" aria-label="配色方案" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {PALETTES.map((p) => {
        const active = p.id === palette;
        return (
          <button
            key={p.id}
            role="radio"
            aria-checked={active}
            onClick={() => setPalette(p.id)}
            className={[
              'flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
              active
                ? 'border-accent bg-accent/10'
                : 'border-line bg-chip hover:bg-hover',
            ].join(' ')}
          >
            <span className="flex shrink-0 overflow-hidden rounded" aria-hidden="true">
              {p.swatch.map((c, i) => (
                <span key={i} className="h-8 w-3" style={{ backgroundColor: c }} />
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={['text-sm font-medium', active ? 'text-accent' : 'text-content'].join(' ')}>
                  {p.name}
                </span>
                {active && (
                  <svg className="w-4 h-4 text-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
              <span className="block text-[11px] text-faint truncate">{p.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 一行提示：当前亮暗态，避免用户以为切了色卡却没生效 */
export function PaletteHint() {
  const { resolved, palette } = useTheme();
  return (
    <p className="text-[11px] text-faint mt-2">
      当前为{resolved === 'dark' ? '深色' : '浅色'}模式，配色「{PALETTE_LABEL[palette]}」。
      每套配色都同时提供亮/深两种取值，用顶栏的主题按钮切换。
    </p>
  );
}
