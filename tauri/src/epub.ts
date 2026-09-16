import JSZip from "jszip";

export class EpubError extends Error {
  constructor(
    message: string,
    readonly kind: "drm" | "open" = "open",
  ) {
    super(message);
    this.name = "EpubError";
  }
}

export type EpubTocEntry = {
  title: string;
  href: string;
  spineIndex: number;
  fragment: string;
  level: number;
};

export type EpubChapter = {
  idref: string;
  href: string;
  title: string;
  html: string;
  text: string;
};

export type EpubBook = {
  title: string;
  creator: string;
  chapters: EpubChapter[];
  toc: EpubTocEntry[];
};

export type EpubPage = {
  spine: number;
  offset: number;
  html: string;
  text: string;
  chapterHeight: number;
  /** Visible window into the chapter; may be shorter than the slot to avoid splitting a line. */
  sliceHeight: number;
};

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return (i >= 0 ? tag.slice(i + 1) : tag).toLowerCase();
}

function attr(el: Element, ...names: string[]): string {
  for (const name of names) {
    const value = el.getAttribute(name);
    if (value) return value;
    for (const a of Array.from(el.attributes)) {
      if (localName(a.name) === name.toLowerCase() && a.value) return a.value;
    }
  }
  return "";
}

export function joinHref(base: string, href: string): string {
  const path = (href || "").split("#", 1)[0].trim();
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) return norm(base);
  const folder = norm(base).split("/").slice(0, -1).join("/");
  const combined = folder ? `${folder}/${path}` : path;
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function zipName(zip: JSZip, name: string): string | null {
  const want = name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (zip.file(name)) return name;
  for (const key of Object.keys(zip.files)) {
    if (key.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase() === want) {
      return key;
    }
  }
  return null;
}

async function zipText(zip: JSZip, name: string): Promise<string> {
  const key = zipName(zip, name);
  if (!key) throw new Error(`Missing ${name}`);
  const file = zip.file(key);
  if (!file) throw new Error(`Missing ${name}`);
  return file.async("string");
}

async function zipBytes(zip: JSZip, name: string): Promise<Uint8Array | null> {
  const key = zipName(zip, name);
  if (!key) return null;
  const file = zip.file(key);
  if (!file) return null;
  return file.async("uint8array");
}

function parseXml(data: string): Document {
  const doc = new DOMParser().parseFromString(data, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid EPUB XML");
  }
  return doc;
}

function textOf(el: Element | null): string {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function dc(doc: Document, name: string): string {
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (localName(el.tagName) === name) {
      const t = textOf(el);
      if (t) return t;
    }
  }
  return "";
}

function stripInlineFontSize(html: string): string {
  html = html.replace(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/gi, (_all, q: string, style: string) => {
    const next = style
      .replace(/\bfont-size\s*:\s*[^;]+;?/gi, "")
      .replace(/\bposition\s*:\s*(fixed|sticky)\s*;?/gi, "")
      .replace(/\bfont\s*:\s*([^;]+)/gi, (_decl: string, value: string) => {
        const withoutSize = value
          .replace(
            /\b(?:\d+(?:\.\d+)?(?:px|pt|pc|in|cm|mm|%)|\d+(?:\.\d+)?\/\d+(?:\.\d+)?|xx?-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)\b/gi,
            "",
          )
          .replace(/\s+/g, " ")
          .trim();
        return withoutSize ? `font: ${withoutSize}` : "";
      })
      .replace(/^[;\s]+|[;\s]+$/g, "")
      .replace(/;;+/g, ";")
      .trim();
    return next ? ` style=${q}${next}${q}` : "";
  });
  return html.replace(/<font\b([^>]*)>/gi, (_all, attrs: string) => {
    return `<font${attrs.replace(/\ssize\s*=\s*(['"]).*?\1/gi, "").replace(/\ssize\s*=\s*[^\s>]+/gi, "")}>`;
  });
}

function cleanHtml(raw: string): string {
  let html = raw.replace(SCRIPT_RE, "").replace(STYLE_BLOCK_RE, "");
  html = html.replace(/<\?xml[^>]*\?>/gi, "");
  html = html.replace(/<!DOCTYPE[^>]*>/gi, "");
  html = stripInlineFontSize(html);
  return html.trim();
}

function bodyInner(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return (match ? match[1] : html).trim();
}

function headingTitle(html: string, fallback: string): string {
  const match = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!match) return fallback;
  const text = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function stripToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isHtmlMedia(media: string): boolean {
  const m = (media || "").toLowerCase();
  if (!m) return true;
  return m.includes("html") || m.includes("xml");
}

function isImageMedia(media: string): boolean {
  return (media || "").toLowerCase().startsWith("image/");
}

function mimeOf(href: string, media: string): string {
  if (media) return media;
  const ext = href.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return map[ext] || "application/octet-stream";
}

function rewriteResources(
  html: string,
  chapterHref: string,
  blobs: Map<string, string>,
): string {
  const resolveBlob = (src: string) => {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const resolved = joinHref(chapterHref, src);
    return (
      blobs.get(resolved) ||
      blobs.get(resolved.split("/").pop() || "") ||
      src
    );
  };
  html = html.replace(
    /\b(?:src|href)=(['"])([^'"]+)\1/gi,
    (all, quote: string, src: string) => {
      const attrName = all.slice(0, all.indexOf("="));
      if (attrName.toLowerCase() === "href" && !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(src)) {
        return all;
      }
      return `${attrName}=${quote}${resolveBlob(src)}${quote}`;
    },
  );
  html = html.replace(
    /\b(?:xlink:href|href)=(['"])([^'"]+\.(?:png|jpe?g|gif|webp|svg|avif))\1/gi,
    (all, quote: string, src: string) => {
      const attrName = all.slice(0, all.indexOf("="));
      return `${attrName}=${quote}${resolveBlob(src)}${quote}`;
    },
  );
  return html;
}

function walkNavPoints(
  parent: Element,
  level: number,
  opfDir: string,
  hrefToSpine: Map<string, number>,
  entries: EpubTocEntry[],
) {
  for (const child of Array.from(parent.children)) {
    if (localName(child.tagName) !== "navpoint") continue;
    let label = "";
    let href = "";
    for (const sub of Array.from(child.children)) {
      const loc = localName(sub.tagName);
      if (loc === "navlabel") label = textOf(sub);
      if (loc === "content") href = attr(sub, "src");
    }
    const [path, frag = ""] = href.split("#");
    let resolved = joinHref(`${opfDir}/dummy`, path);
    let spineIndex = hrefToSpine.get(resolved) ?? hrefToSpine.get(path) ?? -1;
    if (spineIndex < 0) {
      const base = resolved.split("/").pop() || "";
      for (const [key, idx] of hrefToSpine) {
        if (key.split("/").pop() === base) {
          spineIndex = idx;
          resolved = key;
          break;
        }
      }
    }
    if (label) {
      entries.push({ title: label, href: resolved, spineIndex, fragment: frag, level });
    }
    walkNavPoints(child, level + 1, opfDir, hrefToSpine, entries);
  }
}

function parseNcx(
  xml: string,
  opfDir: string,
  hrefToSpine: Map<string, number>,
): EpubTocEntry[] {
  const doc = parseXml(xml);
  const entries: EpubTocEntry[] = [];
  let navMap: Element | null = null;
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (localName(el.tagName) === "navmap") {
      navMap = el;
      break;
    }
  }
  if (navMap) walkNavPoints(navMap, 0, opfDir, hrefToSpine, entries);
  return entries;
}

function walkNavOl(
  ol: Element,
  level: number,
  navHref: string,
  hrefToSpine: Map<string, number>,
  entries: EpubTocEntry[],
) {
  for (const li of Array.from(ol.children)) {
    if (localName(li.tagName) !== "li") continue;
    let title = "";
    let href = "";
    let childOl: Element | null = null;
    for (const sub of Array.from(li.children)) {
      const loc = localName(sub.tagName);
      if (loc === "a" && !href) {
        href = attr(sub, "href");
        title = textOf(sub);
      } else if (loc === "span" && !title) {
        title = textOf(sub);
      } else if (loc === "ol") {
        childOl = sub;
      }
    }
    const [path, frag = ""] = href.split("#");
    let resolved = joinHref(navHref, path);
    let spineIndex = hrefToSpine.get(resolved) ?? -1;
    if (spineIndex < 0) {
      const base = resolved.split("/").pop() || "";
      for (const [key, idx] of hrefToSpine) {
        if (key.split("/").pop() === base) {
          spineIndex = idx;
          resolved = key;
          break;
        }
      }
    }
    if (title) {
      entries.push({ title, href: resolved, spineIndex, fragment: frag, level });
    }
    if (childOl) walkNavOl(childOl, level + 1, navHref, hrefToSpine, entries);
  }
}

function parseNavXhtml(
  xml: string,
  navHref: string,
  hrefToSpine: Map<string, number>,
): EpubTocEntry[] {
  const doc = parseXml(xml);
  let navEl: Element | null = null;
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (localName(el.tagName) !== "nav") continue;
    const epubType = (attr(el, "type") || "").toLowerCase();
    if (epubType.includes("toc") || !navEl) navEl = el;
    if (epubType.includes("toc")) break;
  }
  if (!navEl) return [];
  const entries: EpubTocEntry[] = [];
  for (const el of Array.from(navEl.getElementsByTagName("*"))) {
    if (localName(el.tagName) === "ol") {
      walkNavOl(el, 0, navHref, hrefToSpine, entries);
      break;
    }
  }
  return entries;
}

export async function openEpub(bytes: Uint8Array): Promise<{
  book: EpubBook;
  blobs: string[];
}> {
  if (!bytes.byteLength) throw new EpubError("Could not open that EPUB.");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (/encrypted|password/i.test(msg)) {
      throw new EpubError(
        "Password-locked or DRM-protected EPUB will not open.",
        "drm",
      );
    }
    throw new EpubError("Could not open that EPUB.");
  }

  const names = Object.keys(zip.files).map((n) =>
    n.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(),
  );
  if (
    names.some(
      (n) =>
        n === "meta-inf/encryption.xml" || n.endsWith("/meta-inf/encryption.xml"),
    )
  ) {
    throw new EpubError(
      "Password-locked or DRM-protected EPUB will not open.",
      "drm",
    );
  }

  const container = await zipText(zip, "META-INF/container.xml");
  const containerDoc = parseXml(container);
  let opfPath = "";
  for (const el of Array.from(containerDoc.getElementsByTagName("*"))) {
    if (localName(el.tagName) === "rootfile") {
      opfPath = attr(el, "full-path").replace(/\\/g, "/");
      if (opfPath) break;
    }
  }
  if (!opfPath) throw new EpubError("Could not open that EPUB.");

  const opfDir = opfPath.split("/").slice(0, -1).join("/");
  const opfDoc = parseXml(await zipText(zip, opfPath));
  const manifest = new Map<
    string,
    { href: string; media: string; properties: string }
  >();
  for (const el of Array.from(opfDoc.getElementsByTagName("*"))) {
    if (localName(el.tagName) !== "item") continue;
    const id = attr(el, "id");
    const href = attr(el, "href");
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      media: attr(el, "media-type", "media_type"),
      properties: attr(el, "properties"),
    });
  }

  const spineIds: string[] = [];
  for (const el of Array.from(opfDoc.getElementsByTagName("*"))) {
    if (localName(el.tagName) !== "itemref") continue;
    const idref = attr(el, "idref");
    const linear = (attr(el, "linear") || "yes").toLowerCase();
    if (linear === "no" || !idref) continue;
    spineIds.push(idref);
  }

  const blobs = new Map<string, string>();
  const blobUrls: string[] = [];
  let navHref = "";
  let ncxHref = "";

  for (const item of manifest.values()) {
    const abs = joinHref(`${opfDir}/dummy`, item.href);
    const props = (item.properties || "").toLowerCase().split(/\s+/);
    if (props.includes("nav")) navHref = abs;
    if (item.media === "application/x-dtbncx+xml") ncxHref = abs;
    if (!isImageMedia(item.media) && !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(item.href)) {
      continue;
    }
    const data = await zipBytes(zip, abs);
    if (!data) continue;
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const url = URL.createObjectURL(
      new Blob([copy], { type: mimeOf(item.href, item.media) }),
    );
    blobUrls.push(url);
    blobs.set(abs, url);
    blobs.set(abs.split("/").pop() || abs, url);
  }

  const chapters: EpubChapter[] = [];
  const hrefToSpine = new Map<string, number>();
  for (const idref of spineIds) {
    const item = manifest.get(idref);
    if (!item || !isHtmlMedia(item.media)) continue;
    const abs = joinHref(`${opfDir}/dummy`, item.href);
    let raw: string;
    try {
      raw = await zipText(zip, abs);
    } catch {
      continue;
    }
    const inner = rewriteResources(bodyInner(cleanHtml(raw)), abs, blobs);
    const fallback = (abs.split("/").pop() || "chapter").replace(/\.[^.]+$/, "");
    const title = headingTitle(inner, fallback);
    hrefToSpine.set(abs, chapters.length);
    hrefToSpine.set(item.href, chapters.length);
    hrefToSpine.set(abs.split("/").pop() || abs, chapters.length);
    chapters.push({
      idref,
      href: abs,
      title,
      html: inner,
      text: stripToText(inner),
    });
  }
  if (!chapters.length) throw new EpubError("Could not open that EPUB.");

  let toc: EpubTocEntry[] = [];
  if (navHref) {
    try {
      toc = parseNavXhtml(await zipText(zip, navHref), navHref, hrefToSpine);
    } catch {
      toc = [];
    }
  }
  if (!toc.length && ncxHref) {
    try {
      toc = parseNcx(await zipText(zip, ncxHref), opfDir, hrefToSpine);
    } catch {
      toc = [];
    }
  }
  if (!toc.length) {
    toc = chapters.map((ch, i) => ({
      title: ch.title,
      href: ch.href,
      spineIndex: i,
      fragment: "",
      level: 0,
    }));
  }

  const title =
    dc(opfDoc, "title") || chapters[0]?.title || "Untitled";
  const creator = dc(opfDoc, "creator");
  return {
    book: { title, creator, chapters, toc },
    blobs: blobUrls,
  };
}

let chapterInnerCache = new WeakMap<EpubChapter, HTMLElement>();
let measureHost: HTMLDivElement | null = null;

/** Matches `.epub-inner` padding `28px 32px 40px`. */
const EPUB_INNER_PAD_Y = 68;

function usesViewportLength(value: string): boolean {
  return /vh|vw|dvh|svh|lvh|dvw|svw|lvw/i.test(value);
}

function neutralizeEpubChrome(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const pos = (el.style.position || "").toLowerCase();
    if (pos === "fixed" || pos === "sticky") {
      el.style.position = "relative";
      el.style.top = "auto";
      el.style.left = "auto";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.inset = "auto";
      el.style.zIndex = "auto";
    }
    if (usesViewportLength(el.style.height)) el.style.height = "auto";
    if (usesViewportLength(el.style.minHeight)) el.style.minHeight = "0";
    if (usesViewportLength(el.style.maxHeight)) el.style.maxHeight = "";
    if (usesViewportLength(el.style.width)) el.style.width = "100%";
  }
}

function chapterInnerEl(ch: EpubChapter): HTMLElement {
  let el = chapterInnerCache.get(ch);
  if (!el) {
    el = document.createElement("div");
    el.className = "epub-inner";
    el.innerHTML = ch.html;
    neutralizeEpubChrome(el);
    chapterInnerCache.set(ch, el);
  }
  return el;
}

/** Clone a chapter’s already-parsed HTML for a visible page slot. */
export function cloneChapterInner(ch: EpubChapter): HTMLElement {
  const clone = chapterInnerEl(ch).cloneNode(true) as HTMLElement;
  clone.style.fontSize = "";
  clone.style.removeProperty("--epub-font-px");
  clone.style.transform = "";
  return clone;
}

/**
 * Offset (px) of an in-chapter anchor from the chapter's top, for resolving a
 * same-chapter `href="#id"` link click to the page slot that contains it.
 * Mounts the chapter's cached master element into the shared measurement host
 * (same one `measureChapter` uses) at the current reading font size — a stale
 * or missing font size would measure the wrong layout and return an offset
 * that lands in the wrong slice. Null if the fragment isn't found.
 */
export async function fragmentOffset(
  ch: EpubChapter,
  fragmentId: string,
  fontPx: number,
): Promise<number | null> {
  if (!fragmentId) return null;
  const host = getMeasureHost();
  const inner = chapterInnerEl(ch);
  inner.style.fontSize = `${fontPx}px`;
  inner.style.setProperty("--epub-font-px", `${fontPx}px`);
  inner.style.transform = "";
  host.replaceChildren(inner);
  await waitForMedia(inner);
  void host.offsetHeight;
  let target: Element | null = null;
  try {
    const escaped = CSS.escape(fragmentId);
    target = inner.querySelector(`#${escaped}`) || inner.querySelector(`[name="${escaped}"]`);
  } catch {
    /* invalid selector */
  }
  if (!target) return null;
  const origin = inner.getBoundingClientRect().top;
  return target.getBoundingClientRect().top - origin;
}

function getMeasureHost(): HTMLDivElement {
  if (!measureHost) {
    measureHost = document.createElement("div");
    measureHost.className = "epub-measure";
    measureHost.setAttribute("aria-hidden", "true");
  }
  if (!measureHost.isConnected) document.body.append(measureHost);
  return measureHost;
}

type BoxY = { top: number; bottom: number };

function collectFlowBoxes(
  inner: HTMLElement,
  height: number,
): { bottoms: number[]; lines: BoxY[] } {
  const origin = inner.getBoundingClientRect().top;
  const lines: BoxY[] = [];
  const bottoms: number[] = [];

  const pushLine = (top: number, bottom: number) => {
    if (bottom - top < 2) return;
    if (bottom <= 0 || top >= height) return;
    const box = {
      top: Math.max(0, top),
      bottom: Math.min(height, bottom),
    };
    lines.push(box);
    bottoms.push(box.bottom);
  };

  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      pushLine(rect.top - origin, rect.bottom - origin);
    }
  }

  for (const el of inner.querySelectorAll<HTMLElement>(
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, dt, dd",
  )) {
    const r = el.getBoundingClientRect();
    bottoms.push(Math.min(height, r.bottom - origin));
  }

  lines.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  bottoms.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const b of bottoms) {
    if (b <= 0.5 || b > height + 8) continue;
    if (!uniq.length || b > uniq[uniq.length - 1] + 0.5) uniq.push(b);
  }
  if (!uniq.length || uniq[uniq.length - 1] < height - 1) uniq.push(height);
  return { bottoms: uniq, lines };
}

function slicesForChapter(
  height: number,
  slice: number,
  bottoms: number[],
  unsplittable: BoxY[] = [],
): { offset: number; sliceHeight: number }[] {
  const h = Math.max(1, Math.round(height));
  const page = Math.max(120, Math.round(slice) - 8);
  const out: { offset: number; sliceHeight: number }[] = [];
  let y = 0;
  let i = 0;
  while (y < h) {
    const limit = Math.min(h, y + page);
    while (i < bottoms.length && bottoms[i] <= limit + 0.5) i++;
    let end = limit;
    if (i > 0 && bottoms[i - 1] > y + 4) {
      end = Math.min(h, Math.round(bottoms[i - 1]));
    }
    const cut = unsplittable.find(
      (b) => b.top < end - 0.5 && b.bottom > end + 0.5 && b.bottom - b.top > 4,
    );
    if (cut) {
      if (cut.top > y + 8) {
        end = Math.min(h, Math.round(cut.top));
      } else if (cut.bottom <= y + page + 8) {
        end = Math.min(h, Math.max(end, Math.round(cut.bottom)));
      }
    }
    if (end <= y) {
      const nextBox = unsplittable.find((b) => b.top > y + 1);
      end = nextBox ? Math.min(limit, Math.max(y + 1, Math.round(nextBox.top))) : limit;
    }
    if (end <= y) end = limit;
    const sliceHeight = Math.max(1, end - y);
    out.push({ offset: y, sliceHeight });
    y += sliceHeight;
    if (out.length > 20_000) break;
  }
  return out.length ? out : [{ offset: 0, sliceHeight: page }];
}

async function measureChapter(
  host: HTMLElement,
  ch: EpubChapter,
  fontPx: number,
): Promise<{ height: number; bottoms: number[]; media: BoxY[] }> {
  const inner = chapterInnerEl(ch);
  inner.style.fontSize = `${fontPx}px`;
  inner.style.setProperty("--epub-font-px", `${fontPx}px`);
  inner.style.transform = "";
  host.replaceChildren(inner);
  await waitForMedia(inner);
  void host.offsetHeight;
  const height = Math.max(1, host.scrollHeight);
  const flow = collectFlowBoxes(inner, height);
  return {
    height,
    bottoms: flow.bottoms,
    media: [...mediaBoxes(inner, height), ...flow.lines],
  };
}

function mediaBoxes(inner: HTMLElement, height: number): BoxY[] {
  const origin = inner.getBoundingClientRect().top;
  const boxes: BoxY[] = [];
  for (const el of inner.querySelectorAll<HTMLElement>("img, svg, video, canvas, figure")) {
    const r = el.getBoundingClientRect();
    const top = r.top - origin;
    const bottom = r.bottom - origin;
    if (bottom - top < 8) continue;
    if (bottom <= 0 || top >= height) continue;
    boxes.push({
      top: Math.max(0, top),
      bottom: Math.min(height, bottom),
    });
  }
  boxes.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  return boxes;
}

function waitForMedia(root: HTMLElement): Promise<void> {
  const imgs = [...root.querySelectorAll("img")];
  if (!imgs.length) return Promise.resolve();
  const ready = Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalHeight > 0) return Promise.resolve();
      return img
        .decode()
        .catch(
          () =>
            new Promise<void>((resolve) => {
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
            }),
        );
    }),
  ).then(() => undefined);
  return Promise.race([
    ready,
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 4000);
    }),
  ]);
}

export async function paginateEpub(
  book: EpubBook,
  pageWidth: number,
  pageHeight: number,
  fontPx: number,
  opts?: { prioritySpine?: number },
): Promise<EpubPage[]> {
  const clamped = Math.max(14, Math.min(28, fontPx));
  const slice = Math.max(120, pageHeight);
  const mediaMax = Math.max(80, Math.round(pageHeight) - EPUB_INNER_PAD_Y);
  const host = getMeasureHost();
  host.style.width = `${Math.max(160, pageWidth)}px`;
  host.style.fontSize = `${clamped}px`;
  host.style.setProperty("--epub-font-px", `${clamped}px`);
  host.style.setProperty("--epub-media-max-h", `${mediaMax}px`);
  const n = book.chapters.length;
  const heights = new Array<number>(n);
  const breaks = new Array<number[]>(n);
  const media = new Array<BoxY[]>(n);
  const seen = new Set<number>();
  const order: number[] = [];
  const push = (i: number) => {
    if (i < 0 || i >= n || seen.has(i)) return;
    seen.add(i);
    order.push(i);
  };
  const prefer = opts?.prioritySpine;
  if (prefer != null) {
    push(prefer);
    push(prefer - 1);
    push(prefer + 1);
  }
  for (let i = 0; i < n; i++) push(i);
  try {
    for (const i of order) {
      const measured = await measureChapter(host, book.chapters[i], clamped);
      heights[i] = measured.height;
      breaks[i] = measured.bottoms;
      media[i] = measured.media;
    }
  } finally {
    host.replaceChildren();
  }
  const pages: EpubPage[] = [];
  for (let i = 0; i < n; i++) {
    const ch = book.chapters[i];
    const height = heights[i] || 1;
    const slices = slicesForChapter(
      height,
      slice,
      breaks[i] || [height],
      media[i] || [],
    );
    for (const piece of slices) {
      pages.push({
        spine: i,
        offset: piece.offset,
        html: ch.html,
        text: ch.text,
        chapterHeight: height,
        sliceHeight: piece.sliceHeight,
      });
    }
  }
  return pages.length
    ? pages
    : [{ spine: 0, offset: 0, html: "", text: "", chapterHeight: 1, sliceHeight: slice }];
}

export function clearEpubLayoutCache() {
  chapterInnerCache = new WeakMap();
  if (measureHost) {
    measureHost.replaceChildren();
    measureHost.remove();
    measureHost = null;
  }
}

export function revokeBlobs(urls: string[]) {
  for (const url of urls) URL.revokeObjectURL(url);
}
