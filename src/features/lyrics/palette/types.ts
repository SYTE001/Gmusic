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

export type PresetName = "calm" | "dim" | "flow" | "balanced";

export type BackgroundTier = "full" | "lite" | "static";

export type PresetConfig = {
  name: PresetName;
  blobCount: number;
  duration: number; // seconds for keyframe loop
  blobOpacity: number;
  scrimTop: number;
  scrimBottom: number;
  travelScale: number;
};

export type LyricsPalette = {
  coverKey: string;
  baseColor: string; // CSS color string (hsl)
  blobColors: [string, string, string, string]; // 4 blob colors (hsl)
  accentColor: string; // ~70% lightness accent
  preset: PresetName;
  presetConfig: PresetConfig;
  scrimTop: number;
  scrimBottom: number;
  worstCaseContrast: number;
  averageLuminance: number;
};
