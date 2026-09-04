import { clipboard, Menu, shell, type BrowserWindow } from "electron";
import { classifyUrl } from "./url-policy";

// A scheme classifyUrl rejects - the app will not open it - whose target is
// still a real address worth putting on the clipboard. javascript: is
// deliberately absent: on a web app that is how a button is spelled, and
// offering to copy javascript:void(0) on every control is noise.
const COPY_ONLY_SCHEMES = new Set(["mailto:"]);

export type EditFlags = {
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
};

// The subset of Electron's ContextMenuParams the decision reads. Electron's
// own params satisfy this structurally, so the handler passes them straight
// through and the decision stays testable without Electron.
export type ContextTarget = {
  x: number;
  y: number;
  linkURL: string;
  mediaType: string;
  srcURL: string;
  isEditable: boolean;
  selectionText: string;
  editFlags: EditFlags;
};

export type MenuAction =
  | { kind: "navigate"; url: string }
  | { kind: "open-external"; url: string }
  | { kind: "copy-text"; text: string }
  | { kind: "copy-image"; x: number; y: number };

export type MenuRole = "cut" | "copy" | "paste" | "selectAll";

export type MenuSpec =
  | { kind: "separator" }
  | { kind: "action"; label: string; action: MenuAction }
  | { kind: "role"; label: string; role: MenuRole; enabled: boolean };

function copyText(label: string, text: string): MenuSpec {
  return { kind: "action", label, action: { kind: "copy-text", text } };
}

function openExternal(label: string, url: string): MenuSpec {
  return { kind: "action", label, action: { kind: "open-external", url } };
}

function isCopyOnlyScheme(url: string): boolean {
  try {
    return COPY_ONLY_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// "開く" is absent for an external link because mayNavigate would block that
// navigation anyway, and an item that cannot do what it says is worse than a
// missing one. It is present for an internal link because that is exactly what
// setWindowOpenHandler's internal branch already does.
function linkSection(target: ContextTarget): MenuSpec[] {
  const url = target.linkURL;
  if (!url) return [];
  const copy = copyText("リンク先をコピー", url);
  const external = openExternal("外部ブラウザで開く", url);
  switch (classifyUrl(url)) {
    case "internal":
      return [{ kind: "action", label: "開く", action: { kind: "navigate", url } }, copy, external];
    case "external":
      return [copy, external];
    case "reject":
      return isCopyOnlyScheme(url) ? [copy] : [];
  }
}

function imageSection(target: ContextTarget): MenuSpec[] {
  if (target.mediaType !== "image") return [];
  // copyImageAt works off the rendered bitmap, so it does not care about the
  // scheme. The other two do: a data: or blob: source has no address worth
  // copying and nothing a browser can be handed.
  const items: MenuSpec[] = [
    {
      kind: "action",
      label: "画像をコピー",
      action: { kind: "copy-image", x: target.x, y: target.y },
    },
  ];
  if (classifyUrl(target.srcURL) !== "reject") {
    items.push(copyText("画像URLをコピー", target.srcURL));
    items.push(openExternal("画像を外部ブラウザで開く", target.srcURL));
  }
  return items;
}

// Electron's roles act on the focused frame for us, but they do not disable
// themselves - enabled has to come from the params.
function textSection(target: ContextTarget): MenuSpec[] {
  const flags = target.editFlags;
  if (target.isEditable) {
    return [
      { kind: "role", label: "切り取り", role: "cut", enabled: flags.canCut },
      { kind: "role", label: "コピー", role: "copy", enabled: flags.canCopy },
      { kind: "role", label: "貼り付け", role: "paste", enabled: flags.canPaste },
      { kind: "separator" },
      { kind: "role", label: "すべて選択", role: "selectAll", enabled: flags.canSelectAll },
    ];
  }
  if (!target.selectionText) return [];
  return [{ kind: "role", label: "コピー", role: "copy", enabled: flags.canCopy }];
}

// Chromium's order - link, image, text - with a separator between the sections
// that apply. An empty result means no menu at all rather than an empty frame.
export function buildMenuSpec(target: ContextTarget): MenuSpec[] {
  const out: MenuSpec[] = [];
  for (const section of [linkSection(target), imageSection(target), textSection(target)]) {
    if (section.length === 0) continue;
    if (out.length > 0) out.push({ kind: "separator" });
    for (const item of section) out.push(item);
  }
  return out;
}

function runAction(action: MenuAction, win: BrowserWindow): void {
  switch (action.kind) {
    case "navigate":
      void win.loadURL(action.url);
      return;
    case "open-external":
      void shell.openExternal(action.url);
      return;
    case "copy-text":
      clipboard.writeText(action.text);
      return;
    case "copy-image":
      win.webContents.copyImageAt(action.x, action.y);
      return;
  }
}

function toTemplate(spec: MenuSpec, win: BrowserWindow): Electron.MenuItemConstructorOptions {
  switch (spec.kind) {
    case "separator":
      return { type: "separator" };
    case "role":
      return { label: spec.label, role: spec.role, enabled: spec.enabled };
    case "action":
      return { label: spec.label, click: () => runAction(spec.action, win) };
  }
}

// Electron ships no default context menu for page content, so without this
// right-clicking the site does nothing at all.
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const specs = buildMenuSpec(params);
    if (specs.length === 0) return;
    Menu.buildFromTemplate(specs.map((spec) => toTemplate(spec, win))).popup({ window: win });
  });
}
