import { nativeImage, type NativeImage } from "electron";
import * as path from "path";
import { badgeText, drawBadge, type BadgeStyle } from "./tray-badge";
import type { TrayState } from "./notification-daemon";

const ICON_FILE: Record<TrayState, string> = {
  default: "trayicon.png",
  notice: "trayicon-rd.png",
  message: "trayicon-gd.png",
};

// The dot the artwork already draws, measured on the 70px source images.
const SOURCE_SIZE = 70;
const DOT = { centerX: 48, centerY: 48, radius: 19 };

// White reads on the red dot; the gray one needs the icon's own navy instead.
const GLYPH_COLOR: Record<TrayState, [number, number, number]> = {
  default: [255, 255, 255],
  notice: [255, 255, 255],
  message: [59, 72, 94],
};

const baseIcons = new Map<TrayState, NativeImage>();

const baseIcon = (state: TrayState): NativeImage => {
  const cached = baseIcons.get(state);
  if (cached) return cached;
  const img = nativeImage.createFromPath(
    path.join(__dirname, "..", "images", ICON_FILE[state])
  );
  baseIcons.set(state, img);
  return img;
};

export function renderTrayIcon(state: TrayState, count: number): NativeImage {
  const base = baseIcon(state);
  const text = badgeText(count);
  if (!text || base.isEmpty()) return base;

  const { width, height } = base.getSize();
  const ratio = width / SOURCE_SIZE;
  const style: BadgeStyle = {
    width,
    height,
    centerX: DOT.centerX * ratio,
    centerY: DOT.centerY * ratio,
    radius: DOT.radius * ratio,
    color: GLYPH_COLOR[state],
  };

  const bitmap = drawBadge(base.toBitmap(), text, style);
  return nativeImage.createFromBitmap(bitmap, { width, height });
}
