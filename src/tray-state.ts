import { type NoticeCategory } from "./libecity-api";

export type TrayState = "default" | "message" | "notice";

// users/{uid}.notice_unread_counts - category name to unread count.
export type UnreadCounts = Record<string, number>;

// The badge number: one total across every category the site displays.
export function unreadTotal(categories: NoticeCategory[]): number {
  return categories
    .filter((c) => c.is_display)
    .reduce((sum, c) => sum + (c.unread_count || 0), 0);
}

// Notice (bell) takes priority over unread chat messages, matching the old
// tray behaviour where the notification icon outranked the message icon.
export function computeState(categories: NoticeCategory[]): TrayState {
  const displayed = categories.filter((c) => c.is_display);
  if (displayed.some((c) => c.type !== "message" && c.unread_count > 0)) return "notice";
  if (displayed.some((c) => c.type === "message" && c.unread_count > 0)) return "message";
  return "default";
}

export function totalFromCounts(counts: UnreadCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + Math.max(0, n || 0), 0);
}

export function stateFromCounts(counts: UnreadCounts): TrayState {
  const entries = Object.entries(counts);
  if (entries.some(([type, n]) => type !== "message" && n > 0)) return "notice";
  if ((counts.message ?? 0) > 0) return "message";
  return "default";
}
