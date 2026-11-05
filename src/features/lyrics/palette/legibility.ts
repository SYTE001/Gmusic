import { contrastRatio, hslToRgb, hslToString, relativeLuminance } from "./colorUtils";
import type { ColorCluster, CoverCategory, HslColor, LyricsPalette, RgbColor } from "./types";

const MIN_ACTIVE_CONTRAST = 7.0;
const MIN_INACTIVE_CONTRAST = 3.0;
const MIN_UI_TEXT_CONTRAST = 4.5;

const WHITE_RGB: RgbColor = { r: 255, g: 255, b: 255 };
const WHITE_LUM = relativeLuminance(WHITE_RGB);

/**
 * Selects a single flat, album-adaptive background color and derives contrast-verified
 * foreground tokens (`--bg`, `--lyric-active`, `--lyric-inactive`, `--accent`, plus UI text tokens).
 *
 * Rules (Task §3 & §4):
 * - Light / white / pastel cover (`avg lightness > 0.7` or low saturation): near-black, neutral
 *   or with a very faint tint of the cover hue (`L` about `6–9%`).
 * - Saturated cover (red, blue, green, etc.): deep dark version of that hue, clearly recognizable
 *   as the album color (e.g. red -> `hsl(h, 60–70%, 12–18%)`), visibly different from neutral.
 * - Dark cover: take its hue and lift slightly so it is not pure black (`L` about `10–16%`), keep some saturation.
 * - Grayscale cover: neutral charcoal (`L` about `8–12%`).
 * - Balance rule: use the most color the album has, as long as contrast passes.
 * - Contrast enforced in code:
 *   - Active lyric line (`#ffffff`) vs `--bg` >= 7:1
 *   - Inactive lyric line vs `--bg` >= 3:1
 *   - Title, artist, time labels, control icons vs `--bg` >= 4.5:1
 */
export function selectSolidPalette(
  clusters: ColorCluster[],
  coverKey: string,
): LyricsPalette {
  if (clusters.length === 0) {
    return createFallbackPalette(coverKey);
  }

  // Population-weighted average lightness and saturation across the image
  const totalPop = clusters.reduce((sum, c) => sum + c.population, 0) || 1;
  const avgLightness = clusters.reduce((sum, c) => sum + c.hsl.l * c.population, 0) / totalPop;
  const avgSaturation = clusters.reduce((sum, c) => sum + c.hsl.s * c.population, 0) / totalPop;

  // Most meaningful cluster (scored by population + saturation with border penalty)
  const meaningful = clusters[0];
  const maxMeaningfulSat = meaningful.hsl.s;
  const meaningfulPop = meaningful.population;

  // Does the cover have a genuinely saturated subject (even inside a white border)?
  const hasStrongColorCluster =
    maxMeaningfulSat >= 0.35 &&
    meaningfulPop >= 0.12 &&
    meaningful.hsl.l >= 0.15 &&
    meaningful.hsl.l <= 0.85;

  let category: CoverCategory;
  let candidateBg: HslColor;

  // 1. Grayscale cover (all clusters have very low saturation, mid-range lightness)
  const maxSat = Math.max(...clusters.map((c) => c.hsl.s));
  if (maxSat < 0.12 && avgLightness <= 0.78 && avgLightness >= 0.14) {
    category = "grayscale";
    candidateBg = {
      h: meaningful.hsl.h,
      s: Math.min(0.05, maxSat),
      l: 0.10, // L about 8-12%
    };
  }
  // 2. Light / white / pastel cover (avg lightness > 0.7 or low saturation on bright cover, without a strong saturated subject)
  else if ((avgLightness > 0.70 && !hasStrongColorCluster) || (avgLightness > 0.62 && avgSaturation < 0.28 && !hasStrongColorCluster)) {
    category = "light";
    // Near-black, neutral or with a very faint tint of the cover hue (L about 6-9%)
    const faintSat = maxSat < 0.08 ? 0 : Math.min(0.18, maxMeaningfulSat * 0.45);
    candidateBg = {
      h: meaningful.hsl.h,
      s: faintSat,
      l: 0.07, // 7% lightness
    };
  }
  // 3. Dark cover (overall dark and dominant cluster is dark, L < 0.20)
  else if (avgLightness < 0.18 && meaningful.hsl.l < 0.20) {
    category = "dark";
    // Lift slightly so it is not pure black (L about 10-16%), keep some saturation
    const liftedSat = maxSat < 0.06 ? 0.04 : Math.max(0.22, Math.min(0.55, maxMeaningfulSat));
    candidateBg = {
      h: meaningful.hsl.h,
      s: liftedSat,
      l: 0.12, // 10-16%
    };
  }
  // 4. Saturated cover (red, blue, green, etc.) — including a red subject inside a white border
  else if (hasStrongColorCluster || maxMeaningfulSat >= 0.32) {
    category = "saturated";
    // Deep dark version of that hue, clearly recognizable as the album color:
    // Saturation ~ 60-70% (or up to what the cover has), Lightness ~ 12-18%
    const targetSat = Math.max(0.60, Math.min(0.72, maxMeaningfulSat));
    const targetLight = 0.16; // Starts at 16% (within 12-18%), stepped down if needed for >= 7:1 contrast
    candidateBg = {
      h: meaningful.hsl.h,
      s: targetSat,
      l: targetLight,
    };
  }
  // 5. Remaining dark covers (avgLightness < 0.25)
  else if (avgLightness < 0.25) {
    category = "dark";
    const liftedSat = maxSat < 0.06 ? 0.04 : Math.max(0.22, Math.min(0.55, maxMeaningfulSat));
    candidateBg = {
      h: meaningful.hsl.h,
      s: liftedSat,
      l: 0.12,
    };
  }
  // 5. Low-saturation midtone cover -> treat as light/neutral dark
  else {
    category = "grayscale";
    candidateBg = {
      h: meaningful.hsl.h,
      s: Math.min(0.14, maxMeaningfulSat),
      l: 0.09,
    };
  }

  return buildContrastVerifiedPalette(candidateBg, meaningful.hsl, category, coverKey);
}

/**
 * Enforces WCAG contrast targets in code:
 * - Active lyric (`#ffffff`) >= 7:1 against `--bg` (steps lightness down in 0.5% increments if needed)
 * - Inactive lyric derived from `--bg` hue so contrast >= 3:1 against `--bg`
 * - UI text/icons (`--text-secondary`, `--text-muted`) >= 4.5:1 against `--bg`
 */
function buildContrastVerifiedPalette(
  initialBg: HslColor,
  dominantHsl: HslColor,
  category: CoverCategory,
  coverKey: string,
): LyricsPalette {
  const bgHsl: HslColor = {
    h: Math.round(initialBg.h) % 360,
    s: Math.max(0, Math.min(1, initialBg.s)),
    l: Math.max(0.04, Math.min(0.22, initialBg.l)),
  };

  let bgRgb = hslToRgb(bgHsl);
  let bgLum = relativeLuminance(bgRgb);
  let activeContrast = contrastRatio(WHITE_LUM, bgLum);

  // Step lightness down (and saturation slightly if needed) until active line (#ffffff) >= 7:1
  let guard = 0;
  while (activeContrast < MIN_ACTIVE_CONTRAST && guard < 40) {
    guard++;
    if (bgHsl.l > 0.06) {
      bgHsl.l = Math.max(0.05, bgHsl.l - 0.005);
    } else {
      bgHsl.s = Math.max(0, bgHsl.s - 0.04);
    }
    bgRgb = hslToRgb(bgHsl);
    bgLum = relativeLuminance(bgRgb);
    activeContrast = contrastRatio(WHITE_LUM, bgLum);
  }

  // Derive inactive lyric color tinted with the cover hue so contrast >= 3:1 (target ~3.6:1 for comfortable reading)
  const inactiveHsl: HslColor = {
    h: bgHsl.h,
    s: bgHsl.s > 0.15 ? Math.min(0.32, bgHsl.s * 0.45) : bgHsl.s * 0.5,
    l: Math.max(0.54, bgHsl.l + 0.42),
  };

  let inactiveRgb = hslToRgb(inactiveHsl);
  let inactiveContrast = contrastRatio(relativeLuminance(inactiveRgb), bgLum);
  guard = 0;
  while (inactiveContrast < Math.max(MIN_INACTIVE_CONTRAST, 3.3) && guard < 40) {
    guard++;
    inactiveHsl.l = Math.min(0.85, inactiveHsl.l + 0.015);
    inactiveRgb = hslToRgb(inactiveHsl);
    inactiveContrast = contrastRatio(relativeLuminance(inactiveRgb), bgLum);
  }

  // Derive UI secondary/muted text & control icon color so contrast >= 4.5:1 (target ~5.2:1)
  const uiTextHsl: HslColor = {
    h: bgHsl.h,
    s: bgHsl.s > 0.15 ? Math.min(0.22, bgHsl.s * 0.3) : 0.04,
    l: Math.max(0.68, bgHsl.l + 0.55),
  };

  let uiTextRgb = hslToRgb(uiTextHsl);
  let uiTextContrast = contrastRatio(relativeLuminance(uiTextRgb), bgLum);
  guard = 0;
  while (uiTextContrast < Math.max(MIN_UI_TEXT_CONTRAST, 4.7) && guard < 40) {
    guard++;
    uiTextHsl.l = Math.min(0.94, uiTextHsl.l + 0.015);
    uiTextRgb = hslToRgb(uiTextHsl);
    uiTextContrast = contrastRatio(relativeLuminance(uiTextRgb), bgLum);
  }

  // Secondary text is slightly brighter than muted text while both pass >= 4.5:1
  const secondaryHsl: HslColor = {
    h: uiTextHsl.h,
    s: uiTextHsl.s,
    l: Math.min(0.92, uiTextHsl.l + 0.08),
  };

  // Non-text accent (progress bar fill, etc.)
  const accentHsl: HslColor = {
    h: dominantHsl.h,
    s: dominantHsl.s < 0.12 ? 0 : Math.max(0.55, Math.min(0.85, dominantHsl.s)),
    l: dominantHsl.s < 0.12 ? 0.88 : 0.68,
  };

  const bgString = hslToString(bgHsl);
  const inactiveString = hslToString(inactiveHsl);
  const mutedString = hslToString(uiTextHsl);
  const secondaryString = hslToString(secondaryHsl);
  const accentString = hslToString(accentHsl);

  return {
    coverKey,
    category,
    bg: bgString,
    bgHsl,
    bgRgb,
    lyricActive: "#ffffff",
    lyricInactive: inactiveString,
    textSecondary: secondaryString,
    textMuted: mutedString,
    accent: accentString,
    contrasts: {
      active: Math.round(activeContrast * 100) / 100,
      inactive: Math.round(inactiveContrast * 100) / 100,
      uiText: Math.round(uiTextContrast * 100) / 100,
    },
  };
}

/** Fallback neutral dark palette when cover art is missing or invalid. */
export function createFallbackPalette(coverKey = "fallback"): LyricsPalette {
  return buildContrastVerifiedPalette(
    { h: 240, s: 0.05, l: 0.07 },
    { h: 240, s: 0, l: 0.5 },
    "fallback",
    coverKey,
  );
}
