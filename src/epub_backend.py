"""EPUB 2/3 parse via the zip + XML stdlib. No extra package.

An EPUB is a zip of XHTML spine items plus a TOC (NCX or EPUB3 nav). Pages
are not native — the reader paginates chapter HTML against the viewport.
"""

from __future__ import annotations

import io
import os
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from xml.etree import ElementTree as ET

_CONTAINER_NS = "{urn:oasis:names:tc:opendocument:xmlns:container}"
_OPF_NS = "{http://www.idpf.org/2007/opf}"
_DC_NS = "{http://purl.org/dc/elements/1.1/}"
_NCX_NS = "{http://www.daisy.org/z3986/2005/ncx/}"
_XHTML_NS = "{http://www.w3.org/1999/xhtml}"
_OPS_NS = "{http://www.idpf.org/2007/ops}"

_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script>", re.IGNORECASE | re.DOTALL)
_STYLE_BLOCK_RE = re.compile(r"<style\b[^>]*>.*?</style>", re.IGNORECASE | re.DOTALL)


@dataclass(frozen=True)
class EpubTocEntry:
    title: str
    href: str
    spine_index: int  # -1 if the href is not on the spine
    fragment: str = ""
    level: int = 0


@dataclass
class EpubChapter:
    idref: str
    href: str
    title: str
    html: str
    media_type: str = "application/xhtml+xml"


@dataclass
class EpubDocument:
    path: str
    title: str
    creator: str = ""
    language: str = ""
    spine: List[EpubChapter] = field(default_factory=list)
    toc: List[EpubTocEntry] = field(default_factory=list)
    images: Dict[str, bytes] = field(default_factory=dict)
    cover_bytes: Optional[bytes] = None
    cover_media_type: str = ""

    @property
    def chapter_count(self) -> int:
        return len(self.spine)


def _local(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _text(el: Optional[ET.Element]) -> str:
    if el is None:
        return ""
    parts = [el.text or ""]
    for child in el:
        parts.append(_text(child))
        parts.append(child.tail or "")
    return "".join(parts).strip()


def _attr(el: ET.Element, *names: str) -> str:
    for name in names:
        value = el.get(name)
        if value:
            return value
        # namespaced attributes (opf:property etc.)
        for key, val in el.attrib.items():
            if _local(key) == name and val:
                return val
    return ""


def _join_href(base: str, href: str) -> str:
    href = (href or "").split("#", 1)[0].strip()
    if not href:
        return posixpath.normpath(base.replace("\\", "/"))
    folder = posixpath.dirname(base.replace("\\", "/"))
    return posixpath.normpath(posixpath.join(folder, href) if folder else href)


def _decode_xml(data: bytes) -> ET.Element:
    # EPUB XML is often utf-8; strip a BOM and let ElementTree guess the rest.
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return ET.fromstring(data)


def _read_zip(zf: zipfile.ZipFile, name: str) -> bytes:
    name = name.replace("\\", "/").lstrip("/")
    try:
        return zf.read(name)
    except KeyError:
        # Some zips store backslashes or a leading folder.
        lower = name.lower()
        for info in zf.infolist():
            if info.filename.replace("\\", "/").lstrip("/").lower() == lower:
                return zf.read(info.filename)
        raise


def _find_rootfile(zf: zipfile.ZipFile) -> str:
    data = _read_zip(zf, "META-INF/container.xml")
    root = _decode_xml(data)
    for el in root.iter():
        if _local(el.tag) == "rootfile":
            full = _attr(el, "full-path", f"{_CONTAINER_NS}full-path")
            if full:
                return full.replace("\\", "/")
    raise ValueError("EPUB container.xml has no rootfile")


def _manifest(opf_root: ET.Element) -> Dict[str, dict]:
    items: Dict[str, dict] = {}
    for el in opf_root.iter():
        if _local(el.tag) != "item":
            continue
        item_id = _attr(el, "id")
        href = _attr(el, "href")
        if not item_id or not href:
            continue
        items[item_id] = {
            "href": href,
            "media_type": _attr(el, "media-type", "media_type"),
            "properties": _attr(el, "properties"),
        }
    return items


def _spine_ids(opf_root: ET.Element) -> List[str]:
    ids: List[str] = []
    for el in opf_root.iter():
        if _local(el.tag) != "itemref":
            continue
        idref = _attr(el, "idref")
        linear = (_attr(el, "linear") or "yes").lower()
        if linear == "no":
            continue
        if idref:
            ids.append(idref)
    return ids


def _dc(opf_root: ET.Element, name: str) -> str:
    for el in opf_root.iter():
        if _local(el.tag) == name:
            text = _text(el)
            if text:
                return text
    return ""


def _clean_html(raw: str) -> str:
    html = _SCRIPT_RE.sub("", raw)
    html = _STYLE_BLOCK_RE.sub("", html)
    # Drop XML declaration / doctype — QTextDocument prefers a fragment or html.
    html = re.sub(r"<\?xml[^>]*\?>", "", html, flags=re.IGNORECASE)
    html = re.sub(r"<!DOCTYPE[^>]*>", "", html, flags=re.IGNORECASE)
    return html.strip()


def _body_inner(html: str) -> str:
    match = re.search(r"<body\b[^>]*>(.*)</body>", html, re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return html


def _heading_title(html: str, fallback: str) -> str:
    match = re.search(
        r"<h[1-3]\b[^>]*>(.*?)</h[1-3]>", html, re.IGNORECASE | re.DOTALL
    )
    if not match:
        return fallback
    text = re.sub(r"<[^>]+>", "", match.group(1))
    text = re.sub(r"\s+", " ", text).strip()
    return text or fallback


def _rewrite_img_src(html: str, chapter_href: str) -> str:
    def repl(match: re.Match) -> str:
        quote = match.group(1)
        src = match.group(2)
        if src.lower().startswith(("http:", "https:", "data:")):
            return match.group(0)
        resolved = _join_href(chapter_href, src)
        return f"src={quote}epub-res:{resolved}{quote}"

    return re.sub(
        r"""src=(['"])([^'"]+)\1""",
        repl,
        html,
        flags=re.IGNORECASE,
    )


def _parse_ncx(data: bytes, opf_dir: str, href_to_spine: Dict[str, int]) -> List[EpubTocEntry]:
    root = _decode_xml(data)
    entries: List[EpubTocEntry] = []

    def walk(el: ET.Element, level: int) -> None:
        for child in el:
            if _local(child.tag) != "navPoint":
                continue
            label = ""
            href = ""
            for sub in child:
                loc = _local(sub.tag)
                if loc == "navLabel":
                    label = _text(sub)
                elif loc == "content":
                    href = _attr(sub, "src")
            path, frag = (href.split("#", 1) + [""])[:2]
            resolved = _join_href(posixpath.join(opf_dir, "dummy"), path)
            spine_index = href_to_spine.get(resolved, href_to_spine.get(path, -1))
            if spine_index < 0:
                # Try basename match.
                base = posixpath.basename(resolved)
                for key, idx in href_to_spine.items():
                    if posixpath.basename(key) == base:
                        spine_index = idx
                        resolved = key
                        break
            if label:
                entries.append(
                    EpubTocEntry(
                        title=label,
                        href=resolved,
                        spine_index=spine_index,
                        fragment=frag,
                        level=level,
                    )
                )
            walk(child, level + 1)

    nav_map = None
    for el in root.iter():
        if _local(el.tag) == "navMap":
            nav_map = el
            break
    if nav_map is not None:
        walk(nav_map, 0)
    return entries


def _parse_nav_xhtml(
    data: bytes, nav_href: str, href_to_spine: Dict[str, int]
) -> List[EpubTocEntry]:
    root = _decode_xml(data)
    nav_el = None
    for el in root.iter():
        if _local(el.tag) != "nav":
            continue
        epub_type = _attr(el, "type", f"{_OPS_NS}type")
        if "toc" in (epub_type or "").lower() or nav_el is None:
            nav_el = el
            if "toc" in (epub_type or "").lower():
                break
    if nav_el is None:
        return []
    entries: List[EpubTocEntry] = []

    def walk(ol: ET.Element, level: int) -> None:
        for li in ol:
            if _local(li.tag) != "li":
                continue
            title = ""
            href = ""
            child_ol = None
            for sub in li:
                loc = _local(sub.tag)
                if loc == "a" and not href:
                    href = _attr(sub, "href")
                    title = _text(sub)
                elif loc == "span" and not title:
                    title = _text(sub)
                elif loc == "ol":
                    child_ol = sub
            path, frag = (href.split("#", 1) + [""])[:2]
            resolved = _join_href(nav_href, path)
            spine_index = href_to_spine.get(resolved, -1)
            if spine_index < 0:
                base = posixpath.basename(resolved)
                for key, idx in href_to_spine.items():
                    if posixpath.basename(key) == base:
                        spine_index = idx
                        resolved = key
                        break
            if title:
                entries.append(
                    EpubTocEntry(
                        title=title,
                        href=resolved,
                        spine_index=spine_index,
                        fragment=frag,
                        level=level,
                    )
                )
            if child_ol is not None:
                walk(child_ol, level + 1)

    for el in nav_el.iter():
        if _local(el.tag) == "ol":
            walk(el, 0)
            break
    return entries


def _image_media(media_type: str) -> bool:
    return (media_type or "").lower().startswith("image/")


def open_epub(path: str) -> EpubDocument:
    if not path or not os.path.isfile(path):
        raise FileNotFoundError(path)
    with zipfile.ZipFile(path, "r") as zf:
        opf_path = _find_rootfile(zf)
        opf_dir = posixpath.dirname(opf_path)
        opf_root = _decode_xml(_read_zip(zf, opf_path))
        manifest = _manifest(opf_root)
        title = _dc(opf_root, "title") or os.path.splitext(os.path.basename(path))[0]
        creator = _dc(opf_root, "creator")
        language = _dc(opf_root, "language")

        images: Dict[str, bytes] = {}
        cover_bytes: Optional[bytes] = None
        cover_media = ""
        nav_href = ""
        ncx_href = ""

        for item_id, item in manifest.items():
            href_rel = item["href"]
            abs_href = _join_href(posixpath.join(opf_dir, "dummy"), href_rel)
            media = item["media_type"]
            props = (item["properties"] or "").lower().split()
            if "nav" in props:
                nav_href = abs_href
            if media == "application/x-dtbncx+xml":
                ncx_href = abs_href
            if _image_media(media):
                try:
                    blob = _read_zip(zf, abs_href)
                except KeyError:
                    continue
                images[abs_href] = blob
                images[posixpath.basename(abs_href)] = blob
                if "cover-image" in props and cover_bytes is None:
                    cover_bytes = blob
                    cover_media = media

        # OPF <meta name="cover" content="id"/>
        if cover_bytes is None:
            for el in opf_root.iter():
                if _local(el.tag) != "meta":
                    continue
                if (_attr(el, "name") or "").lower() != "cover":
                    continue
                cover_id = _attr(el, "content")
                item = manifest.get(cover_id)
                if not item:
                    continue
                abs_href = _join_href(posixpath.join(opf_dir, "dummy"), item["href"])
                cover_bytes = images.get(abs_href)
                cover_media = item.get("media_type") or ""
                break

        spine: List[EpubChapter] = []
        href_to_spine: Dict[str, int] = {}
        for idref in _spine_ids(opf_root):
            item = manifest.get(idref)
            if not item:
                continue
            abs_href = _join_href(posixpath.join(opf_dir, "dummy"), item["href"])
            media = item["media_type"]
            if media and not media.endswith(("xml", "html", "xhtml+xml")):
                if "html" not in media and "xml" not in media:
                    continue
            try:
                raw = _read_zip(zf, abs_href).decode("utf-8", errors="replace")
            except KeyError:
                continue
            cleaned = _clean_html(raw)
            inner = _rewrite_img_src(_body_inner(cleaned), abs_href)
            fallback = posixpath.splitext(posixpath.basename(abs_href))[0]
            chapter = EpubChapter(
                idref=idref,
                href=abs_href,
                title=_heading_title(inner, fallback),
                html=inner,
                media_type=media,
            )
            href_to_spine[abs_href] = len(spine)
            href_to_spine[item["href"]] = len(spine)
            href_to_spine[posixpath.basename(abs_href)] = len(spine)
            spine.append(chapter)

        toc: List[EpubTocEntry] = []
        if nav_href:
            try:
                toc = _parse_nav_xhtml(_read_zip(zf, nav_href), nav_href, href_to_spine)
            except Exception:
                toc = []
        if not toc and ncx_href:
            try:
                toc = _parse_ncx(_read_zip(zf, ncx_href), opf_dir, href_to_spine)
            except Exception:
                toc = []
        if not toc:
            toc = [
                EpubTocEntry(
                    title=ch.title, href=ch.href, spine_index=i, level=0
                )
                for i, ch in enumerate(spine)
            ]

        return EpubDocument(
            path=path,
            title=title,
            creator=creator,
            language=language,
            spine=spine,
            toc=toc,
            images=images,
            cover_bytes=cover_bytes,
            cover_media_type=cover_media,
        )


def epub_cover_rgb(path: str, max_edge: int = 512) -> Optional["object"]:
    """RGB uint8 array from the EPUB cover image, or None."""
    try:
        doc = open_epub(path)
    except Exception:
        return None
    blob = doc.cover_bytes
    if not blob:
        return None
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(blob))
        im = im.convert("RGB")
        im.thumbnail((max_edge, max_edge))
        import numpy as np

        return np.ascontiguousarray(im)
    except Exception:
        return None
