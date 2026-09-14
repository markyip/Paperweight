import { invoke } from "@tauri-apps/api/core";

export const MARK_COLORS = ["#FACC15", "#EF4444", "#22C55E", "#3B82F6"] as const;
export const MARK_COLOR_NAMES = ["Yellow", "Red", "Green", "Blue"] as const;
export const MARK_COLOR_DEFAULT = MARK_COLORS[0];
export const MARK_FILL_ALPHA = 0.4;
export const COMMENT_MAX_LENGTH = 2000;

/** Cap comment text on save. Load/display may still exceed this. */
export function clipCommentText(text: string): string {
  const raw = text ?? "";
  return raw.length <= COMMENT_MAX_LENGTH ? raw : raw.slice(0, COMMENT_MAX_LENGTH);
}

const STORAGE_KEY = "paperweight.marks";
const LEGACY_STORAGE_KEY = "pageviewer.marks";

export type HighlightMark = {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
};

export type CommentMark = {
  id: string;
  page: number;
  x: number;
  y: number;
  text: string;
};

export type FileMarks = {
  highlights: HighlightMark[];
  comments: CommentMark[];
};

export type MarksStore = Record<string, FileMarks>;

function emptyMarks(): FileMarks {
  return { highlights: [], comments: [] };
}

/** 1-based page number from a mark or slot. Invalid values do not match any page. */
export function markPageIndex(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const page = Math.trunc(n);
  return page >= 1 ? page : null;
}

/** Marks drawn on *slotPage* only — never cloned onto other page slots. */
export function marksOnPage<T extends { page: unknown }>(items: T[], slotPage: unknown): T[] {
  const page = markPageIndex(slotPage);
  if (page == null) return [];
  return items.filter((item) => markPageIndex(item.page) === page);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function newMarkId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Snap a drag to a horizontal or vertical highlighter bar in 0–1 page space. */
export function snapHighlight(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness = 0.028,
): { x: number; y: number; w: number; h: number } | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.008) return null;
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  if (Math.abs(dx) >= Math.abs(dy)) {
    x = Math.min(x0, x1);
    w = Math.abs(dx);
    h = thickness;
    y = y0 - thickness / 2;
  } else {
    y = Math.min(y0, y1);
    h = Math.abs(dy);
    w = thickness;
    x = x0 - thickness / 2;
  }
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(1 - x, Math.max(0.004, w));
  h = Math.min(1 - y, Math.max(0.004, h));
  return { x, y, w, h };
}

function parseStore(raw: string | null | undefined): MarksStore {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as MarksStore;
    if (!data || typeof data !== "object") return {};
    return data;
  } catch {
    return {};
  }
}

function normalizeFile(raw: Partial<FileMarks> | undefined): FileMarks {
  const marks = emptyMarks();
  if (!raw) return marks;
  if (Array.isArray(raw.highlights)) {
    for (const h of raw.highlights) {
      const page = markPageIndex(h?.page);
      if (!h || typeof h.id !== "string" || page == null) continue;
      marks.highlights.push({ ...h, page });
    }
  }
  if (Array.isArray(raw.comments)) {
    for (const c of raw.comments) {
      const page = markPageIndex(c?.page);
      if (!c || typeof c.id !== "string" || page == null) continue;
      marks.comments.push({ ...c, page });
    }
  }
  return marks;
}

let cache: MarksStore | null = null;

export async function loadMarksStore(): Promise<MarksStore> {
  if (cache) return cache;
  try {
    const json = await invoke<string>("load_marks");
    cache = parseStore(json);
    if (Object.keys(cache).length === 0) {
      const local = parseStore(
        localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY),
      );
      if (Object.keys(local).length) cache = local;
    }
    return cache;
  } catch {
    cache = parseStore(
      localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY),
    );
    return cache;
  }
}

export async function saveMarksStore(store: MarksStore): Promise<void> {
  cache = store;
  const json = JSON.stringify(store);
  localStorage.setItem(STORAGE_KEY, json);
  try {
    await invoke("save_marks", { json });
  } catch {
    /* browser / missing command */
  }
}

export async function marksFor(path: string): Promise<FileMarks> {
  const store = await loadMarksStore();
  return normalizeFile(store[path]);
}

export async function writeMarks(path: string, marks: FileMarks): Promise<void> {
  if (!path) return;
  const store = await loadMarksStore();
  store[path] = {
    highlights: marks.highlights.slice(-400),
    comments: marks.comments.slice(-200),
  };
  await saveMarksStore(store);
}

export function hexWithAlpha(hex: string, alpha = MARK_FILL_ALPHA): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const h = m ? m[1] : "FACC15";
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
