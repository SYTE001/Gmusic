import type { HslColor, RgbColor } from "./types";

export function rgbToHsl({ r, g, b }: RgbColor): HslColor {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l };
  }

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === rn) {
    h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  } else if (max === gn) {
    h = ((bn - rn) / delta + 2) * 60;
  } else {
    h = ((rn - gn) / delta + 4) * 60;
  }

  return {
    h: Math.round(h),
    s: Math.max(0, Math.min(1, s)),
    l: Math.max(0, Math.min(1, l)),
  };
}

export function hslToRgb({ h, s, l }: HslColor): RgbColor {
  if (s === 0) {
    const val = Math.round(l * 255);
    return { r: val, g: val, b: val };
  }

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let rn = 0;
  let gn = 0;
  let bn = 0;

  if (h >= 0 && h < 60) {
    rn = c;
    gn = x;
    bn = 0;
  } else if (h >= 60 && h < 120) {
    rn = x;
    gn = c;
    bn = 0;
  } else if (h >= 120 && h < 180) {
    rn = 0;
    gn = c;
    bn = x;
  } else if (h >= 180 && h < 240) {
    rn = 0;
    gn = x;
    bn = c;
  } else if (h >= 240 && h < 300) {
    rn = x;
    gn = 0;
    bn = c;
  } else {
    rn = c;
    gn = 0;
    bn = x;
  }

  return {
    r: Math.round(Math.max(0, Math.min(255, (rn + m) * 255))),
    g: Math.round(Math.max(0, Math.min(255, (gn + m) * 255))),
    b: Math.round(Math.max(0, Math.min(255, (bn + m) * 255))),
  };
}

export function hslToString({ h, s, l }: HslColor): string {
  const sPct = Math.round(s * 100);
  const lPct = Math.round(l * 100);
  return `hsl(${Math.round(h)}, ${sPct}%, ${lPct}%)`;
}

/** Standard WCAG relative luminance for an sRGB color. */
export function relativeLuminance({ r, g, b }: RgbColor): number {
  const linearize = (val: number) => {
    const c = val / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two relative luminance values. */
export function contrastRatio(lum1: number, lum2: number): number {
  const l1 = Math.max(lum1, lum2);
  const l2 = Math.min(lum1, lum2);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Circular distance in degrees (0 to 180) between two hues. */
export function hueDistance(h1: number, h2: number): number {
  const diff = Math.abs((h1 % 360) - (h2 % 360));
  return Math.min(diff, 360 - diff);
}

/** Euclidean RGB distance between two colors. */
export function colorDistance(c1: RgbColor, c2: RgbColor): number {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
