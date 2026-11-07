export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type HslColor = {
  h: number;
  s: number;
  l: number;
};

export type ColorCluster = {
  rgb: RgbColor;
  hsl: HslColor;
  population: number;
  luminance: number;
  score: number;
};

export type CoverCategory = "light" | "saturated" | "dark" | "grayscale" | "fallback";

export type LyricsPalette = {
  coverKey: string;
  category: CoverCategory;
  /** Solid background color (`--bg`, hsl string) */
  bg: string;
  bgHsl: HslColor;
  bgRgb: RgbColor;
  /** Active lyric line color (`--lyric-active`, `#ffffff`) */
  lyricActive: string;
  /** Inactive lyric line color (`--lyric-inactive`, hsl string with >= 3:1 contrast against `--bg`) */
  lyricInactive: string;
  /** UI secondary text / control icons (`--text-secondary`, >= 4.5:1 contrast against `--bg`) */
  textSecondary: string;
  /** UI muted text / time labels (`--text-muted`, >= 4.5:1 contrast against `--bg`) */
  textMuted: string;
  /** Accent color (`--accent`, only used for non-text elements like progress bar) */
  accent: string;
  /** Computed WCAG contrast ratios against `--bg` */
  contrasts: {
    active: number;
    inactive: number;
    uiText: number;
  };
};
