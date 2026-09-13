"""PDF open / page raster / outline / optional signature detection.

Rendering uses pypdfium2 (PDFium) when installed. Signature detection is a
byte scan for AcroForm signature dictionaries — enough to badge a file, not
to validate a PKCS#7 payload (that would be editing-adjacent crypto).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

_SIGNATURE_MARKERS = (
    b"/Type/Sig",
    b"/Type /Sig",
    b"/FT/Sig",
    b"/FT /Sig",
    b"/SubFilter/adbe.pkcs7",
    b"/SubFilter /adbe.pkcs7",
    b"/SubFilter/ETSI.CAdES",
)


@dataclass(frozen=True)
class TocEntry:
    title: str
    page_index: int  # 0-based; -1 if unknown
    level: int = 0


@dataclass
class PdfDocumentHandle:
    path: str
    page_count: int
    page_sizes: List[Tuple[float, float]]  # point sizes (1/72 in)
    toc: List[TocEntry] = field(default_factory=list)
    signed: bool = False
    title: str = ""
    _doc: Any = field(default=None, repr=False, compare=False)

    def close(self) -> None:
        doc = self._doc
        self._doc = None
        if doc is None:
            return
        closer = getattr(doc, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass


def pdfium_available() -> bool:
    try:
        import pypdfium2  # noqa: F401
    except Exception:
        return False
    return True


def pdf_has_signatures(path: str, *, max_bytes: int = 2_000_000) -> bool:
    """True when the file bytes look like they contain a PDF signature field.

    Reads the head and tail so linearized / incrementally-saved files still
    match. Does not verify the signature.
    """
    if not path or not os.path.isfile(path):
        return False
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(min(max_bytes, size))
            tail = b""
            if size > max_bytes:
                fh.seek(max(0, size - max_bytes))
                tail = fh.read(max_bytes)
    except OSError:
        return False
    blob = head + tail
    return any(marker in blob for marker in _SIGNATURE_MARKERS)


def _import_pdfium():
    try:
        import pypdfium2 as pdfium
    except Exception as exc:
        raise RuntimeError(
            "PDF viewing needs pypdfium2. Install it in the app environment "
            "(pixi add pypdfium2, or pip install pypdfium2)."
        ) from exc
    return pdfium


def _page_size_pts(page) -> Tuple[float, float]:
    getter = getattr(page, "get_size", None)
    if callable(getter):
        try:
            size = getter()
            return float(size[0]), float(size[1])
        except Exception:
            pass
    width = getattr(page, "width", None)
    height = getattr(page, "height", None)
    if width is not None and height is not None:
        return float(width), float(height)
    return 612.0, 792.0


def _toc_from_pdfium(pdf) -> List[TocEntry]:
    entries: List[TocEntry] = []
    getter = getattr(pdf, "get_toc", None)
    if not callable(getter):
        return entries
    try:
        items = getter()
    except Exception:
        return entries
    for item in items or ():
        try:
            if hasattr(item, "get_title"):
                title = str(item.get_title() or "").strip()
            else:
                title = str(getattr(item, "title", "") or "").strip()
            page_index = -1
            dest = None
            if hasattr(item, "get_dest"):
                try:
                    dest = item.get_dest()
                except Exception:
                    dest = None
            if dest is not None and hasattr(dest, "get_index"):
                try:
                    idx = dest.get_index()
                    if idx is not None:
                        page_index = int(idx)
                except Exception:
                    page_index = -1
            elif hasattr(item, "page_index"):
                page_index = int(item.page_index)
            level = 0
            if hasattr(item, "level"):
                level = int(item.level)
            if not title:
                continue
            entries.append(TocEntry(title=title, page_index=page_index, level=max(0, level)))
        except Exception:
            continue
    return entries


def _meta_title(pdf, fallback: str) -> str:
    getter = getattr(pdf, "get_metadata_dict", None)
    if callable(getter):
        try:
            meta = getter() or {}
            for key in ("Title", "title", "/Title"):
                value = meta.get(key)
                if value:
                    return str(value).strip() or fallback
        except Exception:
            pass
    getter = getattr(pdf, "get_metadata_value", None)
    if callable(getter):
        try:
            value = getter("Title")
            if value:
                return str(value).strip() or fallback
        except Exception:
            pass
    return fallback


def open_pdf(path: str) -> PdfDocumentHandle:
    if not path or not os.path.isfile(path):
        raise FileNotFoundError(path)
    pdfium = _import_pdfium()
    pdf = pdfium.PdfDocument(path)
    try:
        count = len(pdf)
    except TypeError:
        count = int(getattr(pdf, "page_count", 0) or 0)
    sizes: List[Tuple[float, float]] = []
    for i in range(count):
        page = None
        try:
            page = pdf[i]
            sizes.append(_page_size_pts(page))
        except Exception:
            sizes.append((612.0, 792.0))
        finally:
            closer = getattr(page, "close", None)
            if callable(closer):
                try:
                    closer()
                except Exception:
                    pass
    title = _meta_title(pdf, os.path.splitext(os.path.basename(path))[0])
    toc = _toc_from_pdfium(pdf)
    signed = pdf_has_signatures(path)
    return PdfDocumentHandle(
        path=path,
        page_count=count,
        page_sizes=sizes,
        toc=toc,
        signed=signed,
        title=title,
        _doc=pdf,
    )


def render_pdf_page_rgba(
    handle: PdfDocumentHandle,
    page_index: int,
    *,
    scale: float = 1.0,
    max_edge: int = 8192,
) -> Optional["object"]:
    """Return a contiguous uint8 HxWx4 BGRA/RGBA numpy array, or None."""
    import numpy as np

    pdf = handle._doc
    if pdf is None:
        return None
    if page_index < 0 or page_index >= handle.page_count:
        return None
    scale = max(0.15, min(8.0, float(scale)))
    page = None
    bitmap = None
    try:
        page = pdf[page_index]
        width_pts, height_pts = _page_size_pts(page)
        long_edge = max(width_pts, height_pts) * scale
        if long_edge > max_edge:
            scale = max(0.15, max_edge / max(width_pts, height_pts, 1.0))
        render = getattr(page, "render", None)
        if not callable(render):
            return None
        try:
            bitmap = render(scale=scale)
        except TypeError:
            bitmap = render(scale)
        to_numpy = getattr(bitmap, "to_numpy", None)
        if not callable(to_numpy):
            return None
        arr = to_numpy()
        if arr is None:
            return None
        return np.ascontiguousarray(arr)
    except Exception:
        logger.debug("PDF page render failed: %s p%s", handle.path, page_index, exc_info=True)
        return None
    finally:
        closer = getattr(bitmap, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass
        closer = getattr(page, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass


def render_pdf_cover_rgb(path: str, max_edge: int = 512) -> Optional["object"]:
    """First-page RGB uint8 array for gallery tiles. None if PDFium is missing."""
    if not pdfium_available():
        return None
    handle = None
    try:
        handle = open_pdf(path)
        if handle.page_count <= 0:
            return None
        w, h = handle.page_sizes[0] if handle.page_sizes else (612.0, 792.0)
        long_pts = max(w, h, 1.0)
        scale = max_edge / long_pts
        arr = render_pdf_page_rgba(handle, 0, scale=scale, max_edge=max_edge)
        if arr is None:
            return None
        import numpy as np

        if arr.ndim != 3:
            return None
        if arr.shape[2] >= 4:
            # PDFium is typically BGRA.
            rgb = np.empty((arr.shape[0], arr.shape[1], 3), dtype=np.uint8)
            rgb[:, :, 0] = arr[:, :, 2]
            rgb[:, :, 1] = arr[:, :, 1]
            rgb[:, :, 2] = arr[:, :, 0]
            return rgb
        return np.ascontiguousarray(arr[:, :, :3])
    except Exception:
        logger.debug("PDF cover render failed: %s", path, exc_info=True)
        return None
    finally:
        if handle is not None:
            handle.close()
