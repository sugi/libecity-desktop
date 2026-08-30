// Draws the unread count into the tray icon. The image is the only place the
// number can go: tray.setTitle() is macOS-only, and nativeImage cannot rasterise
// SVG, so the glyphs come from a hand-written bitmap font composited straight
// into the icon's pixel buffer.

const GLYPH_W = 3;
const GLYPH_H = 5;
const GAP = 1;

// Fraction of the dot's diameter the text may occupy. Height drives the scale so
// "9" and "9+" come out the same size; width only kicks in for the wider one.
const HEIGHT_FILL = 0.62;
const WIDTH_FILL = 0.8;

const BLANK = ["000", "000", "000", "000", "000"];

const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

export type BadgeStyle = {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
  color: [number, number, number];
};

// Two glyphs is what survives the panel scaling a 70px icon down to ~22px, so
// anything past 9 collapses into "9+".
export function badgeText(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return count > 9 ? "9+" : String(Math.floor(count));
}

// `bitmap` is BGRA, the layout nativeImage.toBitmap() returns. Returns a new
// buffer, or the input untouched if it isn't the size the style claims.
export function drawBadge(bitmap: Buffer, text: string, style: BadgeStyle): Buffer {
  const { width, height, centerX, centerY, radius, color } = style;
  if (bitmap.length !== width * height * 4) return bitmap;

  const glyphs = [...text].map((ch) => GLYPHS[ch] ?? BLANK);
  if (glyphs.length === 0) return bitmap;

  const cells = glyphs.length * GLYPH_W + (glyphs.length - 1) * GAP;
  const diameter = radius * 2;
  const scale = Math.max(
    1,
    Math.min(
      Math.floor((diameter * HEIGHT_FILL) / GLYPH_H),
      Math.floor((diameter * WIDTH_FILL) / cells)
    )
  );

  const originX = Math.round(centerX - (cells * scale) / 2);
  const originY = Math.round(centerY - (GLYPH_H * scale) / 2);
  const [r, g, b] = color;
  const out = Buffer.from(bitmap);

  glyphs.forEach((rows, index) => {
    const cellX = originX + index * (GLYPH_W + GAP) * scale;
    rows.forEach((row, gy) => {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (row[gx] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          const y = originY + gy * scale + dy;
          if (y < 0 || y >= height) continue;
          for (let dx = 0; dx < scale; dx++) {
            const x = cellX + gx * scale + dx;
            if (x < 0 || x >= width) continue;
            const offset = (y * width + x) * 4;
            out[offset] = b;
            out[offset + 1] = g;
            out[offset + 2] = r;
            out[offset + 3] = 255;
          }
        }
      }
    });
  });

  return out;
}
