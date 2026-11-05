import { contrastRatio, hslToRgb, hslToString, relativeLuminance } from "./colorUtils";
import { PRESET_CONFIGS } from "./presets";
import type { ColorCluster, HslColor, LyricsPalette, PresetName, RgbColor } from "./types";

const TARGET_CONTRAST = 4.5; // WCAG AA for white text
const MAX_ITERATIONS = 6;
const BRIGHTNESS_CAP = 0.18;

/** Blends foreground RGB over background RGB with given alpha. */
function blendOver(fg: RgbColor, bg: RgbColor, alpha: number): RgbColor {
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

/** Applies scrim darkening (black overlay) to an RGB color. */
function applyScrim(color: RgbColor, scrimAlpha: number): RgbColor {
  const factor = 1 - Math.max(0, Math.min(1, scrimAlpha));
  return {
    r: Math.round(color.r * factor),
    g: Math.round(color.g * factor),
    b: Math.round(color.b * factor),
  };
}

/**
 * Enforces legibility rules on extracted clusters to produce a contrast-safe
 * LyricsPalette (PRD §4.2).
 */
export function enforceLegibility(
  clusters: ColorCluster[],
  chosenPreset: PresetName,
  coverKey: string,
): LyricsPalette {
  if (clusters.length === 0) {
    return createFallbackPalette(coverKey);
  }

  const presetConfig = { ...PRESET_CONFIGS[chosenPreset] };
  let currentPreset = chosenPreset;

  // 1. Base color (PRD 4.2.1): darkest cluster, forced to lightness 8-14%.
  // If every cluster is light (white/pastel cover, avg L > 0.6), take dominant hue,
  // set lightness to 12%, saturation to at most 35%.
  const avgLightness = clusters.reduce((acc, c) => acc + c.hsl.l, 0) / clusters.length;
  const sortedByLightness = [...clusters].sort((a, b) => a.hsl.l - b.hsl.l);
  const darkest = sortedByLightness[0];
  const dominant = clusters[0];

  let baseHsl: HslColor;
  if (avgLightness > 0.6) {
    baseHsl = {
      h: dominant.hsl.h,
      s: Math.min(0.35, dominant.hsl.s),
      l: 0.11, // 8-14% range
    };
  } else {
    baseHsl = {
      h: darkest.hsl.h,
      s: Math.max(0.15, Math.min(0.55, darkest.hsl.s)),
      l: Math.max(0.08, Math.min(0.14, darkest.hsl.l > 0.14 ? 0.11 : darkest.hsl.l)),
    };
  }

  // 2. Blob colors (PRD 4.2.2):
  // Clamp each to lightness 25-55% and saturation 35-80%.
  // For 'dim' preset: lightness clamp lowered by 8% (17-47%).
  // A white cluster becomes neutral gray-tinted blob at lightness 45%, never pure white.
  // A black cluster becomes base-tinted, not a bright blob.
  const minL = currentPreset === "dim" ? 0.17 : 0.25;
  const maxL = currentPreset === "dim" ? 0.47 : 0.55;

  const rawBlobs: HslColor[] = [];
  for (let i = 0; i < 4; i++) {
    const cluster = clusters[i % clusters.length];
    const h = cluster.hsl.h;
    let s = cluster.hsl.s;
    let l = cluster.hsl.l;

    // White cluster (L > 0.85, low saturation) -> warm neutral gray-tinted blob
    if (l > 0.85 && s < 0.25) {
      s = 0.08;
      l = 0.42;
    }
    // Very dark cluster (L < 0.18) -> lifted to safe visible range
    else if (l < 0.18) {
      l = minL;
      s = Math.max(0.35, Math.min(0.7, s));
    } else {
      s = Math.max(0.35, Math.min(0.8, s));
      l = Math.max(minL, Math.min(maxL, l));
    }

    rawBlobs.push({ h, s, l });
  }

  // If clusters had duplicates or fewer than 4 distinct, ensure hue/lightness diversity
  if (rawBlobs.length >= 2 && rawBlobs[0].h === rawBlobs[1].h) {
    rawBlobs[1].h = (rawBlobs[1].h + 30) % 360;
    rawBlobs[1].l = Math.max(minL, rawBlobs[0].l - 0.1);
  }
  if (rawBlobs.length >= 4 && rawBlobs[2].h === rawBlobs[3].h) {
    rawBlobs[3].h = (rawBlobs[3].h + 330) % 360;
    rawBlobs[3].l = Math.min(maxL, rawBlobs[2].l + 0.08);
  }

  // 3. Contrast check & iterations (PRD 4.2.3):
  // Compute worst-case background luminance as brightest blob blended at center opacity
  // over base, then darkened by scrim.
  let scrimTop = presetConfig.scrimTop;
  let scrimBottom = presetConfig.scrimBottom;
  let worstCaseContrast = 0;
  let passed = false;

  const baseRgb = hslToRgb(baseHsl);

  for (let iter = 0; iter <= MAX_ITERATIONS; iter++) {
    // Find brightest blob among active blobs
    let maxLuminance = 0;
    for (let i = 0; i < presetConfig.blobCount; i++) {
      const blobRgb = hslToRgb(rawBlobs[i]);
      // Blend over base
      const blended = blendOver(blobRgb, baseRgb, presetConfig.blobOpacity);
      // Darkened by top scrim (the least dark point in the gradient = worst case)
      const finalSpot = applyScrim(blended, scrimTop);
      const lum = relativeLuminance(finalSpot);
      if (lum > maxLuminance) {
        maxLuminance = lum;
      }
    }

    // Contrast with white text (L = 1.0)
    worstCaseContrast = contrastRatio(1.0, maxLuminance);

    if (worstCaseContrast >= TARGET_CONTRAST) {
      passed = true;
      break;
    }

    // Adjust: reduce blob lightness by 5% and increase scrim opacity
    for (const blob of rawBlobs) {
      blob.l = Math.max(0.16, blob.l - 0.05);
    }
    scrimTop = Math.min(0.55, scrimTop + 0.04);
    scrimBottom = Math.min(0.75, scrimBottom + 0.04);
  }

  // If contrast still fails after max iterations, fall back to 'calm' with dominant hue only (PRD §4.3)
  if (!passed) {
    currentPreset = "calm";
    const calmConfig = PRESET_CONFIGS.calm;
    scrimTop = Math.max(scrimTop, calmConfig.scrimTop + 0.1);
    scrimBottom = Math.max(scrimBottom, calmConfig.scrimBottom + 0.1);
    const domHue = dominant.hsl.h;

    rawBlobs[0] = { h: domHue, s: 0.25, l: 0.22 };
    rawBlobs[1] = { h: (domHue + 20) % 360, s: 0.2, l: 0.18 };
    rawBlobs[2] = { h: (domHue + 340) % 360, s: 0.18, l: 0.24 };
    rawBlobs[3] = { h: domHue, s: 0.15, l: 0.19 };

    // Recheck contrast on calm fallback
    let maxLum = 0;
    for (let i = 0; i < 3; i++) {
      const bRgb = hslToRgb(rawBlobs[i]);
      const blended = blendOver(bRgb, baseRgb, calmConfig.blobOpacity);
      const finalSpot = applyScrim(blended, scrimTop);
      const lum = relativeLuminance(finalSpot);
      if (lum > maxLum) maxLum = lum;
    }
    worstCaseContrast = contrastRatio(1.0, maxLum);
  }

  // 4. Brightness cap (PRD 4.2.4):
  // Final average background luminance must stay below about 0.18.
  let sumLum = relativeLuminance(baseRgb);
  for (let i = 0; i < presetConfig.blobCount; i++) {
    const bRgb = hslToRgb(rawBlobs[i]);
    const blended = blendOver(bRgb, baseRgb, presetConfig.blobOpacity);
    sumLum += relativeLuminance(blended);
  }
  let averageLuminance = sumLum / (presetConfig.blobCount + 1);

  if (averageLuminance > BRIGHTNESS_CAP) {
    const reductionRatio = BRIGHTNESS_CAP / averageLuminance;
    for (const blob of rawBlobs) {
      blob.l = Math.max(0.15, blob.l * reductionRatio);
    }
    averageLuminance = BRIGHTNESS_CAP;
  }

  // 5. Accent color (PRD 4.2.5):
  // Export one accent from palette (lightness around 70%) for UI indicators.
  const accentHsl: HslColor = {
    h: dominant.hsl.h,
    s: Math.max(0.45, dominant.hsl.s),
    l: 0.70,
  };

  return {
    coverKey,
    baseColor: hslToString(baseHsl),
    blobColors: [
      hslToString(rawBlobs[0]),
      hslToString(rawBlobs[1]),
      hslToString(rawBlobs[2]),
      hslToString(rawBlobs[3]),
    ],
    accentColor: hslToString(accentHsl),
    preset: currentPreset,
    presetConfig: {
      ...PRESET_CONFIGS[currentPreset],
      scrimTop,
      scrimBottom,
    },
    scrimTop,
    scrimBottom,
    worstCaseContrast: Math.round(worstCaseContrast * 100) / 100,
    averageLuminance: Math.round(averageLuminance * 1000) / 1000,
  };
}

/** Fallback palette using default neutral dark styling when cover art is missing or invalid. */
export function createFallbackPalette(coverKey = "fallback"): LyricsPalette {
  const calm = PRESET_CONFIGS.calm;
  return {
    coverKey,
    baseColor: "hsl(240, 10%, 6%)",
    blobColors: [
      "hsl(230, 25%, 26%)",
      "hsl(260, 20%, 22%)",
      "hsl(215, 22%, 28%)",
      "hsl(240, 15%, 20%)",
    ],
    accentColor: "hsl(220, 80%, 70%)",
    preset: "calm",
    presetConfig: calm,
    scrimTop: calm.scrimTop,
    scrimBottom: calm.scrimBottom,
    worstCaseContrast: 8.5,
    averageLuminance: 0.05,
  };
}
