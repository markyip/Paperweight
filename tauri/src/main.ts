import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  openEpub,
  paginateEpub,
  cloneChapterInner,
  clearEpubLayoutCache,
  revokeBlobs,
  EpubError,
  type EpubBook,
  type EpubPage,
  type EpubTocEntry,
} from "./epub";
import {
  COMMENT_MAX_LENGTH,
  MARK_COLOR_DEFAULT,
  MARK_COLOR_NAMES,
  MARK_COLORS,
  clipCommentText,
  hexWithAlpha,
  markPageIndex,
  marksFor,
  marksOnPage,
  newMarkId,
  snapHighlight,
  writeMarks,
  type CommentMark,
  type FileMarks,
  type HighlightMark,
} from "./marks";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const THEME_KEY = "paperweight.theme";
const MEMORY_KEY = "paperweight.memory";
const LAYOUT_KEY = "paperweight.layout";
const LAST_PATH_KEY = "paperweight.lastPath";
const LEGACY_THEME = "pageviewer.theme";
const LEGACY_MEMORY = "pageviewer.memory";
const LEGACY_LAYOUT = "pageviewer.layout";
const EMPTY_DROP_HINT = "Drop a PDF or EPUB here, or click to open.";
type OpenOptions = { quiet?: boolean; force?: boolean };

type Memory = Record<string, { page: number; bookmarks: number[] }>;
type ToolMode = "none" | "highlight" | "erase" | "comment";
type ViewAnchor = { page: number; spine?: number; offset?: number; progress?: number };
type PdfRenderTask = { cancel: (extraDelay?: number) => void; promise: Promise<void> };

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const APP_TITLE = "Paperweight";
/** Keep in sync with package.json / tauri.conf.json / Cargo.toml on version bumps. */
const APP_VERSION = "0.1.3";
const UPDATE_CHECK_URL = "https://api.github.com/repos/markyip/Paperweight/releases/latest";
const UPDATE_FALLBACK_URL = "https://github.com/markyip/Paperweight/releases/latest";
const UPDATE_SNOOZE_KEY = "paperweight.update.snoozeUntil";
const UPDATE_SNOOZE_MS = 28 * 24 * 60 * 60 * 1000;

const TAB_DRAG_MIME = "application/x-paperweight-tab";
const TAB_BOOT_PREFIX = "paperweight.boot.";
const TAB_CLOSE_SVG =
  '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" /></svg>';

type DocTab = { id: string; path: string; title: string; bytes?: Uint8Array };

const ui = {
  app: $("app"),
  titlebar: $("titlebar"),
  titlebarTabs: $("titlebar-tabs"),
  titlebarTitle: $("titlebar-title"),
  winMin: $("btn-win-min") as HTMLButtonElement,
  winMax: $("btn-win-max") as HTMLButtonElement,
  winClose: $("btn-win-close") as HTMLButtonElement,
  contents: $("btn-contents") as HTMLButtonElement,
  bookmark: $("btn-bookmark") as HTMLButtonElement,
  highlight: $("btn-highlight") as HTMLButtonElement,
  erase: $("btn-erase") as HTMLButtonElement,
  comment: $("btn-comment") as HTMLButtonElement,
  colorWell: $("color-well"),
  theme: $("btn-theme") as HTMLButtonElement,
  find: $("btn-find") as HTMLButtonElement,
  print: $("btn-print") as HTMLButtonElement,
  scroll: $("btn-scroll") as HTMLButtonElement,
  columns: $("btn-columns") as HTMLButtonElement,
  pomodoro: $("btn-pomodoro") as HTMLButtonElement,
  pomoRepsBtn: $("btn-pomo-reps") as HTMLButtonElement,
  pomoDurLabel: $("pomo-dur-label"),
  pomoRepsLabel: $("pomo-reps-label"),
  pomoBadge: $("pomo-badge"),
  pomoOverlay: $("pomo-overlay"),
  pomoCopy: $("pomo-copy"),
  pomoBreakTime: $("pomo-break-time"),
  pomoDismiss: $("pomo-dismiss") as HTMLButtonElement,
  fab: $("fab"),
  fabToggle: $("btn-fab") as HTMLButtonElement,
  zoomIn: $("btn-zoom-in") as HTMLButtonElement,
  zoomOut: $("btn-zoom-out") as HTMLButtonElement,
  fitPage: $("btn-fit-page") as HTMLButtonElement,
  hudBottom: $("hud-bottom"),
  pageInput: $("page-input") as HTMLInputElement,
  pageTotal: $("page-total"),
  zoomLabel: $("zoom-label"),
  findInput: $("find-input") as HTMLInputElement,
  findStatus: $("find-status"),
  findPrev: $("find-prev") as HTMLButtonElement,
  findNext: $("find-next") as HTMLButtonElement,
  sidebar: $("sidebar"),
  tocList: $("toc-list"),
  bookmarkList: $("bookmark-list"),
  stage: $("stage"),
  pages: $("pages"),
  empty: $("empty"),
  emptyHint: $("empty-hint"),
  fileOpen: $("file-open") as HTMLInputElement,
  commentPop: $("comment-pop"),
  commentText: $("comment-text") as HTMLTextAreaElement,
  commentCount: $("comment-count"),
  commentSave: $("comment-save") as HTMLButtonElement,
  commentDelete: $("comment-delete") as HTMLButtonElement,
  commentCancel: $("comment-cancel") as HTMLButtonElement,
  commentClose: $("comment-pop-close") as HTMLButtonElement,
  pwOverlay: $("pw-overlay"),
  pwForm: $("pw-form") as HTMLFormElement,
  pwInput: $("pw-input") as HTMLInputElement,
  pwError: $("pw-error"),
  pwOpen: $("pw-open") as HTMLButtonElement,
  pwCancel: $("pw-cancel") as HTMLButtonElement,
  selMenu: $("sel-menu"),
  selCopy: $("sel-copy") as HTMLButtonElement,
  selHighlight: $("sel-highlight") as HTMLButtonElement,
  selMenuHl: $("sel-menu-hl"),
  selSwatches: $("sel-swatches"),
  updateToast: $("update-toast"),
  updateToastMsg: $("update-toast-msg"),
  updateToastView: $("update-toast-view") as HTMLButtonElement,
  updateToastDismiss: $("update-toast-dismiss") as HTMLButtonElement,
};

let pdf: PDFDocumentProxy | null = null;
let epubBook: EpubBook | null = null;
let epubPages: EpubPage[] = [];
let epubBlobs: string[] = [];
let filePath = "";
let tabs: DocTab[] = [];
let activeTabId = "";
let tabSeq = 0;
let loadGen = 0;
let tabDragId = "";
let tabDropConsumed = false;
let scale = 1;
const SCALE_MIN = 0.05;
const SCALE_MAX = 3;
/** Cap backing-store DPR so 3x displays do not rasterize huge canvases. */
const PDF_DPR_CAP = 2;
const PDF_CANVAS_MAX = 4096;
const PDF_PAINT_MAX = 2;
/** Keep this many rows of rasterized pages around the current page. */
const PDF_KEEP_ROWS = 2;
const EPUB_FONT_MIN = 14;
const EPUB_FONT_MAX = 28;
const EPUB_FONT_DEFAULT = 18;
const EPUB_FONT_STEP = 1;
/** Wait until type-size nudges pause before rebuilding page slots. */
const EPUB_FONT_LAYOUT_MS = 220;
const EPUB_MEASURE_MIN_CH = 60;
const EPUB_MEASURE_MAX_CH = 75;
const EPUB_PAD_X = 64;
/** Space between EPUB page cards. */
const EPUB_ROW_GAP_PX = 16;
let epubFontPx = EPUB_FONT_DEFAULT;
let epubFontLayoutTimer = 0;
let epubFontLayoutBusy = false;
let epubFontLayoutAgain = false;
let pendingEpubAnchor: ViewAnchor | null = null;
/** 0 = auto columns from viewport vs page aspect, then fit-to-stage; otherwise 1 or 2. */
let columns: 0 | 1 | 2 = 1;
let scrollSnap = false;
/** Keep the on-screen PDF scale when Auto ↔ 2 (or snap) still shows the same page count. */
let pinnedPdfUsedScale: number | null = null;
/** Keep EPUB slot size so Auto ↔ 2 / snap does not rewrite type size or clip height. */
let pinnedEpubMetrics: { slotW: number; pageH: number } | null = null;
/** Ignore ResizeObserver refit immediately after a preserve-zoom layout (scrollbar blips). */
let ignoreRefitUntil = 0;
let currentPage = 1;
/** Ignore scroll-derived page changes while zoom/fit relayout restores the anchor. */
let pageAnchorLock = false;
let layoutGen = 0;
let layoutCols = 1;
let rendering = new Set<number>();
let textCache = new Map<number, string>();
let hits: { page: number }[] = [];
let hitIndex = -1;
let findTimer = 0;
let searchQuery = "";
let searchBoxes = new Map<number, { x: number; y: number; w: number; h: number }[]>();
let observer: IntersectionObserver | null = null;
let intersectingPages = new Set<number>();
let paintWait = new Set<number>();
const pdfRenderTasks = new Map<number, PdfRenderTask>();
const pdfTextLayers = new Map<number, { cancel: () => void }>();
let persistPageTimer = 0;
let pdfPruneRaf = 0;
let fileMarks: FileMarks = { highlights: [], comments: [] };
let tool: ToolMode = "none";
let highlightColor: string = MARK_COLOR_DEFAULT;
let drag: {
  slot: HTMLElement;
  page: number;
  x0: number;
  y0: number;
  pointer: number;
  erase: boolean;
  dirty: boolean;
} | null = null;
let editingComment: CommentMark | null = null;
let pendingComment: { page: number; x: number; y: number } | null = null;
let commentLoadedLen = 0;
/** Real TOC entries (not the empty "None" placeholder). */
let tocHasEntries = false;
type SelBox = { page: number; x: number; y: number; w: number; h: number };
type SelPayload = { text: string; boxes: SelBox[] };
let selMenuPayload: SelPayload | null = null;
/** Snapshot taken on highlighter chrome pointerdown, before the click collapses the range. */
let pendingChromeSel: SelPayload | null = null;

function lsGet(key: string, legacy: string): string | null {
  return localStorage.getItem(key) ?? localStorage.getItem(legacy);
}

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const plat = nav.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(plat) || /Macintosh|Mac OS X/i.test(navigator.userAgent || "");
}

function hasDoc(): boolean {
  return pdf !== null || epubBook !== null;
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

function pathStem(path: string): string {
  const base = pathBasename(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base;
  return base.slice(0, dot);
}

/** Centered caption: app name, EPUB `dc:title`, filename, or file stem. */
function documentCaption(): string {
  if (!hasDoc()) return APP_TITLE;
  const epubTitle = epubBook?.title?.trim();
  if (epubTitle && epubTitle.toLowerCase() !== "untitled") return epubTitle;
  if (!filePath) return APP_TITLE;
  if (epubBook) return pathStem(filePath) || pathBasename(filePath) || APP_TITLE;
  return pathBasename(filePath) || APP_TITLE;
}

function syncCaptionTitle() {
  const caption = documentCaption();
  ui.titlebarTitle.textContent = caption;
  ui.titlebarTitle.setAttribute("title", caption);
  document.title = caption;
  try {
    void getCurrentWindow().setTitle(caption).catch(() => {});
  } catch {
    /* vite preview */
  }
}

function isPdfOrEpub(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".epub");
}

/** True for a filesystem path we can reopen later — not a browser File basename. */
function isNativeFsPath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  return p.includes("/") || p.includes("\\");
}

function rememberLastPath(path: string) {
  if (!inTauri() || !isNativeFsPath(path) || !isPdfOrEpub(path)) return;
  try {
    localStorage.setItem(LAST_PATH_KEY, path);
  } catch {
    /* quota / private mode */
  }
  void invoke("save_last_path", { path }).catch(() => {});
}

async function readLastPath(): Promise<string> {
  let fromDisk = "";
  try {
    fromDisk = String(await invoke<string>("load_last_path") || "").trim();
  } catch {
    /* browser / missing command */
  }
  let fromLs = "";
  try {
    fromLs = (localStorage.getItem(LAST_PATH_KEY) || "").trim();
  } catch {
    /* ignore */
  }
  const candidate = fromDisk || fromLs;
  if (candidate && isNativeFsPath(candidate) && isPdfOrEpub(candidate)) return candidate;
  return "";
}

async function lastPathStillThere(path: string): Promise<boolean> {
  try {
    return Boolean(await invoke<boolean>("document_exists", { path }));
  } catch {
    return true;
  }
}

function normalizeFsPath(path: string): string {
  let p = path.trim().replace(/^["']|["']$/g, "");
  if (/^file:/i.test(p)) {
    try {
      const url = new URL(p);
      p = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    } catch {
      p = p.replace(/^file:\/\//i, "").replace(/^localhost/i, "");
      try {
        p = decodeURIComponent(p);
      } catch {
        /* keep */
      }
      if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    }
  }
  if (p.startsWith("\\\\?\\")) p = p.slice(4);
  return p;
}

function samePath(a: string, b: string): boolean {
  const na = normalizeFsPath(a).replace(/\\/g, "/").toLowerCase();
  const nb = normalizeFsPath(b).replace(/\\/g, "/").toLowerCase();
  return Boolean(na) && na === nb;
}

function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label || "main";
  } catch {
    return "main";
  }
}

function isMainWindow(): boolean {
  return currentWindowLabel() === "main";
}

function bootOpenPath(): string {
  try {
    const q = new URLSearchParams(window.location.search);
    const direct = q.get("open");
    if (direct) return normalizeFsPath(direct);
    const label = q.get("w");
    if (!label) return "";
    const key = `${TAB_BOOT_PREFIX}${label}`;
    const stored = localStorage.getItem(key) || "";
    localStorage.removeItem(key);
    return normalizeFsPath(stored);
  } catch {
    return "";
  }
}

function dedupePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = normalizeFsPath(raw);
    if (!path || !isPdfOrEpub(path)) continue;
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function findTabByPath(path: string): DocTab | undefined {
  return tabs.find((t) => samePath(t.path, path));
}

function upsertTab(path: string, extra?: { title?: string; bytes?: Uint8Array }): DocTab {
  const existing = findTabByPath(path);
  if (existing) {
    if (extra?.title) existing.title = extra.title;
    if (extra?.bytes) existing.bytes = extra.bytes;
    return existing;
  }
  const tab: DocTab = {
    id: `t${++tabSeq}`,
    path,
    title: extra?.title || pathStem(path) || pathBasename(path) || APP_TITLE,
    bytes: extra?.bytes,
  };
  tabs.push(tab);
  return tab;
}

function renderTabs() {
  const strip = ui.titlebarTabs;
  const titlebar = ui.titlebar;
  if (!strip || !titlebar) return;
  const show = tabs.length > 0;
  titlebar.classList.toggle("has-tabs", show);
  strip.hidden = !show;
  strip.replaceChildren();
  if (!show) return;
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "titlebar-tab";
    el.classList.toggle("is-active", tab.id === activeTabId);
    el.classList.toggle("is-dragging", tab.id === tabDragId);
    el.dataset.tabId = tab.id;
    el.draggable = true;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.id === activeTabId ? "true" : "false");
    el.title = tab.title;
    const label = document.createElement("span");
    label.className = "titlebar-tab-label";
    label.textContent = tab.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "titlebar-tab-close";
    close.title = "Close";
    close.setAttribute("aria-label", `Close ${tab.title}`);
    close.innerHTML = TAB_CLOSE_SVG;
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void closeTab(tab.id);
    });
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.append(label, close);
    el.addEventListener("click", () => {
      void activateTab(tab.id);
    });
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void closeTab(tab.id);
      }
    });
    el.addEventListener("dragstart", (e) => {
      tabDragId = tab.id;
      tabDropConsumed = false;
      e.dataTransfer?.setData(TAB_DRAG_MIME, tab.id);
      e.dataTransfer?.setData("text/plain", tab.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      el.classList.add("is-dragging");
    });
    el.addEventListener("dragend", (e) => {
      el.classList.remove("is-dragging");
      const id = tabDragId;
      const consumed = tabDropConsumed;
      tabDragId = "";
      tabDropConsumed = false;
      renderTabs();
      if (!consumed && id) void maybeDetachTab(id, e);
    });
    strip.append(el);
  }
}

function tabInsertIndex(clientX: number): number {
  const items = [...ui.titlebarTabs.querySelectorAll<HTMLElement>(".titlebar-tab")];
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return items.length;
}

function moveTabTo(id: string, index: number) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return;
  const [tab] = tabs.splice(from, 1);
  let to = index;
  if (from < to) to -= 1;
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
  renderTabs();
}

function pointerOutsideWindow(e: DragEvent): boolean {
  const x = e.screenX;
  const y = e.screenY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const pad = 6;
  return (
    x < window.screenX - pad ||
    y < window.screenY - pad ||
    x > window.screenX + window.outerWidth + pad ||
    y > window.screenY + window.outerHeight + pad
  );
}

async function spawnDocWindow(path: string, screenX?: number, screenY?: number): Promise<void> {
  const label = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    localStorage.setItem(`${TAB_BOOT_PREFIX}${label}`, path);
  } catch {
    /* quota */
  }
  const opts: Record<string, unknown> = {
    url: `index.html?w=${encodeURIComponent(label)}`,
    title: pathBasename(path) || APP_TITLE,
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    decorations: false,
    dragDropEnabled: true,
    theme: "dark",
    backgroundColor: "#111113",
    focus: true,
  };
  if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
    opts.x = Math.round((screenX as number) - 72);
    opts.y = Math.round((screenY as number) - 20);
  }
  const webview = new WebviewWindow(label, opts as ConstructorParameters<typeof WebviewWindow>[1]);
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("window timeout")), 8000);
    void webview.once("tauri://created", () => {
      window.clearTimeout(timer);
      resolve();
    });
    void webview.once("tauri://error", (event) => {
      window.clearTimeout(timer);
      try {
        localStorage.removeItem(`${TAB_BOOT_PREFIX}${label}`);
      } catch {
        /* ignore */
      }
      reject(event);
    });
  });
}

async function maybeDetachTab(id: string, e: DragEvent) {
  if (!inTauri()) return;
  const tab = tabs.find((t) => t.id === id);
  if (!tab || !isNativeFsPath(tab.path)) return;
  if (!pointerOutsideWindow(e)) return;
  try {
    await spawnDocWindow(tab.path, e.screenX, e.screenY);
  } catch {
    return;
  }
  await closeTab(id);
}

async function activateTab(id: string) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.id === activeTabId && hasDoc() && samePath(filePath, tab.path)) {
    renderTabs();
    return;
  }
  persistCurrentPage();
  if (tab.bytes) {
    await openDocument(tab.path, tab.bytes, { quiet: true });
    return;
  }
  await openPath(tab.path, { quiet: true, force: true });
}

async function closeTab(id: string) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const wasActive = tabs[index].id === activeTabId;
  tabs.splice(index, 1);
  if (!wasActive) {
    renderTabs();
    return;
  }
  if (!tabs.length) {
    activeTabId = "";
    loadGen += 1;
    await unloadDocument();
    showEmptyChrome();
    renderTabs();
    if (!isMainWindow()) nativeWin((win) => win.close());
    return;
  }
  const next = tabs[Math.min(index, tabs.length - 1)];
  await activateTab(next.id);
}

function wireTabs() {
  const strip = ui.titlebarTabs;
  strip.addEventListener("dragover", (e) => {
    if (!tabDragId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  });
  strip.addEventListener("drop", (e) => {
    if (!tabDragId) return;
    e.preventDefault();
    e.stopPropagation();
    tabDropConsumed = true;
    moveTabTo(tabDragId, tabInsertIndex(e.clientX));
  });
  window.addEventListener("dragover", (e) => {
    if (!tabDragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  });
  window.addEventListener("drop", (e) => {
    if (!tabDragId) return;
    e.preventDefault();
    tabDropConsumed = true;
  });
}

function toUint8Array(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return new Uint8Array(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  if (raw && typeof raw === "object") {
    const rec = raw as { data?: unknown; bytes?: unknown; length?: number };
    if (Array.isArray(rec.data)) return Uint8Array.from(rec.data as number[]);
    if (Array.isArray(rec.bytes)) return Uint8Array.from(rec.bytes as number[]);
    if (typeof rec.length === "number" && rec.length >= 0) {
      return Uint8Array.from(raw as ArrayLike<number>);
    }
  }
  throw new Error("Could not read file bytes");
}

function pageCount(): number {
  if (pdf) return pdf.numPages;
  if (epubBook) return Math.max(1, epubPages.length);
  return 0;
}

function loadMemory(): Memory {
  try {
    return JSON.parse(lsGet(MEMORY_KEY, LEGACY_MEMORY) || "{}") as Memory;
  } catch {
    return {};
  }
}

function saveMemory(mut: (m: Memory) => void) {
  if (!filePath) return;
  const all = loadMemory();
  all[filePath] ??= { page: 1, bookmarks: [] };
  mut(all);
  localStorage.setItem(MEMORY_KEY, JSON.stringify(all));
}

function fileMemory() {
  return loadMemory()[filePath] ?? { page: 1, bookmarks: [] };
}

type ThemePref = "light" | "dark" | "auto";

const THEME_LABEL: Record<ThemePref, string> = {
  light: "Light",
  dark: "Dark",
  auto: "Auto",
};

const THEME_NEXT: Record<ThemePref, ThemePref> = {
  light: "dark",
  dark: "auto",
  auto: "light",
};

const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let themePref: ThemePref = "dark";

/** Matches `--void` in styles.css — keeps DWM / WebView2 from flashing white. */
const VOID_RGB = {
  dark: [17, 17, 19] as [number, number, number],
  light: [244, 244, 245] as [number, number, number],
};

function systemTheme(): "light" | "dark" {
  return themeMedia.matches ? "dark" : "light";
}

function resolveTheme(pref: ThemePref): "light" | "dark" {
  return pref === "auto" ? systemTheme() : pref;
}

function syncNativeChrome(pref: ThemePref, resolved: "light" | "dark") {
  const nativeTheme = pref === "auto" ? null : resolved;
  const bg = VOID_RGB[resolved];
  try {
    const win = getCurrentWindow();
    void win.setTheme(nativeTheme).catch(() => {});
    void win.setBackgroundColor(bg).catch(() => {});
  } catch {
    /* vite preview / no native window */
  }
  try {
    void getCurrentWebview().setBackgroundColor(bg).catch(() => {});
  } catch {
    /* vite preview */
  }
}

function applyThemePref(pref: ThemePref) {
  themePref = pref;
  localStorage.setItem(THEME_KEY, pref);
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = pref;
  const current = THEME_LABEL[pref];
  const next = THEME_LABEL[THEME_NEXT[pref]];
  ui.theme.title = `Appearance: ${current} — click for ${next}`;
  ui.theme.setAttribute("aria-label", ui.theme.title);
  ui.theme.classList.toggle("on", pref === "auto");
  syncNativeChrome(pref, resolved);
}

function loadThemePref(): ThemePref {
  const saved = lsGet(THEME_KEY, LEGACY_THEME);
  if (saved === "light" || saved === "dark" || saved === "auto") return saved;
  return "dark";
}

type FabPanel = "closed" | "menu" | "search";

function fabPanel(): FabPanel {
  return (ui.fab.dataset.panel as FabPanel) || "closed";
}

function blurFabChrome() {
  ui.fab.querySelectorAll<HTMLElement>("button, input").forEach((el) => el.blur());
}

function setFabPanel(panel: FabPanel) {
  const prev = fabPanel();
  ui.fab.dataset.panel = panel;
  ui.fabToggle.title = panel === "closed" ? "Settings" : "Close";
  ui.fabToggle.setAttribute("aria-label", ui.fabToggle.title);
  ui.fabToggle.setAttribute("aria-expanded", panel === "closed" ? "false" : "true");
  ui.find.classList.toggle("on", panel === "search");
  ui.find.setAttribute("aria-expanded", panel === "search" ? "true" : "false");
  if (panel === "search") {
    ui.findInput.focus();
    ui.findInput.select();
  } else if (prev === "search") {
    clearFindHighlights();
  }
  if (panel === "closed") blurFabChrome();
}

function closeFabFlyout() {
  if (fabPanel() === "search") {
    setFabPanel("menu");
  }
}

/** Cached so Esc can exit fullscreen without waiting on the window API. */
let appFullscreen = false;

function syncFullscreenChrome(on: boolean) {
  appFullscreen = on;
  if (on) document.documentElement.dataset.fullscreen = "1";
  else delete document.documentElement.dataset.fullscreen;
}

async function setAppFullscreen(on: boolean) {
  syncFullscreenChrome(on);
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch {
    syncFullscreenChrome(false);
  }
}

async function toggleFullscreen() {
  try {
    const win = getCurrentWindow();
    const next = !(await win.isFullscreen());
    syncFullscreenChrome(next);
    await win.setFullscreen(next);
  } catch {
    /* running outside Tauri — WebView has no native window fullscreen */
    syncFullscreenChrome(false);
  }
}

async function syncWinMaxBtn() {
  let max = false;
  try {
    max = await getCurrentWindow().isMaximized();
  } catch {
    max = false;
  }
  ui.winMax.classList.toggle("is-max", max);
  const label = max ? "Restore" : "Maximize";
  ui.winMax.title = label;
  ui.winMax.setAttribute("aria-label", label);
}

function nativeWin(fn: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) {
  try {
    void fn(getCurrentWindow()).catch(() => {});
  } catch {
    /* vite preview */
  }
}

function wireTitlebar() {
  ui.winMin.addEventListener("click", () => {
    nativeWin((win) => win.minimize());
  });
  ui.winMax.addEventListener("click", () => {
    nativeWin(async (win) => {
      await win.toggleMaximize();
      await syncWinMaxBtn();
    });
  });
  ui.winClose.addEventListener("click", () => {
    nativeWin((win) => win.close());
  });
  try {
    const win = getCurrentWindow();
    void win.onResized(() => {
      void syncWinMaxBtn();
    });
    void syncWinMaxBtn();
    void win
      .isFullscreen()
      .then((on) => syncFullscreenChrome(on))
      .catch(() => {});
  } catch {
    /* vite preview */
  }
  syncCaptionTitle();
}

function loadLayout() {
  try {
    const raw = JSON.parse(lsGet(LAYOUT_KEY, LEGACY_LAYOUT) || "{}") as {
      columns?: number | "auto";
      snap?: boolean;
      scale?: number;
      epubFontPx?: number;
      highlightColor?: string;
    };
    if (raw.columns === 1 || raw.columns === 2) {
      columns = raw.columns;
    } else if (raw.columns === 0 || raw.columns === "auto" || raw.columns === 3) {
      columns = 0;
    }
    scrollSnap = Boolean(raw.snap);
    if (typeof raw.scale === "number") scale = clampScale(raw.scale);
    if (typeof raw.epubFontPx === "number") epubFontPx = clampEpubFont(raw.epubFontPx);
    if (typeof raw.highlightColor === "string") {
      const match = MARK_COLORS.find((c) => c.toLowerCase() === raw.highlightColor!.toLowerCase());
      if (match) highlightColor = match;
    }
  } catch {
    /* keep defaults */
  }
}

function saveLayout() {
  localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      columns: columns === 0 ? "auto" : columns,
      snap: scrollSnap,
      scale,
      epubFontPx,
      highlightColor,
    }),
  );
}

function columnsLabel(): string {
  if (columns === 1) return "1 page";
  if (columns === 2) return "2 pages";
  return epubBook
    ? "Auto columns from window width and type size"
    : "Auto columns";
}

function nextColumns(n: 0 | 1 | 2): 0 | 1 | 2 {
  if (n === 1) return 2;
  if (n === 2) return 0;
  return 1;
}

function syncLayoutButtons() {
  ui.stage.classList.toggle("snap", scrollSnap);
  ui.scroll.dataset.snap = scrollSnap ? "1" : "0";
  const scrollLabel = scrollSnap ? "Page by page" : "Continuous scroll";
  ui.scroll.title = scrollLabel;
  ui.scroll.setAttribute("aria-label", scrollLabel);
  ui.columns.dataset.cols = columns === 0 ? "auto" : String(columns);
  const colsLabel = columnsLabel();
  ui.columns.title = colsLabel;
  ui.columns.setAttribute("aria-label", colsLabel);
}

function refreshBookmarkCues(marked?: Set<number>) {
  const set = marked ?? new Set(fileMemory().bookmarks);
  ui.pages.querySelectorAll<HTMLElement>(".page-slot").forEach((slot) => {
    slot.classList.toggle("is-bookmarked", set.has(Number(slot.dataset.page)));
  });
}

function syncSelectedSlot() {
  const prev = ui.pages.querySelector<HTMLElement>(".page-slot.selected");
  if (prev && Number(prev.dataset.page) !== currentPage) {
    prev.classList.remove("selected");
  }
  ui.pages.querySelector<HTMLElement>(`[data-page="${currentPage}"]`)?.classList.add("selected");
}

function syncBookmarkIcon() {
  const page = currentPage;
  const marked = new Set(fileMemory().bookmarks);
  const on = marked.has(page);
  ui.bookmark.classList.toggle("on", on);
  ui.bookmark.setAttribute("aria-pressed", on ? "true" : "false");
  const label = on ? `Remove bookmark from page ${page}` : `Bookmark page ${page}`;
  ui.bookmark.title = label;
  ui.bookmark.setAttribute("aria-label", label);
  syncSelectedSlot();
}

function selectVisiblePage(page: number) {
  if (!hasDoc() || !Number.isFinite(page) || page < 1) return;
  if (page !== currentPage) {
    currentPage = page;
    saveMemory((m) => {
      m[filePath].page = page;
    });
  }
  setPageLabel();
}

function slotMostlyVisible(slot: HTMLElement): boolean {
  const root = ui.stage.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  const overlapH = Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top);
  const overlapW = Math.min(r.right, root.right) - Math.max(r.left, root.left);
  if (overlapH <= 0 || overlapW <= 0) return false;
  return (overlapH * overlapW) / Math.max(1, r.width * r.height) >= 0.2;
}

function slotVisibleArea(slot: HTMLElement): number {
  const root = ui.stage.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  const overlapH = Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top);
  const overlapW = Math.min(r.right, root.right) - Math.max(r.left, root.left);
  if (overlapH <= 0 || overlapW <= 0) return 0;
  return overlapH * overlapW;
}

function pagesToMeasure(): HTMLElement[] {
  const slots: HTMLElement[] = [];
  const seen = new Set<number>();
  const add = (page: number) => {
    if (seen.has(page)) return;
    const slot = ui.pages.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!slot) return;
    seen.add(page);
    slots.push(slot);
  };
  if (intersectingPages.size) {
    for (const n of intersectingPages) add(n);
    return slots;
  }
  const cols = Math.max(1, layoutCols);
  const from = Math.max(1, currentPage - cols * 2);
  const to = Math.min(pageCount(), currentPage + cols * 2);
  for (let n = from; n <= to; n++) add(n);
  return slots;
}

function mostVisiblePage(): number {
  let bestPage = 0;
  let bestArea = 0;
  const root = ui.stage.getBoundingClientRect();
  for (const slot of pagesToMeasure()) {
    const r = slot.getBoundingClientRect();
    const overlapH = Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top);
    const overlapW = Math.min(r.right, root.right) - Math.max(r.left, root.left);
    const area = overlapH > 0 && overlapW > 0 ? overlapH * overlapW : 0;
    const page = Number(slot.dataset.page);
    if (!Number.isFinite(page)) continue;
    if (area > bestArea + 1) {
      bestArea = area;
      bestPage = page;
    } else if (bestArea > 0 && Math.abs(area - bestArea) <= 1 && page === currentPage) {
      bestPage = page;
    }
  }
  return bestPage || currentPage;
}

function pageInView(): number {
  const selected = ui.pages.querySelector<HTMLElement>(".page-slot.selected");
  if (selected && slotMostlyVisible(selected)) {
    return Number(selected.dataset.page) || currentPage;
  }
  return mostVisiblePage() || currentPage;
}

function captureViewAnchor(): ViewAnchor {
  const page = pageInView();
  const epub = epubPages[page - 1];
  if (epub) {
    const height = Math.max(1, epub.chapterHeight || epub.offset + 1);
    return {
      page,
      spine: epub.spine,
      offset: epub.offset,
      progress: epub.offset / height,
    };
  }
  return { page };
}

function resolveViewAnchor(anchor?: ViewAnchor): number {
  const fallback = Math.min(pageCount(), Math.max(1, anchor?.page ?? currentPage));
  if (!epubBook || anchor?.spine == null || !epubPages.length) return fallback || 1;
  const height = epubPages.find((p) => p.spine === anchor.spine)?.chapterHeight;
  const target =
    anchor.progress != null && Number.isFinite(anchor.progress) && height
      ? anchor.progress * height
      : (anchor.offset || 0);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < epubPages.length; i++) {
    const p = epubPages[i];
    if (p.spine !== anchor.spine) continue;
    const dist = Math.abs(p.offset - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i + 1;
    }
  }
  return bestDist < Infinity ? best : fallback || 1;
}

function scrollSlotToStage(page: number) {
  const apply = () => {
    const slot = ui.pages.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!slot || !ui.stage.contains(slot)) return;
    const row = slot.parentElement;
    const target = row?.classList.contains("page-row") ? row : slot;
    const viewH = ui.stage.clientHeight;
    const viewW = ui.stage.clientWidth;
    const rowH = target.offsetHeight;
    const minTop = columns === 0 ? 16 : 24;
    const minBottom = 16;
    const extra =
      !scrollSnap && rowH > 0 && rowH + 8 < viewH
        ? Math.max(0, Math.floor((viewH - rowH) / 2))
        : 0;
    ui.pages.style.setProperty("--pages-pad-top", `${Math.max(minTop, extra)}px`);
    ui.pages.style.setProperty("--pages-pad-bottom", `${Math.max(minBottom, extra)}px`);
    const top =
      extra > minTop
        ? Math.max(0, target.offsetTop - extra)
        : Math.max(0, target.offsetTop);
    ui.stage.scrollTop = top;
    const extraX = ui.stage.scrollWidth - viewW;
    ui.stage.scrollLeft = extraX > 1 ? extraX / 2 : 0;
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function persistCurrentPage() {
  if (!filePath) return;
  window.clearTimeout(persistPageTimer);
  persistPageTimer = window.setTimeout(() => {
    persistPageTimer = 0;
    if (!filePath) return;
    saveMemory((m) => {
      m[filePath].page = currentPage;
    });
  }, 350);
}

function syncCurrentPageFromView() {
  if (pageAnchorLock || !hasDoc()) return;
  const selected = ui.pages.querySelector<HTMLElement>(`[data-page="${currentPage}"]`);
  if (selected && slotMostlyVisible(selected)) return;
  const page = mostVisiblePage();
  if (!page || page === currentPage) return;
  currentPage = page;
  setPageLabel();
  persistCurrentPage();
  paintNearbyPages(page);
}

function setPageLabel() {
  if (!hasDoc()) return;
  ui.pageTotal.textContent = String(pageCount());
  if (document.activeElement !== ui.pageInput) {
    ui.pageInput.value = String(currentPage);
  }
  if (epubBook) {
    ui.zoomLabel.textContent = `${epubFontPx} px`;
    ui.zoomIn.title = "Larger type";
    ui.zoomOut.title = "Smaller type";
    ui.fitPage.title = "Fit to window";
  } else {
    ui.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    ui.zoomIn.title = "Zoom in";
    ui.zoomOut.title = "Zoom out";
    ui.fitPage.title = "Fit page";
  }
  ui.zoomIn.setAttribute("aria-label", ui.zoomIn.title);
  ui.zoomOut.setAttribute("aria-label", ui.zoomOut.title);
  ui.fitPage.setAttribute("aria-label", ui.fitPage.title);
  syncLayoutButtons();
  syncBookmarkIcon();
}

function setEmptyHint(text: string) {
  ui.emptyHint.textContent = text;
}

function jumpToTypedPage() {
  if (!hasDoc()) return;
  const n = Number.parseInt(ui.pageInput.value, 10);
  if (!Number.isFinite(n)) {
    setPageLabel();
    return;
  }
  goToPage(n);
}

async function readDocumentBytes(path: string): Promise<Uint8Array> {
  const raw = await invoke<unknown>("read_document", { path });
  const bytes = toUint8Array(raw);
  if (!bytes.byteLength) throw new Error("empty");
  return bytes;
}

async function destToPage(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number> {
  if (!dest) return 1;
  let explicit: unknown = dest;
  if (typeof dest === "string") {
    explicit = await doc.getDestination(dest);
  }
  if (!Array.isArray(explicit) || !explicit[0]) return 1;
  try {
    const index = await doc.getPageIndex(explicit[0] as never);
    return index + 1;
  } catch {
    return 1;
  }
}

function spineToPage(spineIndex: number): number {
  const idx = epubPages.findIndex((p) => p.spine === spineIndex);
  return idx >= 0 ? idx + 1 : 1;
}

function renderPdfToc(
  items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>,
  parent: HTMLElement,
) {
  parent.replaceChildren();
  if (parent === ui.tocList) tocHasEntries = Boolean(items?.length);
  if (!items?.length) {
    const empty = document.createElement("li");
    empty.innerHTML = `<span class="muted">None</span>`;
    parent.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link";
    btn.textContent = item.title || "Untitled";
    btn.addEventListener("click", async () => {
      if (!pdf) return;
      const page = await destToPage(pdf, item.dest);
      goToPage(page);
    });
    li.append(btn);
    if (item.items?.length) {
      const nested = document.createElement("ul");
      nested.className = "nested";
      renderPdfToc(item.items, nested);
      li.append(nested);
    }
    parent.append(li);
  }
}

function renderEpubToc(entries: EpubTocEntry[], parent: HTMLElement) {
  parent.replaceChildren();
  if (parent === ui.tocList) tocHasEntries = entries.length > 0;
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.innerHTML = `<span class="muted">None</span>`;
    parent.append(empty);
    return;
  }
  const roots: HTMLElement[] = [parent];
  let lastLevel = 0;
  for (const entry of entries) {
    while (entry.level < lastLevel && roots.length > 1) {
      roots.pop();
      lastLevel -= 1;
    }
    if (entry.level > lastLevel) {
      const nested = document.createElement("ul");
      nested.className = "nested";
      roots[roots.length - 1].lastElementChild?.append(nested);
      roots.push(nested);
      lastLevel = entry.level;
    }
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link";
    btn.textContent = entry.title || "Untitled";
    const spineIndex = entry.spineIndex;
    btn.addEventListener("click", () => goToPage(spineToPage(spineIndex)));
    li.append(btn);
    roots[roots.length - 1].append(li);
  }
}

function hasSidebarLists(): boolean {
  return tocHasEntries || fileMemory().bookmarks.length > 0;
}

function closeSidebar() {
  ui.sidebar.hidden = true;
  ui.app.classList.remove("sidebar-open");
}

/** Show the contents trigger only when TOC or bookmarks have something to list. */
function syncContentsChrome() {
  const show = hasDoc() && hasSidebarLists();
  ui.contents.hidden = !show;
  if (!show) closeSidebar();
}

function renderBookmarks() {
  const { bookmarks } = fileMemory();
  ui.bookmarkList.replaceChildren();
  if (!bookmarks.length) {
    const li = document.createElement("li");
    li.textContent = "None yet";
    li.style.color = "var(--muted)";
    ui.bookmarkList.append(li);
    syncContentsChrome();
    return;
  }
  for (const page of [...bookmarks].sort((a, b) => a - b)) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link";
    btn.textContent = `Page ${page}`;
    btn.addEventListener("click", () => goToPage(page));
    li.append(btn);
    ui.bookmarkList.append(li);
  }
  syncContentsChrome();
}

function makeSlot(pageNumber: number, w: string, h: string): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "page-slot";
  slot.dataset.page = String(pageNumber);
  slot.style.width = w;
  slot.style.height = h;
  slot.style.containIntrinsicSize = `${w} ${h}`;
  const body = document.createElement("div");
  body.className = "page-body";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "mark-layer");
  svg.setAttribute("viewBox", "0 0 1 1");
  svg.setAttribute("preserveAspectRatio", "none");
  const searchSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  searchSvg.setAttribute("class", "search-layer");
  searchSvg.setAttribute("viewBox", "0 0 1 1");
  searchSvg.setAttribute("preserveAspectRatio", "none");
  const pins = document.createElement("div");
  pins.className = "pin-layer";
  const preview = document.createElement("div");
  preview.className = "hl-preview";
  preview.hidden = true;
  const cue = document.createElement("div");
  cue.className = "page-bookmark-cue";
  cue.setAttribute("aria-hidden", "true");
  cue.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  slot.append(body, svg, searchSvg, pins, preview, cue);
  return slot;
}

function paintMarks(slot: HTMLElement) {
  const page = markPageIndex(slot.dataset.page);
  const svg = slot.querySelector(".mark-layer");
  const pins = slot.querySelector(".pin-layer");
  if (!svg || !pins) return;
  svg.replaceChildren();
  pins.replaceChildren();
  for (const hl of marksOnPage(fileMarks.highlights, page)) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "hl-rect");
    rect.setAttribute("x", String(hl.x));
    rect.setAttribute("y", String(hl.y));
    rect.setAttribute("width", String(hl.w));
    rect.setAttribute("height", String(hl.h));
    rect.setAttribute("fill", hexWithAlpha(hl.color));
    rect.dataset.id = hl.id;
    svg.append(rect);
  }
  for (const comment of marksOnPage(fileMarks.comments, page)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comment-pin";
    btn.dataset.id = comment.id;
    btn.style.left = `${comment.x * 100}%`;
    btn.style.top = `${comment.y * 100}%`;
    btn.title = comment.text.slice(0, 80) || "Comment";
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (page != null) selectVisiblePage(page);
      openCommentEditor(comment, btn);
    });
    pins.append(btn);
  }
}

function paintAllMarks() {
  ui.pages.querySelectorAll<HTMLElement>(".page-slot").forEach(paintMarks);
  void paintAllSearch();
}

async function persistMarks() {
  if (!filePath) return;
  await writeMarks(filePath, fileMarks);
}

function setPdfScaleVars(slot: HTMLElement, scaleFactor: number) {
  const n = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  slot.style.setProperty("--scale-factor", String(n));
  slot.style.setProperty("--user-unit", "1");
  slot.style.setProperty("--total-scale-factor", String(n));
  slot.style.setProperty("--scale-round-x", "1px");
  slot.style.setProperty("--scale-round-y", "1px");
}

function pdfSlot(pageNumber: number): HTMLElement | null {
  return ui.pages.querySelector<HTMLElement>(`[data-page="${pageNumber}"]`);
}

function isRenderCancel(err: unknown): boolean {
  return err instanceof pdfjs.RenderingCancelledException;
}

function observerRootMargin(): string {
  const h = ui.stage.clientHeight || 600;
  const pad = Math.min(240, Math.max(64, Math.round(h * 0.18)));
  return `${pad}px 0px`;
}

function slotOverlapsStage(slot: HTMLElement): boolean {
  return slotVisibleArea(slot) > 0;
}

function shouldKeepPdfPage(pageNumber: number): boolean {
  if (intersectingPages.has(pageNumber)) return true;
  const cols = Math.max(1, layoutCols);
  return (
    pageNumber >= currentPage - cols * PDF_KEEP_ROWS &&
    pageNumber <= currentPage + cols * PDF_KEEP_ROWS
  );
}

function pdfSlotBusy(slot: HTMLElement, page: number): boolean {
  if (drag?.page === page) return true;
  if (pendingComment?.page === page) return true;
  if (editingComment?.page === page) return true;
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) {
    const node = sel.anchorNode;
    if (node && slot.contains(node)) return true;
  }
  return false;
}

function cancelPdfRender(pageNumber: number) {
  const task = pdfRenderTasks.get(pageNumber);
  if (!task) return;
  pdfRenderTasks.delete(pageNumber);
  try {
    task.cancel();
  } catch {
    /* already finished */
  }
}

function cancelPdfText(pageNumber: number) {
  const layer = pdfTextLayers.get(pageNumber);
  if (!layer) return;
  pdfTextLayers.delete(pageNumber);
  try {
    layer.cancel();
  } catch {
    /* already finished */
  }
}

function cancelAllPdfWork() {
  for (const page of [...pdfRenderTasks.keys()]) cancelPdfRender(page);
  for (const page of [...pdfTextLayers.keys()]) cancelPdfText(page);
  rendering.clear();
  paintWait.clear();
}

function releasePdfSlot(slot: HTMLElement, pageNumber: number) {
  cancelPdfRender(pageNumber);
  cancelPdfText(pageNumber);
  rendering.delete(pageNumber);
  paintWait.delete(pageNumber);
  slot.querySelector(".page-body")?.replaceChildren();
  delete slot.dataset.painted;
  delete slot.dataset.text;
}

function pruneOffscreenPdfPages() {
  if (!pdf) return;
  const cols = Math.max(1, layoutCols);
  const keepFrom = Math.max(1, currentPage - cols * PDF_KEEP_ROWS);
  const keepTo = Math.min(pageCount(), currentPage + cols * PDF_KEEP_ROWS);
  ui.pages.querySelectorAll<HTMLElement>(".page-slot[data-painted='1']").forEach((slot) => {
    const n = Number(slot.dataset.page);
    if (!Number.isFinite(n)) return;
    if (n >= keepFrom && n <= keepTo) return;
    if (intersectingPages.has(n)) return;
    if (pdfSlotBusy(slot, n)) return;
    releasePdfSlot(slot, n);
  });
  for (const n of [...paintWait]) {
    if (n < keepFrom - cols || n > keepTo + cols) paintWait.delete(n);
  }
}

function schedulePdfPrune() {
  if (!pdf || pdfPruneRaf) return;
  pdfPruneRaf = requestAnimationFrame(() => {
    pdfPruneRaf = 0;
    pruneOffscreenPdfPages();
  });
}

function pickPaintPage(): number | null {
  if (!paintWait.size) return null;
  let best = 0;
  let bestRank = Infinity;
  for (const n of paintWait) {
    const slot = pdfSlot(n);
    if (!slot || slot.dataset.painted === "1") {
      paintWait.delete(n);
      continue;
    }
    const area = slotVisibleArea(slot);
    const rank = area > 0 ? -area : Math.abs(n - currentPage);
    if (rank < bestRank) {
      bestRank = rank;
      best = n;
    }
  }
  return best || null;
}

function pumpPdfPaint() {
  while (pdf && rendering.size < PDF_PAINT_MAX) {
    const page = pickPaintPage();
    if (!page) break;
    paintWait.delete(page);
    void paintPage(page);
  }
}

function requestPdfPaint(pageNumber: number) {
  if (!pdf || !Number.isFinite(pageNumber) || pageNumber < 1) return;
  const slot = pdfSlot(pageNumber);
  if (!slot) return;
  if (slot.dataset.painted === "1") {
    if (slot.dataset.text !== "1" && slotOverlapsStage(slot)) {
      void ensurePdfTextLayer(pageNumber);
    }
    return;
  }
  if (rendering.has(pageNumber)) return;
  paintWait.add(pageNumber);
  pumpPdfPaint();
}

function ensureVisiblePdfText() {
  if (!pdf) return;
  for (const n of intersectingPages) {
    const slot = pdfSlot(n);
    if (
      slot &&
      slot.dataset.painted === "1" &&
      slot.dataset.text !== "1" &&
      slotOverlapsStage(slot)
    ) {
      void ensurePdfTextLayer(n);
    }
  }
}

function pdfOutputScale(cssW: number, cssH: number): number {
  let ratio = Math.min(window.devicePixelRatio || 1, PDF_DPR_CAP);
  const maxDim = Math.max(cssW, cssH) * ratio;
  if (maxDim > PDF_CANVAS_MAX) ratio *= PDF_CANVAS_MAX / maxDim;
  return Math.max(0.5, ratio);
}

async function paintPdfTextLayer(
  page: PDFPageProxy,
  container: HTMLElement,
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
  pageNumber: number,
) {
  if (container.querySelector(".textLayer")) return;
  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  container.append(textLayerDiv);
  const textLayer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayerDiv,
    viewport,
  });
  pdfTextLayers.set(pageNumber, textLayer);
  try {
    await textLayer.render();
    if (pdfTextLayers.get(pageNumber) === textLayer) pdfTextLayers.delete(pageNumber);
  } catch (err) {
    if (pdfTextLayers.get(pageNumber) === textLayer) pdfTextLayers.delete(pageNumber);
    textLayerDiv.remove();
    if (!isRenderCancel(err)) throw err;
  }
}

async function ensurePdfTextLayer(pageNumber: number) {
  if (!pdf) return;
  const slot = pdfSlot(pageNumber);
  if (!slot || slot.dataset.painted !== "1" || slot.dataset.text === "1") return;
  const body = slot.querySelector<HTMLElement>(".page-body");
  if (!body) return;
  if (body.querySelector(".textLayer")) {
    slot.dataset.text = "1";
    return;
  }
  const gen = layoutGen;
  try {
    const page = await pdf.getPage(pageNumber);
    if (gen !== layoutGen || !pdf || !slot.isConnected) return;
    const usedScale =
      Number(slot.style.getPropertyValue("--scale-factor")) ||
      (() => {
        const native = page.getViewport({ scale: 1 });
        const targetW =
          slot.clientWidth || Number.parseFloat(slot.style.width) || native.width;
        return targetW / native.width;
      })();
    const viewport = page.getViewport({ scale: usedScale });
    await paintPdfTextLayer(page, body, viewport, pageNumber);
    if (gen !== layoutGen || !slot.isConnected) return;
    slot.dataset.text = "1";
  } catch (err) {
    if (!isRenderCancel(err)) delete slot.dataset.text;
  }
}

async function paintPage(pageNumber: number) {
  if (!pdf || rendering.has(pageNumber)) return;
  const slot = pdfSlot(pageNumber);
  if (!slot || slot.dataset.painted === "1") return;
  const body = slot.querySelector<HTMLElement>(".page-body");
  if (!body) return;
  const gen = layoutGen;
  rendering.add(pageNumber);
  try {
    const page = await pdf.getPage(pageNumber);
    if (gen !== layoutGen || !pdf || !slot.isConnected || !shouldKeepPdfPage(pageNumber)) return;
    const native = page.getViewport({ scale: 1 });
    const targetW =
      slot.clientWidth || Number.parseFloat(slot.style.width) || native.width;
    const targetH =
      slot.clientHeight || Number.parseFloat(slot.style.height) || native.height;
    const usedScale = Math.min(
      targetW / Math.max(1, native.width),
      targetH / Math.max(1, native.height),
    );
    const viewport = page.getViewport({ scale: usedScale });
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);
    const ratio = pdfOutputScale(cssW, cssH);
    const canvas = document.createElement("canvas");
    const scaled = page.getViewport({ scale: usedScale * ratio });
    canvas.width = Math.floor(scaled.width);
    canvas.height = Math.floor(scaled.height);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    setPdfScaleVars(slot, usedScale);
    const task = page.render({ canvas, viewport: scaled, intent: "display" });
    pdfRenderTasks.set(pageNumber, task);
    await task.promise;
    if (pdfRenderTasks.get(pageNumber) === task) pdfRenderTasks.delete(pageNumber);
    if (gen !== layoutGen || !slot.isConnected || !shouldKeepPdfPage(pageNumber)) return;
    body.replaceChildren(canvas);
    slot.dataset.painted = "1";
    if (slotOverlapsStage(slot)) await ensurePdfTextLayer(pageNumber);
    if (searchQuery.length >= 2) void paintSearchOnSlot(slot);
  } catch (err) {
    if (isRenderCancel(err)) return;
    delete slot.dataset.painted;
  } finally {
    rendering.delete(pageNumber);
    pumpPdfPaint();
  }
}

function observeSlots() {
  observer?.disconnect();
  intersectingPages.clear();
  observer = new IntersectionObserver(
    (entries) => {
      let changed = false;
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page);
        if (!Number.isFinite(page)) continue;
        if (entry.isIntersecting) {
          if (!intersectingPages.has(page)) {
            intersectingPages.add(page);
            changed = true;
          }
          if (pdf) requestPdfPaint(page);
          else if (epubBook) paintEpubPage(page);
        } else if (intersectingPages.delete(page)) {
          changed = true;
        }
      }
      if (changed && pdf) {
        ensureVisiblePdfText();
        schedulePdfPrune();
      }
    },
    { root: ui.stage, rootMargin: observerRootMargin(), threshold: 0 },
  );
  ui.pages.querySelectorAll(".page-slot").forEach((el) => observer?.observe(el));
}

const GUTTER_FRACTION = 0.03;
const GAP_PX = 16;
/** Matches `.pages` horizontal padding (`--pages-pad-x`). */
const EDGE_PX = 16;
/** Matches `.pages` `--pages-pad-bottom`. */
const PAGES_PAD_BOTTOM_PX = 16;

function pagesPadTopPx(): number {
  return columns === 0 ? 16 : 24;
}

function recommendedColumns(pageAspect: number): number {
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  if (vw <= 1 || vh <= 1 || pageAspect <= 0) return 1;
  const usableAspect = (vw / vh) * (1.0 - GUTTER_FRACTION);
  const raw = usableAspect / pageAspect;
  return Math.max(1, Math.min(6, Math.round(raw) || 1));
}

function resolveColumnsPref(pref: 0 | 1 | 2, pageAspect: number): number {
  if (pref === 0) return recommendedColumns(pageAspect);
  return pref;
}

function resolveColumns(pageAspect: number): number {
  return resolveColumnsPref(columns, pageAspect);
}

function clampEpubFont(px: number): number {
  if (!Number.isFinite(px)) return EPUB_FONT_DEFAULT;
  return Math.min(EPUB_FONT_MAX, Math.max(EPUB_FONT_MIN, Math.round(px)));
}

function clampScale(next: number): number {
  if (!Number.isFinite(next)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
}

/** Approximate CSS `ch` width for Palatino / Georgia at *fontPx*. */
function epubChPx(fontPx: number): number {
  return Math.max(4, fontPx * 0.5);
}

function recommendedEpubColumns(innerW: number, fontPx: number): number {
  const minSlot = EPUB_MEASURE_MIN_CH * epubChPx(fontPx) + EPUB_PAD_X;
  if (innerW >= minSlot * 2 + GAP_PX) return 2;
  return 1;
}

function resolveEpubColumnsPref(pref: 0 | 1 | 2): number {
  if (pref === 1 || pref === 2) return pref;
  return recommendedEpubColumns(stageInner().innerW, epubFontPx);
}

function resolveEpubColumns(): number {
  return resolveEpubColumnsPref(columns);
}

function epubSlotMetrics(cols: number): { slotW: number; pageH: number } {
  if (pinnedEpubMetrics) return pinnedEpubMetrics;
  const { innerW } = stageInner();
  const padTop = columns === 0 ? 16 : 24;
  const pageH = Math.max(280, ui.stage.clientHeight - padTop - PAGES_PAD_BOTTOM_PX);
  if (columns === 0) {
    const maxSlot = EPUB_MEASURE_MAX_CH * epubChPx(epubFontPx) + EPUB_PAD_X;
    const share = (innerW - GAP_PX * Math.max(0, cols - 1)) / Math.max(1, cols);
    return { slotW: Math.max(160, Math.min(maxSlot, share)), pageH };
  }
  return {
    slotW: manualSlotWidth(cols),
    pageH,
  };
}

/** Font size so a ~65ch column fills the current window / column count. */
function fitEpubFontPx(): number {
  const { innerW } = stageInner();
  const colsGuess =
    columns === 1 || columns === 2
      ? columns
      : recommendedEpubColumns(innerW, EPUB_FONT_DEFAULT);
  let slotW: number;
  if (columns === 0) {
    const maxSlot = EPUB_MEASURE_MAX_CH * epubChPx(EPUB_FONT_DEFAULT) + EPUB_PAD_X;
    const share = (innerW - GAP_PX * Math.max(0, colsGuess - 1)) / Math.max(1, colsGuess);
    slotW = Math.max(160, Math.min(maxSlot, share));
  } else {
    slotW = manualSlotWidth(colsGuess);
  }
  const targetCh = (EPUB_MEASURE_MIN_CH + EPUB_MEASURE_MAX_CH) / 2;
  return clampEpubFont((slotW - EPUB_PAD_X) / Math.max(1, targetCh * 0.5));
}

function stageInner(): { innerW: number; innerH: number } {
  const vw = Math.max(1, ui.stage.clientWidth);
  const vh = Math.max(1, ui.stage.clientHeight);
  return {
    innerW: Math.max(200, vw - EDGE_PX * 2),
    innerH: Math.max(200, vh - pagesPadTopPx() - PAGES_PAD_BOTTOM_PX),
  };
}

/** Width-only slot size used by manual 1 / 2 columns. */
function manualSlotWidth(cols: number): number {
  const avail = Math.max(240, ui.stage.clientWidth - 72);
  return (avail - GAP_PX * Math.max(0, cols - 1)) / Math.max(1, cols);
}

function pdfSlotWidth(cols: number): number {
  if (columns === 0) {
    const { innerW } = stageInner();
    return (innerW - GAP_PX * Math.max(0, cols - 1)) / Math.max(1, cols);
  }
  return manualSlotWidth(cols);
}

/** Auto and 2-up must contain-fit; 1-up may be taller than the stage (user scroll). */
function pdfContainSpread(cols: number): boolean {
  return columns === 0 || cols >= 2;
}

/** Contain-fit one spread into the padded stage (width- or height-limited). */
function autoSpreadScale(nativeW: number, nativeH: number, cols: number): number {
  const { innerH } = stageInner();
  const scaleW = pdfSlotWidth(cols) / Math.max(1, nativeW);
  const scaleH = innerH / Math.max(1, nativeH);
  return Math.max(0.05, Math.min(scaleW, scaleH));
}

function clearLayoutPins() {
  pinnedPdfUsedScale = null;
  pinnedEpubMetrics = null;
}

function readDisplayedPdfScale(nativeW: number): number | null {
  const slot = ui.pages.querySelector<HTMLElement>(".page-slot");
  if (!slot) return null;
  const w = slot.clientWidth || Number.parseFloat(slot.style.width);
  if (!Number.isFinite(w) || w <= 1) return null;
  return w / Math.max(1, nativeW);
}

function readDisplayedEpubMetrics(): { slotW: number; pageH: number } | null {
  const slot = ui.pages.querySelector<HTMLElement>(".page-slot");
  if (!slot) return null;
  const slotW = slot.clientWidth || Number.parseFloat(slot.style.width);
  const pageH = slot.clientHeight || Number.parseFloat(slot.style.height);
  if (!Number.isFinite(slotW) || slotW <= 1 || !Number.isFinite(pageH) || pageH <= 1) {
    return null;
  }
  return { slotW, pageH };
}

function pdfFormulaScale(nativeW: number, nativeH: number, cols: number): number {
  const base = pdfContainSpread(cols)
    ? autoSpreadScale(nativeW, nativeH, cols)
    : manualSlotWidth(cols) / Math.max(1, nativeW);
  return Math.max(0.05, base * scale);
}

/** Keep Auto/2-up from painting taller than the padded slot; honor user zoom (`scale`). */
function clampPdfScaleToSlot(
  nativeW: number,
  nativeH: number,
  cols: number,
  used: number,
): number {
  if (!pdfContainSpread(cols) || !(used > 0)) return used;
  const contain = autoSpreadScale(nativeW, nativeH, cols);
  const cap = contain * Math.max(scale, 1);
  return Math.min(used, cap);
}

/** On-screen PDF scale. Pin wins so Auto ↔ 2 (same page count) does not jump. */
function pdfLayoutScale(
  nativeW: number,
  nativeH: number,
  cols: number,
  preserveZoom: boolean,
): number {
  if (preserveZoom) {
    const shown = readDisplayedPdfScale(nativeW);
    if (shown && shown > 0) {
      const used = clampPdfScaleToSlot(nativeW, nativeH, cols, shown);
      pinnedPdfUsedScale = used;
      return used;
    }
  }
  if (pinnedPdfUsedScale != null && pinnedPdfUsedScale > 0) {
    return clampPdfScaleToSlot(nativeW, nativeH, cols, pinnedPdfUsedScale);
  }
  return pdfFormulaScale(nativeW, nativeH, cols);
}

function appendSlots(count: number, w: string, h: string, cols: number) {
  let row: HTMLDivElement | null = null;
  for (let i = 1; i <= count; i++) {
    if ((i - 1) % cols === 0) {
      row = document.createElement("div");
      row.className = "page-row";
      ui.pages.append(row);
    }
    row?.append(makeSlot(i, w, h));
  }
}

function applyEpubFontToDom(px: number) {
  const value = `${clampEpubFont(px)}px`;
  document.documentElement.style.setProperty("--epub-font-px", value);
  ui.app.style.setProperty("--epub-font-px", value);
  ui.pages.style.setProperty("--epub-font-px", value);
}

function fillEpubSlot(slot: HTMLElement, page: EpubPage, pageHeight: number) {
  slot.classList.add("epub-slot");
  const body = slot.querySelector<HTMLElement>(".page-body");
  if (!body) return;
  const chapter = epubBook?.chapters[page.spine];
  const inner = chapter ? cloneChapterInner(chapter) : document.createElement("div");
  if (!chapter) {
    inner.className = "epub-inner";
    inner.innerHTML = page.html;
  }
  const sliceH = Math.max(
    1,
    Math.min(Math.floor(pageHeight) + 8, Math.round(page.sliceHeight || pageHeight)),
  );
  inner.style.transform = `translateY(-${Math.round(page.offset)}px)`;
  const clip = document.createElement("div");
  clip.className = "epub-clip";
  clip.style.height = `${sliceH}px`;
  clip.append(inner);
  body.replaceChildren(clip);
  slot.style.height = `${Math.floor(pageHeight)}px`;
  slot.dataset.painted = "1";
  paintMarks(slot);
  void paintSearchOnSlot(slot);
}

function epubPageHeight(): number {
  const stored = Number(ui.pages.dataset.epubPageH);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return epubSlotMetrics(resolveEpubColumns()).pageH;
}

function paintEpubPage(pageNumber: number) {
  if (!epubBook) return;
  const slot = ui.pages.querySelector<HTMLElement>(`[data-page="${pageNumber}"]`);
  if (!slot || slot.dataset.painted === "1") return;
  const page = epubPages[pageNumber - 1];
  if (!page) return;
  fillEpubSlot(slot, page, epubPageHeight());
}

function paintNearbyEpubPages(page: number) {
  if (!epubBook) return;
  const total = pageCount();
  const cols = Math.max(1, resolveEpubColumns());
  const from = Math.max(1, page - cols * 2);
  const to = Math.min(total, page + cols * 4);
  for (let n = from; n <= to; n++) paintEpubPage(n);
}

function paintNearbyPdfPages(page: number) {
  if (!pdf) return;
  const cols = Math.max(1, layoutCols);
  const rowStart = Math.floor((page - 1) / cols) * cols + 1;
  const from = Math.max(1, rowStart - cols);
  const to = Math.min(pageCount(), rowStart + cols * 2 - 1);
  for (let n = from; n <= to; n++) requestPdfPaint(n);
}

function paintNearbyPages(page: number) {
  paintNearbyPdfPages(page);
  paintNearbyEpubPages(page);
}

async function layoutPages(anchor?: ViewAnchor, opts?: { preserveZoom?: boolean }) {
  if (!hasDoc()) return;
  hideSelMenu();
  const preserveZoom = Boolean(opts?.preserveZoom);
  if (preserveZoom) ignoreRefitUntil = Date.now() + 400;
  const gen = ++layoutGen;
  cancelAllPdfWork();
  intersectingPages.clear();
  pageAnchorLock = true;
  const unlockIfCurrent = () => {
    if (gen === layoutGen) pageAnchorLock = false;
  };
  try {
    ui.pages.classList.toggle("auto-fit", columns === 0);
    ui.pages.style.removeProperty("--pages-pad-top");
    ui.pages.style.removeProperty("--pages-pad-bottom");
    let width = "100px";
    let height = "140px";
    let cols = 1;
    let count = pageCount();
    if (pdf) {
      const first = await pdf.getPage(1);
      if (gen !== layoutGen) return;
      if (!pdf) {
        unlockIfCurrent();
        return;
      }
      const native = first.getViewport({ scale: 1 });
      const pageAspect = native.width / native.height;
      cols = resolveColumns(pageAspect);
      const usedScale = pdfLayoutScale(native.width, native.height, cols, preserveZoom);
      const viewport = first.getViewport({ scale: usedScale });
      width = `${Math.floor(viewport.width)}px`;
      height = `${Math.floor(viewport.height)}px`;
      count = pdf.numPages;
    } else if (epubBook) {
      cols = resolveEpubColumns();
      if (preserveZoom) {
        const shown = readDisplayedEpubMetrics();
        if (shown) pinnedEpubMetrics = shown;
      }
      const { slotW, pageH } = epubSlotMetrics(cols);
      applyEpubFontToDom(epubFontPx);
      ui.pages.style.setProperty(
        "--epub-media-max-h",
        `${Math.max(80, Math.floor(pageH) - 68)}px`,
      );
      try {
        const prioritySpine =
          pendingEpubAnchor?.spine ?? epubPages[(currentPage || 1) - 1]?.spine;
        epubPages = await paginateEpub(epubBook, slotW, pageH, epubFontPx, {
          prioritySpine,
        });
      } catch {
        setPageLabel();
        unlockIfCurrent();
        return;
      }
      ui.pages.dataset.epubPageH = String(Math.floor(pageH));
      width = `${Math.floor(slotW)}px`;
      height = `${Math.floor(pageH)}px`;
      count = epubPages.length;
    }
    if (gen !== layoutGen) return;
    layoutCols = Math.max(1, cols);
    observer?.disconnect();
    intersectingPages.clear();
    ui.pages.replaceChildren();
    ui.pages.classList.toggle("auto-fit", columns === 0);
    ui.pages.classList.toggle("epub-flow", Boolean(epubBook));
    if (epubBook) {
      ui.pages.style.setProperty("--epub-row-gap", `${EPUB_ROW_GAP_PX}px`);
    } else {
      ui.pages.style.removeProperty("--epub-row-gap");
    }
    appendSlots(count, width, height, cols);
    if (epubBook) {
      ui.pages.querySelectorAll<HTMLElement>(".page-slot").forEach((slot) => {
        slot.classList.add("epub-slot");
      });
    }
    ui.stage.classList.toggle("snap", scrollSnap);
    const restore = resolveViewAnchor(anchor);
    currentPage = restore;
    scrollSlotToStage(restore);
    observeSlots();
    paintAllMarks();
    refreshBookmarkCues();
    setPageLabel();
    paintNearbyPages(restore);
    requestAnimationFrame(() => {
      if (gen !== layoutGen) return;
      scrollSlotToStage(restore);
      paintNearbyPages(restore);
      requestAnimationFrame(() => {
        if (gen !== layoutGen) return;
        scrollSlotToStage(restore);
        pageAnchorLock = false;
      });
    });
  } catch (err) {
    unlockIfCurrent();
    throw err;
  }
}

function goToPage(page: number) {
  if (!hasDoc()) return;
  const n = Math.min(pageCount(), Math.max(1, page));
  currentPage = n;
  setPageLabel();
  scrollSlotToStage(n);
  paintNearbyPages(n);
  if (pdf) schedulePdfPrune();
  saveMemory((m) => {
    m[filePath].page = n;
  });
}

function setTool(next: ToolMode) {
  if (!hasDoc() && next !== "none") return;
  if (next !== "none") hideSelMenu();
  tool = next;
  ui.app.dataset.tool = next;
  ui.highlight.classList.toggle("on", next === "highlight");
  ui.erase.classList.toggle("on", next === "erase");
  ui.comment.classList.toggle("on", next === "comment");
  ui.highlight.setAttribute("aria-pressed", next === "highlight" ? "true" : "false");
  ui.erase.setAttribute("aria-pressed", next === "erase" ? "true" : "false");
  ui.comment.setAttribute("aria-pressed", next === "comment" ? "true" : "false");
  if (next !== "comment") {
    closeCommentPop();
    ui.comment.blur();
  }
}

function closeCommentPop() {
  ui.commentPop.hidden = true;
  editingComment = null;
  pendingComment = null;
}

function cancelCommentMode() {
  closeCommentPop();
  setTool("none");
}

function commentInputCap(): number {
  return commentLoadedLen > COMMENT_MAX_LENGTH ? commentLoadedLen : COMMENT_MAX_LENGTH;
}

function syncCommentMaxLength() {
  if (ui.commentText.value.length > COMMENT_MAX_LENGTH) {
    ui.commentText.removeAttribute("maxlength");
  } else {
    ui.commentText.maxLength = COMMENT_MAX_LENGTH;
  }
}

function updateCommentCount() {
  ui.commentCount.textContent = `${ui.commentText.value.length} / ${COMMENT_MAX_LENGTH}`;
}

function setCommentText(text: string) {
  commentLoadedLen = text.length;
  ui.commentText.value = text;
  syncCommentMaxLength();
  updateCommentCount();
}

function htmlToPlain(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  parsed.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre").forEach((el) => {
    el.append("\n");
  });
  return (parsed.body.textContent || "").replace(/\u00a0/g, " ");
}

function plainClipboardText(data: DataTransfer | null | undefined): string {
  if (!data) return "";
  const plain = data.getData("text/plain");
  if (plain) return plain;
  const html = data.getData("text/html");
  return html ? htmlToPlain(html) : "";
}

function onCommentInput() {
  const el = ui.commentText;
  const cap = commentInputCap();
  if (el.value.length > cap) {
    const pos = el.selectionStart;
    el.value = el.value.slice(0, cap);
    el.setSelectionRange(Math.min(pos, cap), Math.min(pos, cap));
  }
  if (commentLoadedLen > COMMENT_MAX_LENGTH) {
    commentLoadedLen = el.value.length;
  }
  syncCommentMaxLength();
  updateCommentCount();
}

function onCommentPaste(e: ClipboardEvent) {
  e.preventDefault();
  const chunk = plainClipboardText(e.clipboardData);
  const el = ui.commentText;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const cap = commentInputCap();
  const room = Math.max(0, cap - (el.value.length - (end - start)));
  const inserted = chunk.slice(0, room);
  const next = el.value.slice(0, start) + inserted + el.value.slice(end);
  el.value = next;
  const caret = start + inserted.length;
  el.setSelectionRange(caret, caret);
  if (commentLoadedLen > COMMENT_MAX_LENGTH) {
    commentLoadedLen = next.length;
  }
  syncCommentMaxLength();
  updateCommentCount();
}

function placeCommentPop(clientX: number, clientY: number) {
  ui.commentPop.hidden = false;
  const popW = ui.commentPop.offsetWidth || 260;
  const popH = ui.commentPop.offsetHeight || 160;
  const left = Math.min(window.innerWidth - popW - 12, Math.max(8, clientX + 12));
  const top = Math.min(window.innerHeight - popH - 12, Math.max(8, clientY + 12));
  ui.commentPop.style.left = `${left}px`;
  ui.commentPop.style.top = `${top}px`;
  syncCommentMaxLength();
  ui.commentText.focus();
  updateCommentCount();
}

function openCommentEditor(comment: CommentMark, anchor: HTMLElement) {
  editingComment = comment;
  pendingComment = null;
  setCommentText(comment.text || "");
  ui.commentDelete.hidden = false;
  const rect = anchor.getBoundingClientRect();
  placeCommentPop(rect.right, rect.top);
}

function pointInSlot(slot: HTMLElement, clientX: number, clientY: number) {
  const r = slot.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return {
    x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
  };
}

function highlightAt(page: number, x: number, y: number): HighlightMark | null {
  for (const hl of [...marksOnPage(fileMarks.highlights, page)].reverse()) {
    if (x >= hl.x && x <= hl.x + hl.w && y >= hl.y && y <= hl.y + hl.h) return hl;
  }
  return null;
}

/** Remove one mark on this page by id. Returns true if something was deleted. */
function eraseHighlightAt(page: number, x: number, y: number): boolean {
  const hit = highlightAt(page, x, y);
  if (!hit) return false;
  fileMarks.highlights = fileMarks.highlights.filter((h) => h.id !== hit.id);
  paintAllMarks();
  return true;
}

function showPreview(slot: HTMLElement, box: { x: number; y: number; w: number; h: number } | null) {
  const el = slot.querySelector<HTMLElement>(".hl-preview");
  if (!el) return;
  if (!box) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.style.left = `${box.x * 100}%`;
  el.style.top = `${box.y * 100}%`;
  el.style.width = `${box.w * 100}%`;
  el.style.height = `${box.h * 100}%`;
  el.style.background = hexWithAlpha(highlightColor);
}

function hideSelMenu() {
  if (ui.selMenu) ui.selMenu.hidden = true;
  selMenuPayload = null;
}

function syncPdfSelChrome() {
  ui.app.classList.toggle("has-pdf-sel", Boolean(capturePageSelection()?.boxes.length));
}

/** Keep PDF text selection when clicking highlight chrome (mousedown would collapse it). */
function preservePageSelection(el: HTMLElement) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pendingChromeSel = capturePageSelection();
    e.preventDefault();
  });
}

function takeChromeSelection(): SelPayload | null {
  const live = capturePageSelection();
  const snap = live?.boxes.length ? live : pendingChromeSel;
  pendingChromeSel = null;
  return snap;
}

function mergeLineBoxes(boxes: SelBox[]): SelBox[] {
  const byPage = new Map<number, SelBox[]>();
  for (const box of boxes) {
    const list = byPage.get(box.page) || [];
    list.push(box);
    byPage.set(box.page, list);
  }
  const out: SelBox[] = [];
  for (const [page, list] of byPage) {
    const sorted = list.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged: SelBox[] = [];
    for (const box of sorted) {
      const last = merged[merged.length - 1];
      if (
        last &&
        Math.abs(box.y - last.y) < 0.006 &&
        Math.abs(box.h - last.h) < 0.012 &&
        box.x <= last.x + last.w + 0.012
      ) {
        const right = Math.max(last.x + last.w, box.x + box.w);
        const bottom = Math.max(last.y + last.h, box.y + box.h);
        last.x = Math.min(last.x, box.x);
        last.y = Math.min(last.y, box.y);
        last.w = right - last.x;
        last.h = bottom - last.y;
      } else {
        merged.push({ ...box });
      }
    }
    for (const box of merged) out.push({ ...box, page });
  }
  return out;
}

function boxesFromRange(range: Range): SelBox[] {
  const boxes: SelBox[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.width < 1 || rect.height < 1) continue;
    const slot = slotAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!slot || slot.classList.contains("epub-slot")) continue;
    if (!slot.querySelector(".textLayer")) continue;
    const page = markPageIndex(slot.dataset.page);
    if (page == null) continue;
    const bound = slot.getBoundingClientRect();
    if (bound.width < 1 || bound.height < 1) continue;
    const x = (rect.left - bound.left) / bound.width;
    const y = (rect.top - bound.top) / bound.height;
    const w = rect.width / bound.width;
    const h = rect.height / bound.height;
    if (w < 0.002 || h < 0.002) continue;
    const x0 = Math.min(1, Math.max(0, x));
    const y0 = Math.min(1, Math.max(0, y));
    const x1 = Math.min(1, Math.max(0, x + w));
    const y1 = Math.min(1, Math.max(0, y + h));
    boxes.push({ page, x: x0, y: y0, w: Math.max(0.002, x1 - x0), h: Math.max(0.002, y1 - y0) });
  }
  return boxes;
}

function capturePageSelection(): { text: string; boxes: SelBox[] } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString();
  if (!text) return null;
  let inPage = false;
  const boxes: SelBox[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const node = range.commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el?.closest(".page-slot")) continue;
    inPage = true;
    boxes.push(...boxesFromRange(range));
  }
  if (!inPage) return null;
  return { text, boxes: mergeLineBoxes(boxes) };
}

async function copyText(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function placeSelMenu(clientX: number, clientY: number) {
  ui.selMenu.hidden = false;
  const menuW = ui.selMenu.offsetWidth || 168;
  const menuH = ui.selMenu.offsetHeight || 88;
  const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, clientX));
  const top = Math.min(window.innerHeight - menuH - 8, Math.max(8, clientY));
  ui.selMenu.style.left = `${left}px`;
  ui.selMenu.style.top = `${top}px`;
}

function onPagesContextMenu(e: MouseEvent) {
  if (!ui.selMenu || !ui.selMenuHl) return;
  const target = e.target as HTMLElement;
  if (target.closest("#comment-pop") || target.closest("#sel-menu")) return;
  const slot = target.closest<HTMLElement>(".page-slot");
  if (!slot) return;
  if (target.closest(".comment-pin")) return;
  e.preventDefault();
  const snap = capturePageSelection();
  if (!snap) {
    hideSelMenu();
    return;
  }
  selMenuPayload = snap;
  ui.selMenuHl.hidden = snap.boxes.length === 0;
  placeSelMenu(e.clientX, e.clientY);
}

function applyHighlightColor(color: string, activateTool = false) {
  const match = MARK_COLORS.find((c) => c.toLowerCase() === color.toLowerCase());
  if (!match) return;
  highlightColor = match;
  saveLayout();
  ui.colorWell.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) => {
    b.classList.toggle("on", b.dataset.color === highlightColor);
  });
  ui.selSwatches.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) => {
    b.classList.toggle("on", b.dataset.color === highlightColor);
  });
  if (activateTool) setTool("highlight");
}

function highlightFromSelection(color: string, payload: SelPayload | null = selMenuPayload) {
  hideSelMenu();
  if (!payload?.boxes.length) return;
  applyHighlightColor(color, false);
  for (const box of payload.boxes) {
    fileMarks.highlights.push({
      id: newMarkId(),
      page: box.page,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      color: highlightColor,
    });
  }
  paintAllMarks();
  void persistMarks();
  window.getSelection()?.removeAllRanges();
  syncPdfSelChrome();
}

/** HUD color well: highlight the current PDF selection, else pick color / draw. */
function applyChromeHighlightColor(color: string) {
  const snap = takeChromeSelection();
  if (snap?.boxes.length) {
    highlightFromSelection(color, snap);
    return;
  }
  if (snap) {
    applyHighlightColor(color, false);
    return;
  }
  applyHighlightColor(color, true);
}

function wireSelMenu() {
  if (!ui.selMenu || !ui.selSwatches || !ui.selCopy || !ui.selHighlight || !ui.selMenuHl) return;
  MARK_COLORS.forEach((color, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.dataset.color = color;
    btn.style.background = color;
    btn.title = MARK_COLOR_NAMES[i] || color;
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("on", color === highlightColor);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      highlightFromSelection(color);
    });
    ui.selSwatches.append(btn);
  });
  ui.selCopy.addEventListener("click", () => {
    const text = selMenuPayload?.text || "";
    hideSelMenu();
    void copyText(text);
  });
  ui.selHighlight.addEventListener("click", () => {
    highlightFromSelection(highlightColor);
  });
}

function onPagesPointerDown(e: PointerEvent) {
  if (!hasDoc() || tool === "none" || e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest(".comment-pin") || target.closest("#comment-pop")) return;
  const slot = target.closest<HTMLElement>(".page-slot");
  if (!slot) return;
  const pt = pointInSlot(slot, e.clientX, e.clientY);
  if (!pt) return;
  const page = markPageIndex(slot.dataset.page);
  if (page == null) return;
  selectVisiblePage(page);
  if (tool === "comment") {
    e.preventDefault();
    pendingComment = { page, x: pt.x, y: pt.y };
    editingComment = null;
    setCommentText("");
    ui.commentDelete.hidden = true;
    placeCommentPop(e.clientX, e.clientY);
    return;
  }
  if (tool === "erase") {
    e.preventDefault();
    drag = { slot, page, x0: pt.x, y0: pt.y, pointer: e.pointerId, erase: true, dirty: false };
    slot.setPointerCapture(e.pointerId);
    if (eraseHighlightAt(page, pt.x, pt.y)) drag.dirty = true;
    return;
  }
  if (tool === "highlight") {
    e.preventDefault();
    drag = { slot, page, x0: pt.x, y0: pt.y, pointer: e.pointerId, erase: false, dirty: false };
    slot.setPointerCapture(e.pointerId);
  }
}

function slotAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const el = document.elementFromPoint(clientX, clientY);
  return el instanceof HTMLElement ? el.closest(".page-slot") : null;
}

function onPagesPointerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointer) return;
  if (drag.erase) {
    const slot = slotAtPoint(e.clientX, e.clientY) || drag.slot;
    const page = markPageIndex(slot.dataset.page);
    const pt = pointInSlot(slot, e.clientX, e.clientY);
    if (page != null && pt && eraseHighlightAt(page, pt.x, pt.y)) drag.dirty = true;
    return;
  }
  const pt = pointInSlot(drag.slot, e.clientX, e.clientY);
  if (!pt) return;
  showPreview(drag.slot, snapHighlight(drag.x0, drag.y0, pt.x, pt.y));
}

function onPagesPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointer) return;
  const { slot, page, x0, y0, erase, dirty } = drag;
  const pt = pointInSlot(slot, e.clientX, e.clientY) || { x: x0, y: y0 };
  showPreview(slot, null);
  drag = null;
  if (erase) {
    if (dirty) void persistMarks();
    return;
  }
  const box = snapHighlight(x0, y0, pt.x, pt.y);
  if (!box) {
    const hit = highlightAt(page, x0, y0);
    if (hit) {
      fileMarks.highlights = fileMarks.highlights.filter((h) => h.id !== hit.id);
      paintAllMarks();
      void persistMarks();
    }
    return;
  }
  fileMarks.highlights.push({
    id: newMarkId(),
    ...box,
    page,
    color: highlightColor,
  });
  paintAllMarks();
  void persistMarks();
}

async function unloadDocument() {
  window.clearTimeout(epubFontLayoutTimer);
  epubFontLayoutTimer = 0;
  window.clearTimeout(persistPageTimer);
  persistPageTimer = 0;
  epubFontLayoutBusy = false;
  epubFontLayoutAgain = false;
  pendingEpubAnchor = null;
  clearLayoutPins();
  clearEpubLayoutCache();
  observer?.disconnect();
  observer = null;
  intersectingPages.clear();
  cancelAllPdfWork();
  await pdf?.cleanup();
  pdf = null;
  epubBook = null;
  epubPages = [];
  revokeBlobs(epubBlobs);
  epubBlobs = [];
  textCache.clear();
  hits = [];
  filePath = "";
  fileMarks = { highlights: [], comments: [] };
  searchQuery = "";
  searchBoxes.clear();
  setTool("none");
  closeCommentPop();
  hideSelMenu();
  hidePasswordPrompt();
  ui.pages.replaceChildren();
  ui.pages.style.removeProperty("--pages-pad-top");
  ui.pages.style.removeProperty("--pages-pad-bottom");
  tocHasEntries = false;
}

function showEmptyChrome() {
  ui.app.classList.remove("has-doc", "sidebar-open");
  ui.stage.classList.remove("has-doc");
  closeSidebar();
  syncContentsChrome();
  setFabPanel("closed");
  setEmptyHint(EMPTY_DROP_HINT);
  syncCaptionTitle();
}

let passwordWaiter: ((value: string | null) => void) | null = null;

function setPasswordBusy(busy: boolean) {
  ui.pwOpen.disabled = busy;
  ui.pwInput.disabled = busy;
}

function hidePasswordPrompt() {
  const waiter = passwordWaiter;
  passwordWaiter = null;
  ui.pwOverlay.hidden = true;
  ui.pwInput.value = "";
  ui.pwError.hidden = true;
  ui.pwInput.removeAttribute("aria-invalid");
  setPasswordBusy(false);
  ui.app.inert = false;
  waiter?.(null);
}

function askPdfPassword(incorrect: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    passwordWaiter = resolve;
    ui.pwOverlay.hidden = false;
    ui.app.inert = true;
    ui.pwError.hidden = !incorrect;
    ui.pwInput.setAttribute("aria-invalid", incorrect ? "true" : "false");
    if (!incorrect) ui.pwInput.value = "";
    else ui.pwInput.select();
    setPasswordBusy(false);
    ui.pwInput.focus();
  });
}

function submitPasswordPrompt() {
  if (ui.pwOpen.disabled) return;
  const waiter = passwordWaiter;
  passwordWaiter = null;
  if (!waiter) return;
  waiter(ui.pwInput.value);
}

function cancelPasswordPrompt() {
  hidePasswordPrompt();
}

async function openPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy | null> {
  let password: string | undefined;
  while (true) {
    const data = bytes.slice();
    const loading =
      password !== undefined
        ? pdfjs.getDocument({ data, password })
        : pdfjs.getDocument({ data });
    try {
      const doc = await loading.promise;
      hidePasswordPrompt();
      return doc;
    } catch (err) {
      try {
        await loading.destroy();
      } catch {
        /* ignore */
      }
      const name = (err as { name?: string }).name;
      const code = (err as { code?: number }).code;
      if (name !== "PasswordException") {
        hidePasswordPrompt();
        throw err;
      }
      const need = code === pdfjs.PasswordResponses.NEED_PASSWORD;
      const incorrect = code === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      if (!need && !incorrect) {
        hidePasswordPrompt();
        throw err;
      }
      const entered = await askPdfPassword(incorrect);
      if (entered === null) return null;
      setPasswordBusy(true);
      password = entered;
    }
  }
}

function hintOrQuiet(opts: OpenOptions | undefined, text: string) {
  setEmptyHint(opts?.quiet ? EMPTY_DROP_HINT : text);
}

async function openDocument(path: string, data: Uint8Array, opts?: OpenOptions) {
  const lower = path.toLowerCase();
  if (!isPdfOrEpub(path)) {
    hintOrQuiet(opts, "Drop a PDF or EPUB file.");
    return;
  }
  if (!data.byteLength) {
    hintOrQuiet(opts, "That file is empty.");
    return;
  }
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  persistCurrentPage();
  const tab = upsertTab(path, isNativeFsPath(path) ? undefined : { bytes });
  const gen = ++loadGen;
  activeTabId = tab.id;
  renderTabs();
  await unloadDocument();
  if (gen !== loadGen) return;
  filePath = path;
  try {
    if (lower.endsWith(".epub")) {
      const opened = await openEpub(bytes);
      if (gen !== loadGen) {
        revokeBlobs(opened.blobs);
        return;
      }
      epubBook = opened.book;
      epubBlobs = opened.blobs;
      renderEpubToc(epubBook.toc, ui.tocList);
    } else {
      const doc = await openPdfDocument(bytes);
      if (gen !== loadGen) {
        await doc?.cleanup();
        return;
      }
      if (!doc) {
        await closeTab(tab.id);
        return;
      }
      pdf = doc;
      const outline = await pdf.getOutline();
      if (gen !== loadGen) return;
      renderPdfToc(outline, ui.tocList);
    }
  } catch (err) {
    hidePasswordPrompt();
    if (gen !== loadGen) return;
    if (err instanceof EpubError && err.kind === "drm") {
      hintOrQuiet(opts, "Password-locked or DRM-protected EPUB will not open.");
      await closeTab(tab.id);
      return;
    }
    hintOrQuiet(
      opts,
      lower.endsWith(".epub") ? "Could not open that EPUB." : "Could not open that PDF.",
    );
    await closeTab(tab.id);
    return;
  }
  if (gen !== loadGen) return;
  fileMarks = await marksFor(path);
  if (gen !== loadGen) return;
  ui.app.classList.add("has-doc");
  ui.stage.classList.add("has-doc");
  tab.title = documentCaption();
  renderTabs();
  syncCaptionTitle();
  renderBookmarks();
  try {
    await layoutPages({ page: fileMemory().page || 1 });
  } catch {
    if (gen !== loadGen) return;
    hintOrQuiet(
      opts,
      lower.endsWith(".epub") ? "Could not display that EPUB." : "Could not display that PDF.",
    );
    ui.app.classList.remove("has-doc");
    ui.stage.classList.remove("has-doc");
    return;
  }
  if (gen !== loadGen) return;
  setPageLabel();
  rememberLastPath(path);
}

async function openPath(path: string, opts?: OpenOptions) {
  const normalized = normalizeFsPath(path);
  if (!isPdfOrEpub(normalized)) {
    hintOrQuiet(opts, "Drop a PDF or EPUB file.");
    return;
  }
  if (!opts?.force) {
    const existing = findTabByPath(normalized);
    if (existing && existing.id === activeTabId && hasDoc()) {
      renderTabs();
      return;
    }
    if (existing && existing.id !== activeTabId) {
      await activateTab(existing.id);
      return;
    }
  }
  let data: Uint8Array;
  try {
    data = await readDocumentBytes(normalized);
  } catch {
    hintOrQuiet(opts, "Could not read that file.");
    return;
  }
  await openDocument(normalized, data, opts);
}

async function openMany(paths: string[], opts?: OpenOptions) {
  const unique = dedupePaths(paths);
  if (!unique.length) return;
  unique.forEach((p) => upsertTab(p));
  renderTabs();
  await openPath(unique[unique.length - 1], opts);
}

async function restoreLastDocument() {
  if (!inTauri()) return;
  const fromQuery = bootOpenPath();
  if (fromQuery) {
    if (await lastPathStillThere(fromQuery)) await openPath(fromQuery, { quiet: true });
    return;
  }
  try {
    const launched = await invoke<string[]>("launch_paths");
    const existing: string[] = [];
    for (const raw of launched || []) {
      const path = normalizeFsPath(String(raw || ""));
      if (path && isPdfOrEpub(path) && (await lastPathStillThere(path))) existing.push(path);
    }
    if (existing.length) {
      await openMany(existing, { quiet: true });
      return;
    }
  } catch {
    /* missing command */
  }
  const path = await readLastPath();
  if (!path) return;
  if (!(await lastPathStillThere(path))) return;
  await openPath(path, { quiet: true });
}

async function openFromFile(file: File) {
  const nativePath = (file as File & { path?: string }).path;
  if (nativePath) {
    await openPath(nativePath);
    return;
  }
  const name = file.name || "";
  if (!isPdfOrEpub(name)) {
    setEmptyHint("Drop a PDF or EPUB file.");
    return;
  }
  try {
    await openDocument(name, new Uint8Array(await file.arrayBuffer()));
  } catch {
    setEmptyHint("Could not read that file.");
  }
}

async function openFiles(files: File[]) {
  const list = files.filter((f) => isPdfOrEpub(f.name || ""));
  if (!list.length) {
    setEmptyHint("Drop a PDF or EPUB file.");
    return;
  }
  const native = list
    .map((f) => String((f as File & { path?: string }).path || ""))
    .filter((p) => isNativeFsPath(p));
  if (native.length === list.length) {
    await openMany(native);
    return;
  }
  for (const file of list) await openFromFile(file);
}

async function pickAndOpen() {
  if (inTauri()) {
    try {
      const selected = await openDialog({
        multiple: true,
        title: "Open",
        filters: [{ name: "PDF or EPUB", extensions: ["pdf", "epub"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await openMany(paths);
      return;
    } catch {
      /* fall through to the hidden file input */
    }
  }
  ui.fileOpen.click();
}

function isFileDrag(e: DragEvent): boolean {
  if (tabDragId) return false;
  return Boolean(e.dataTransfer?.types?.includes("Files"));
}

function listenHtmlDrop() {
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    ui.app.classList.add("dragover");
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragenter", onDragOver);
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null || e.target === document.documentElement) {
      ui.app.classList.remove("dragover");
    }
  });
  window.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    ui.app.classList.remove("dragover");
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) void openFiles(files);
  });
}

function listenTauriDrop() {
  const onEvent = (event: { payload: { type: string; paths?: string[] } }) => {
    const type = event.payload.type;
    ui.app.classList.toggle("dragover", type === "enter" || type === "over");
    if (type === "leave" || type === "drop") ui.app.classList.remove("dragover");
    if (type === "drop") {
      const paths = (event.payload.paths || []).filter((p) => isPdfOrEpub(p));
      if (paths.length) void openMany(paths);
    }
  };
  try {
    void getCurrentWebview()
      .onDragDropEvent(onEvent as never)
      .catch(() => {
        try {
          void getCurrentWindow().onDragDropEvent(onEvent as never);
        } catch {
          listenHtmlDrop();
        }
      });
  } catch {
    listenHtmlDrop();
  }
}

function toggleTheme() {
  applyThemePref(THEME_NEXT[themePref]);
}

function toggleSidebar() {
  if (ui.sidebar.hidden) {
    if (!hasSidebarLists()) return;
    ui.sidebar.hidden = false;
    ui.app.classList.add("sidebar-open");
    return;
  }
  closeSidebar();
}

function toggleBookmark() {
  if (!hasDoc()) return;
  saveMemory((m) => {
    const set = new Set(m[filePath].bookmarks);
    if (set.has(currentPage)) set.delete(currentPage);
    else set.add(currentPage);
    m[filePath].bookmarks = [...set];
  });
  renderBookmarks();
  refreshBookmarkCues();
  syncBookmarkIcon();
}

function unwrapSearchHits(root: ParentNode) {
  root.querySelectorAll("mark.search-hit").forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(el.textContent || ""), el);
    parent.normalize();
  });
}

function wrapSearchHits(root: HTMLElement, query: string) {
  unwrapSearchHits(root);
  const q = query.trim().toLowerCase();
  if (q.length < 2) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    if (!text) continue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx >= 0) {
      if (idx > last) frag.append(text.slice(last, idx));
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.append(mark);
      last = idx + q.length;
      idx = lower.indexOf(q, last);
    }
    if (last < text.length) frag.append(text.slice(last));
    node.parentNode?.replaceChild(frag, node);
  }
}

type PdfTextRun = { str: string; transform: number[]; width: number; height?: number };

function pdfItemNormBox(
  item: PdfTextRun,
  viewport: { width: number; height: number; convertToViewportPoint: (x: number, y: number) => number[] },
  charStart: number,
  charLen: number,
): { x: number; y: number; w: number; h: number } | null {
  const total = Math.max(1, item.str.length);
  const t0 = Math.min(1, Math.max(0, charStart / total));
  const t1 = Math.min(1, Math.max(t0, (charStart + charLen) / total));
  const x = item.transform[4] ?? 0;
  const y = item.transform[5] ?? 0;
  const fontH =
    Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) ||
    Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0) ||
    10;
  const left = x + item.width * t0;
  const right = x + item.width * t1;
  const a = viewport.convertToViewportPoint(left, y);
  const b = viewport.convertToViewportPoint(right, y + fontH);
  const vx1 = Math.min(a[0], b[0]);
  const vy1 = Math.min(a[1], b[1]);
  const vw = Math.abs(b[0] - a[0]);
  const vh = Math.abs(b[1] - a[1]);
  if (vw < 0.5 || vh < 0.5) return null;
  return {
    x: vx1 / viewport.width,
    y: vy1 / viewport.height,
    w: vw / viewport.width,
    h: vh / viewport.height,
  };
}

function matchBoxesFromItems(
  items: PdfTextRun[],
  query: string,
  viewport: { width: number; height: number; convertToViewportPoint: (x: number, y: number) => number[] },
): { x: number; y: number; w: number; h: number }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const parts: { start: number; item: PdfTextRun }[] = [];
  let hay = "";
  for (const item of items) {
    if (!item.str) continue;
    if (hay.length) hay += " ";
    parts.push({ start: hay.length, item });
    hay += item.str;
  }
  const lower = hay.toLowerCase();
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  let idx = 0;
  while (boxes.length < 40) {
    const found = lower.indexOf(q, idx);
    if (found < 0) break;
    const end = found + q.length;
    for (const part of parts) {
      const pEnd = part.start + part.item.str.length;
      const overlapStart = Math.max(found, part.start);
      const overlapEnd = Math.min(end, pEnd);
      if (overlapEnd <= overlapStart) continue;
      const box = pdfItemNormBox(
        part.item,
        viewport,
        overlapStart - part.start,
        overlapEnd - overlapStart,
      );
      if (box) boxes.push(box);
    }
    idx = found + Math.max(1, q.length);
  }
  return boxes;
}

function clearFindHighlights() {
  searchQuery = "";
  searchBoxes.clear();
  ui.pages.querySelectorAll<HTMLElement>(".page-slot").forEach((slot) => {
    const svg = slot.querySelector(".search-layer");
    svg?.replaceChildren();
    const inner = slot.querySelector<HTMLElement>(".epub-inner");
    if (inner) unwrapSearchHits(inner);
  });
}

async function boxesForPdfPage(pageNumber: number): Promise<{ x: number; y: number; w: number; h: number }[]> {
  if (searchBoxes.has(pageNumber)) return searchBoxes.get(pageNumber) || [];
  if (!pdf || searchQuery.length < 2) {
    searchBoxes.set(pageNumber, []);
    return [];
  }
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PdfTextRun[] = content.items.flatMap((item) => {
    if (!("str" in item)) return [];
    return [
      {
        str: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height,
      },
    ];
  });
  const boxes = matchBoxesFromItems(items, searchQuery, viewport);
  searchBoxes.set(pageNumber, boxes);
  return boxes;
}

async function paintSearchOnSlot(slot: HTMLElement) {
  const svg = slot.querySelector(".search-layer");
  const inner = slot.querySelector<HTMLElement>(".epub-inner");
  if (inner) {
    wrapSearchHits(inner, searchQuery);
  }
  if (!svg) return;
  svg.replaceChildren();
  if (searchQuery.length < 2 || epubBook) return;
  const page = Number(slot.dataset.page);
  const boxes = await boxesForPdfPage(page);
  for (const box of boxes) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "search-rect");
    rect.setAttribute("x", String(box.x));
    rect.setAttribute("y", String(box.y));
    rect.setAttribute("width", String(box.w));
    rect.setAttribute("height", String(box.h));
    svg.append(rect);
  }
}

async function paintAllSearch() {
  const slots = [...ui.pages.querySelectorAll<HTMLElement>(".page-slot")];
  await Promise.all(slots.map((slot) => paintSearchOnSlot(slot)));
}

async function pageText(pageNumber: number): Promise<string> {
  const cached = textCache.get(pageNumber);
  if (cached !== undefined) return cached;
  if (epubBook) {
    const text = epubPages[pageNumber - 1]?.text || "";
    textCache.set(pageNumber, text);
    return text;
  }
  if (!pdf) return "";
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")
    .slice(0, 200_000);
  textCache.set(pageNumber, text);
  return text;
}

async function runFind() {
  const q = ui.findInput.value.trim().toLowerCase();
  hits = [];
  hitIndex = -1;
  const total = pageCount();
  if (!hasDoc() || q.length < 2) {
    ui.findStatus.textContent = q.length ? "Type 2+ characters" : "";
    clearFindHighlights();
    return;
  }
  searchQuery = q;
  searchBoxes.clear();
  void paintAllSearch();
  ui.findStatus.textContent = "Searching…";
  const start = currentPage;
  const order: number[] = [];
  for (let i = start; i <= total; i++) order.push(i);
  for (let i = 1; i < start; i++) order.push(i);
  for (let i = 0; i < order.length; i += 6) {
    if (ui.findInput.value.trim().toLowerCase() !== q) return;
    const batch = order.slice(i, i + 6);
    await Promise.all(
      batch.map(async (page) => {
        const text = await pageText(page);
        if (text.toLowerCase().includes(q)) hits.push({ page });
      }),
    );
    hits.sort((a, b) => a.page - b.page);
    ui.findStatus.textContent = hits.length
      ? `${hits.length} page${hits.length === 1 ? "" : "s"}`
      : "Searching…";
  }
  ui.findStatus.textContent = hits.length ? `${hits.length} page(s)` : "No matches";
  if (hits.length) {
    hitIndex = 0;
    goToPage(hits[0].page);
  }
}

function jumpHit(delta: number) {
  if (!hits.length) return;
  hitIndex = (hitIndex + delta + hits.length) % hits.length;
  goToPage(hits[hitIndex].page);
  ui.findStatus.textContent = `${hitIndex + 1} / ${hits.length}`;
}

async function printDoc() {
  if (!hasDoc()) return;
  if (pdf) {
    const slots = [...ui.pages.querySelectorAll<HTMLElement>(".page-slot")];
    for (const slot of slots) {
      const page = Number(slot.dataset.page);
      await paintPage(page);
    }
  } else if (epubBook) {
    for (let i = 1; i <= pageCount(); i++) paintEpubPage(i);
  }
  setPageLabel();
  window.print();
}

async function relayoutKeepingPage() {
  const anchor = pendingEpubAnchor ?? captureViewAnchor();
  pendingEpubAnchor = null;
  textCache.clear();
  try {
    await layoutPages(anchor);
  } catch {
    applyEpubFontToDom(epubFontPx);
  }
  setPageLabel();
}

function rememberEpubAnchor() {
  if (!pendingEpubAnchor) pendingEpubAnchor = captureViewAnchor();
}

async function flushEpubFontLayout() {
  window.clearTimeout(epubFontLayoutTimer);
  epubFontLayoutTimer = 0;
  if (epubFontLayoutBusy) {
    epubFontLayoutAgain = true;
    return;
  }
  epubFontLayoutBusy = true;
  pinnedEpubMetrics = null;
  const anchor = pendingEpubAnchor ?? captureViewAnchor();
  try {
    do {
      epubFontLayoutAgain = false;
      textCache.clear();
      try {
        await layoutPages(anchor);
      } catch {
        applyEpubFontToDom(epubFontPx);
      }
      setPageLabel();
    } while (epubFontLayoutAgain);
  } finally {
    epubFontLayoutBusy = false;
    if (!epubFontLayoutTimer) pendingEpubAnchor = null;
  }
}

function scheduleEpubFontLayout() {
  window.clearTimeout(epubFontLayoutTimer);
  epubFontLayoutTimer = window.setTimeout(() => {
    void flushEpubFontLayout();
  }, EPUB_FONT_LAYOUT_MS);
}

async function setScale(next: number) {
  if (epubBook) return;
  const old = scale;
  const clamped = clampScale(next);
  if (pinnedPdfUsedScale != null && old > 0) {
    pinnedPdfUsedScale = Math.max(0.05, pinnedPdfUsedScale * (clamped / old));
  }
  scale = clamped;
  saveLayout();
  await relayoutKeepingPage();
}

async function fitToStage() {
  if (!hasDoc()) return;
  clearLayoutPins();
  if (epubBook) {
    const next = fitEpubFontPx();
    if (next === epubFontPx) {
      saveLayout();
      await relayoutKeepingPage();
      return;
    }
    await setEpubFontPx(next);
    return;
  }
  if (!pdf) return;
  const first = await pdf.getPage(1);
  if (!pdf) return;
  const native = first.getViewport({ scale: 1 });
  const cols = resolveColumns(native.width / native.height);
  if (columns === 0 || cols >= 2) {
    scale = 1;
  } else {
    const contain = autoSpreadScale(native.width, native.height, cols);
    const widthScale = manualSlotWidth(cols) / Math.max(1, native.width);
    scale = clampScale(contain / Math.max(0.001, widthScale));
  }
  saveLayout();
  await relayoutKeepingPage();
}

async function setEpubFontPx(next: number) {
  if (!epubBook) return;
  const px = clampEpubFont(next);
  if (px === epubFontPx) {
    setPageLabel();
    return;
  }
  rememberEpubAnchor();
  epubFontPx = px;
  saveLayout();
  applyEpubFontToDom(px);
  setPageLabel();
  scheduleEpubFontLayout();
}

function nudgeViewSize(direction: 1 | -1) {
  if (epubBook) {
    void setEpubFontPx(epubFontPx + direction * EPUB_FONT_STEP);
    return;
  }
  void setScale(scale + direction * 0.15);
}

async function applyColumns(n: 0 | 1 | 2) {
  const anchor = captureViewAnchor();
  let sameSpread = true;
  if (pdf) {
    const first = await pdf.getPage(1);
    if (!pdf) {
      columns = n;
      saveLayout();
      syncLayoutButtons();
      return;
    }
    const native = first.getViewport({ scale: 1 });
    const aspect = native.width / native.height;
    sameSpread = resolveColumnsPref(columns, aspect) === resolveColumnsPref(n, aspect);
  } else if (epubBook) {
    sameSpread = resolveEpubColumnsPref(columns) === resolveEpubColumnsPref(n);
  }
  columns = n;
  if (!sameSpread) clearLayoutPins();
  saveLayout();
  syncLayoutButtons();
  if (!hasDoc()) return;
  await layoutPages(anchor, { preserveZoom: sameSpread });
}

async function applySnap(snap: boolean) {
  scrollSnap = snap;
  saveLayout();
  syncLayoutButtons();
  if (!hasDoc()) return;
  // Relayout to snap-align the current row without refitting Auto contain-scale.
  await layoutPages(captureViewAnchor(), { preserveZoom: true });
}

function saveOpenComment() {
  const text = clipCommentText(ui.commentText.value.trim());
  if (editingComment) {
    if (!text) {
      fileMarks.comments = fileMarks.comments.filter((c) => c.id !== editingComment?.id);
    } else {
      editingComment.text = text;
    }
  } else if (pendingComment && text) {
    fileMarks.comments.push({
      id: newMarkId(),
      page: pendingComment.page,
      x: pendingComment.x,
      y: pendingComment.y,
      text,
    });
  }
  closeCommentPop();
  paintAllMarks();
  void persistMarks();
}

function deleteOpenComment() {
  if (editingComment) {
    fileMarks.comments = fileMarks.comments.filter((c) => c.id !== editingComment?.id);
  }
  closeCommentPop();
  paintAllMarks();
  void persistMarks();
}

const POMODORO_KEY = "paperweight.pomodoro";
/** One displayed minute. Keep at 60s in production. */
const POMODORO_MS_PER_MIN = 60_000;

type PomoDuration = 0 | 25 | 50;
type PomoReps = 2 | 3 | 4;
type PomoPhase = "idle" | "study" | "shortBreak" | "longBreak";

const POMO_DURATION_NEXT: Record<PomoDuration, PomoDuration> = {
  0: 25,
  25: 50,
  50: 0,
};
const POMO_REPS_NEXT: Record<PomoReps, PomoReps> = {
  2: 3,
  3: 4,
  4: 2,
};

let pomoDuration: PomoDuration = 0;
let pomoReps: PomoReps = 4;
let pomoPhase: PomoPhase = "idle";
let pomoCompleted = 0;
let pomoEndsAt = 0;
let pomoTimer = 0;

function pomoBreakMinutes(kind: "short" | "long"): number {
  if (pomoDuration !== 25 && pomoDuration !== 50) return 0;
  if (kind === "short") return pomoDuration === 25 ? 5 : 10;
  return pomoDuration === 25 ? 15 : 30;
}

function formatPomoTime(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function loadPomo() {
  try {
    const raw = JSON.parse(localStorage.getItem(POMODORO_KEY) || "{}") as {
      duration?: number;
      reps?: number;
    };
    if (raw.duration === 0 || raw.duration === 25 || raw.duration === 50) {
      pomoDuration = raw.duration;
    }
    if (raw.reps === 2 || raw.reps === 3 || raw.reps === 4) {
      pomoReps = raw.reps;
    }
  } catch {
    /* keep defaults */
  }
}

function savePomo() {
  localStorage.setItem(POMODORO_KEY, JSON.stringify({ duration: pomoDuration, reps: pomoReps }));
}

function stopPomoTimer() {
  window.clearInterval(pomoTimer);
  pomoTimer = 0;
}

function hidePomoOverlay() {
  ui.pomoOverlay.hidden = true;
}

function showPomoOverlay(kind: "short" | "long") {
  ui.pomoCopy.textContent =
    kind === "long"
      ? "This set is complete. Give yourself a longer pause before you begin another."
      : "Shift your focus away from the page. A short pause will help you return clearer.";
  ui.pomoOverlay.hidden = false;
  ui.pomoDismiss.focus();
}

function pomoDurPhrase(d: PomoDuration): string {
  return d === 0 ? "Off" : String(d);
}

function syncPomoUi(leftMs?: number) {
  const running = pomoPhase !== "idle" && pomoDuration !== 0;
  const left = leftMs ?? Math.max(0, pomoEndsAt - Date.now());
  const clock = running ? formatPomoTime(left) : "";
  ui.pomoBadge.hidden = !running;
  ui.pomoBadge.textContent = clock;
  if (!ui.pomoOverlay.hidden) ui.pomoBreakTime.textContent = formatPomoTime(left);

  const nextDur = POMO_DURATION_NEXT[pomoDuration];
  const durTitle = running
    ? `Pomodoro ${clock} · ${pomoDurPhrase(pomoDuration)} — click for ${pomoDurPhrase(nextDur)}`
    : `Pomodoro: ${pomoDurPhrase(pomoDuration)} — click for ${pomoDurPhrase(nextDur)}`;
  ui.pomodoro.title = durTitle;
  ui.pomodoro.setAttribute("aria-label", durTitle);
  ui.pomodoro.dataset.pomoDuration = String(pomoDuration);
  ui.pomodoro.classList.toggle("on", pomoDuration !== 0);
  ui.pomoDurLabel.textContent = pomoDuration === 0 ? "Off" : String(pomoDuration);

  const repsOff = pomoDuration === 0;
  const nextReps = POMO_REPS_NEXT[pomoReps];
  const repsTitle = `Repetitions: ${pomoReps} — click for ${nextReps}`;
  ui.pomoRepsBtn.hidden = repsOff;
  ui.pomoRepsBtn.title = repsTitle;
  ui.pomoRepsBtn.setAttribute("aria-label", repsTitle);
  ui.pomoRepsLabel.textContent = String(pomoReps);
}

function cyclePomoDuration() {
  applyPomoDuration(POMO_DURATION_NEXT[pomoDuration]);
}

function cyclePomoReps() {
  if (pomoDuration === 0) return;
  applyPomoReps(POMO_REPS_NEXT[pomoReps]);
}

function stopPomoKeepSettings() {
  stopPomoTimer();
  pomoPhase = "idle";
  pomoCompleted = 0;
  pomoEndsAt = 0;
  hidePomoOverlay();
  syncPomoUi();
}

function startPomoTicker() {
  stopPomoTimer();
  tickPomo();
  pomoTimer = window.setInterval(tickPomo, 1000);
}

function startPomoStudy() {
  if (pomoDuration !== 25 && pomoDuration !== 50) {
    stopPomoKeepSettings();
    return;
  }
  hidePomoOverlay();
  pomoPhase = "study";
  pomoEndsAt = Date.now() + pomoDuration * POMODORO_MS_PER_MIN;
  startPomoTicker();
}

function startPomoBreak(kind: "short" | "long") {
  const mins = pomoBreakMinutes(kind);
  pomoPhase = kind === "short" ? "shortBreak" : "longBreak";
  pomoEndsAt = Date.now() + mins * POMODORO_MS_PER_MIN;
  showPomoOverlay(kind);
  startPomoTicker();
}

function onPomoPeriodEnd() {
  if (pomoPhase === "study") {
    pomoCompleted += 1;
    if (pomoCompleted >= pomoReps) startPomoBreak("long");
    else startPomoBreak("short");
    return;
  }
  if (pomoPhase === "shortBreak") {
    if (pomoCompleted < pomoReps) startPomoStudy();
    else stopPomoKeepSettings();
    return;
  }
  stopPomoKeepSettings();
}

function tickPomo() {
  if (pomoPhase === "idle") return;
  const left = pomoEndsAt - Date.now();
  if (left <= 0) {
    stopPomoTimer();
    onPomoPeriodEnd();
    return;
  }
  syncPomoUi(left);
}

function applyPomoDuration(d: PomoDuration) {
  const same = d === pomoDuration;
  pomoDuration = d;
  savePomo();
  if (d === 0) {
    stopPomoKeepSettings();
    return;
  }
  if (same && (pomoPhase === "study" || pomoPhase === "shortBreak" || pomoPhase === "longBreak")) {
    syncPomoUi();
    return;
  }
  pomoCompleted = 0;
  startPomoStudy();
}

function applyPomoReps(n: PomoReps) {
  pomoReps = n;
  savePomo();
  syncPomoUi();
}

function dismissPomoBreak() {
  if (pomoPhase !== "shortBreak" && pomoPhase !== "longBreak") return;
  onPomoPeriodEnd();
}

function wireColorWell() {
  preservePageSelection(ui.colorWell);
  ui.colorWell.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((btn, i) => {
    const color = btn.dataset.color || MARK_COLOR_DEFAULT;
    const name = MARK_COLOR_NAMES[i] || color;
    btn.style.background = color;
    btn.title = `${name} — highlight selected text`;
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("on", color === highlightColor);
    btn.addEventListener("click", () => {
      applyChromeHighlightColor(color);
    });
  });
}

function updateSnoozedUntil(): number {
  const raw = Number(localStorage.getItem(UPDATE_SNOOZE_KEY) || "0");
  return Number.isFinite(raw) ? raw : 0;
}

function snoozeUpdateCheck() {
  try {
    localStorage.setItem(UPDATE_SNOOZE_KEY, String(Date.now() + UPDATE_SNOOZE_MS));
  } catch {
    /* quota */
  }
}

/** Compares dotted version strings, e.g. "0.2.0" vs "0.1.1". Positive when `a` is newer. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let updateReleaseUrl = "";

function hideUpdateToast() {
  ui.updateToast.hidden = true;
}

function showUpdateToast(version: string, url: string) {
  updateReleaseUrl = url;
  ui.updateToastMsg.textContent = `Version ${version} is out — you're on ${APP_VERSION}.`;
  ui.updateToast.hidden = false;
}

function wireUpdateToast() {
  ui.updateToastDismiss.addEventListener("click", () => {
    snoozeUpdateCheck();
    hideUpdateToast();
  });
  ui.updateToastView.addEventListener("click", () => {
    void openUrl(updateReleaseUrl || UPDATE_FALLBACK_URL);
  });
}

async function checkForUpdate() {
  if (!inTauri()) return;
  if (Date.now() < updateSnoozedUntil()) return;
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6000);
    let res: Response;
    try {
      res = await fetch(UPDATE_CHECK_URL, {
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timer);
    }
    if (!res.ok) return;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name || "").replace(/^v/i, "").trim();
    if (!latest || !/^\d+(\.\d+)*$/.test(latest)) return;
    if (compareVersions(latest, APP_VERSION) > 0) {
      showUpdateToast(latest, data.html_url || UPDATE_FALLBACK_URL);
    }
  } catch {
    /* offline, rate-limited, or blocked — skip silently */
  }
}

function wire() {
  document.documentElement.classList.toggle("is-mac", isMacPlatform());
  applyThemePref(loadThemePref());
  wireTitlebar();
  wireTabs();
  wireUpdateToast();
  themeMedia.addEventListener("change", () => {
    if (themePref === "auto") applyThemePref("auto");
  });
  loadLayout();
  syncLayoutButtons();
  loadPomo();
  syncPomoUi();
  wireColorWell();
  wireSelMenu();
  setTool("none");
  document.addEventListener("selectionchange", syncPdfSelChrome);

  ui.fabToggle.addEventListener("click", () => {
    const panel = fabPanel();
    if (panel === "closed") setFabPanel("menu");
    else if (panel === "menu") setFabPanel("closed");
    else setFabPanel("menu");
  });
  ui.fab.addEventListener("mouseleave", () => {
    setFabPanel("closed");
  });
  ui.contents.addEventListener("click", toggleSidebar);
  ui.bookmark.addEventListener("click", toggleBookmark);
  preservePageSelection(ui.highlight);
  ui.highlight.addEventListener("click", () => {
    const snap = takeChromeSelection();
    if (snap?.boxes.length) {
      highlightFromSelection(highlightColor, snap);
      return;
    }
    setTool(tool === "highlight" ? "none" : "highlight");
  });
  ui.erase.addEventListener("click", () => {
    setTool(tool === "erase" ? "none" : "erase");
  });
  ui.comment.addEventListener("click", () => {
    setTool(tool === "comment" ? "none" : "comment");
  });
  ui.theme.addEventListener("click", () => {
    closeFabFlyout();
    toggleTheme();
  });
  ui.find.addEventListener("click", () => {
    setFabPanel(fabPanel() === "search" ? "menu" : "search");
  });
  ui.pomodoro.addEventListener("click", () => {
    closeFabFlyout();
    cyclePomoDuration();
  });
  ui.pomoRepsBtn.addEventListener("click", () => {
    closeFabFlyout();
    cyclePomoReps();
  });
  ui.pomoDismiss.addEventListener("click", dismissPomoBreak);
  document.addEventListener("visibilitychange", () => {
    if (pomoPhase !== "idle") tickPomo();
  });
  ui.print.addEventListener("click", () => {
    closeFabFlyout();
    void printDoc();
  });
  ui.scroll.addEventListener("click", () => {
    closeFabFlyout();
    void applySnap(!scrollSnap);
  });
  ui.columns.addEventListener("click", () => {
    closeFabFlyout();
    void applyColumns(nextColumns(columns));
  });
  ui.zoomIn.addEventListener("click", () => {
    nudgeViewSize(1);
    ui.zoomIn.blur();
  });
  ui.zoomOut.addEventListener("click", () => {
    nudgeViewSize(-1);
    ui.zoomOut.blur();
  });
  ui.fitPage.addEventListener("click", () => {
    void fitToStage();
    ui.fitPage.blur();
  });
  ui.pageInput.addEventListener("focus", () => {
    ui.hudBottom.classList.add("is-editing");
    ui.pageInput.select();
  });
  ui.pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpToTypedPage();
      ui.pageInput.blur();
    }
  });
  ui.pageInput.addEventListener("blur", () => {
    ui.hudBottom.classList.remove("is-editing");
    jumpToTypedPage();
  });
  ui.hudBottom.addEventListener("mouseleave", () => {
    ui.pageInput.blur();
    ui.zoomIn.blur();
    ui.zoomOut.blur();
    ui.fitPage.blur();
    ui.hudBottom.classList.remove("is-editing");
  });
  ui.findPrev.addEventListener("click", () => jumpHit(-1));
  ui.findNext.addEventListener("click", () => jumpHit(1));
  ui.findInput.addEventListener("input", () => {
    window.clearTimeout(findTimer);
    findTimer = window.setTimeout(() => void runFind(), 200);
  });
  ui.findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpHit(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      setFabPanel("menu");
    }
  });
  ui.commentText.addEventListener("input", onCommentInput);
  ui.commentText.addEventListener("paste", onCommentPaste);
  ui.commentSave.addEventListener("click", saveOpenComment);
  ui.commentDelete.addEventListener("click", deleteOpenComment);
  ui.commentCancel.addEventListener("click", cancelCommentMode);
  ui.commentClose.addEventListener("click", cancelCommentMode);
  ui.pwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitPasswordPrompt();
  });
  ui.pwCancel.addEventListener("click", cancelPasswordPrompt);
  ui.pages.addEventListener("pointerdown", onPagesPointerDown);
  ui.pages.addEventListener("pointermove", onPagesPointerMove);
  ui.pages.addEventListener("pointerup", onPagesPointerUp);
  ui.pages.addEventListener("pointercancel", onPagesPointerUp);
  ui.pages.addEventListener("contextmenu", onPagesContextMenu);
  ui.pages.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || tool !== "none") return;
    const layer = (e.target as HTMLElement).closest(".textLayer");
    layer?.classList.add("selecting");
  });
  window.addEventListener("pointerup", () => {
    ui.pages.querySelectorAll(".textLayer.selecting").forEach((el) => {
      el.classList.remove("selecting");
    });
  });
  ui.selMenu.addEventListener("contextmenu", (e) => e.preventDefault());
  ui.pages.addEventListener("click", (e) => {
    if (!hasDoc()) return;
    const slot = (e.target as HTMLElement).closest<HTMLElement>(".page-slot");
    if (!slot) return;
    selectVisiblePage(Number(slot.dataset.page));
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      // WebView has no native window fullscreen; preventDefault only inside Tauri
      // so a plain browser preview can still use the browser's F11.
      if ("__TAURI_INTERNALS__" in window) {
        e.preventDefault();
        if (!e.repeat) void toggleFullscreen();
      }
      return;
    }
    if (!ui.pwOverlay.hidden) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPasswordPrompt();
      }
      return;
    }
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void pickAndOpen();
    }
    if (meta && e.key.toLowerCase() === "f" && hasDoc()) {
      e.preventDefault();
      setFabPanel("search");
    }
    if (meta && e.key.toLowerCase() === "p" && hasDoc()) {
      e.preventDefault();
      void printDoc();
    }
    if (e.key === "Escape") {
      if (!ui.selMenu.hidden) {
        e.preventDefault();
        hideSelMenu();
        return;
      }
      if (!ui.commentPop.hidden) {
        e.preventDefault();
        cancelCommentMode();
        return;
      }
      if (fabPanel() === "search" || e.target === ui.findInput) {
        if (fabPanel() === "search") setFabPanel("menu");
        return;
      }
      if (!ui.pomoOverlay.hidden) {
        e.preventDefault();
        dismissPomoBreak();
        return;
      }
      if (appFullscreen) {
        e.preventDefault();
        void setAppFullscreen(false);
        return;
      }
      if (tool !== "none") {
        setTool("none");
        return;
      }
      setFabPanel("closed");
    }
  });

  document.addEventListener("pointerdown", (e) => {
    if (!ui.selMenu.hidden && !ui.selMenu.contains(e.target as Node)) {
      hideSelMenu();
    }
    if (!ui.commentPop.hidden && !ui.commentPop.contains(e.target as Node)) {
      const t = e.target as HTMLElement;
      if (t.closest(".comment-pin")) {
        /* pin click opens the editor */
      } else if (t.closest("#btn-comment")) {
        closeCommentPop();
      } else if (tool === "comment" && t.closest(".page-slot")) {
        /* placing another pin */
      } else {
        cancelCommentMode();
      }
    }
    if (fabPanel() === "closed") return;
    if (ui.fab.contains(e.target as Node)) return;
    setFabPanel("closed");
  });

  ui.stage.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !hasDoc()) return;
      e.preventDefault();
      if (epubBook) {
        void setEpubFontPx(epubFontPx + (e.deltaY < 0 ? EPUB_FONT_STEP : -EPUB_FONT_STEP));
      } else {
        void setScale(scale + (e.deltaY < 0 ? 0.1 : -0.1));
      }
    },
    { passive: false },
  );

  let pageSyncRaf = 0;
  ui.stage.addEventListener(
    "scroll",
    () => {
      if (pageSyncRaf) return;
      pageSyncRaf = requestAnimationFrame(() => {
        pageSyncRaf = 0;
        if (!ui.selMenu.hidden) hideSelMenu();
        syncCurrentPageFromView();
        if (pdf) {
          ensureVisiblePdfText();
          schedulePdfPrune();
        }
      });
    },
    { passive: true },
  );

  ui.empty.addEventListener("click", () => void pickAndOpen());
  ui.fileOpen.addEventListener("change", () => {
    const files = [...(ui.fileOpen.files || [])];
    ui.fileOpen.value = "";
    if (files.length) void openFiles(files);
  });

  let resizeTimer = 0;
  const resize = new ResizeObserver(() => {
    if (!hasDoc()) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (Date.now() < ignoreRefitUntil) return;
      clearLayoutPins();
      void layoutPages(captureViewAnchor());
    }, 120);
  });
  resize.observe(ui.stage);

  if (inTauri()) listenTauriDrop();
  else listenHtmlDrop();

  void restoreLastDocument();
  window.setTimeout(() => void checkForUpdate(), 1500);
}

wire();
