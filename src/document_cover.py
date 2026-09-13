"""Gallery / filmstrip covers for PDF and EPUB. Worker-thread safe (QImage, not QPixmap)."""

from __future__ import annotations

import os
from typing import Optional, Tuple

import numpy as np

from document_types import KIND_EPUB, KIND_PDF, document_kind

_PLACEHOLDER_BG = (29, 26, 22)
_PLACEHOLDER_INK = (237, 231, 221)
_PLACEHOLDER_MUTED = (150, 137, 122)
_PLACEHOLDER_LINE = (58, 51, 42)


def _placeholder_rgb(title: str, kind: str, max_edge: int) -> np.ndarray:
    edge = max(64, int(max_edge))
    arr = np.empty((edge, edge, 3), dtype=np.uint8)
    arr[:, :] = _PLACEHOLDER_BG
    # Simple frame so a missing cover still reads as a document tile.
    arr[:2, :] = _PLACEHOLDER_LINE
    arr[-2:, :] = _PLACEHOLDER_LINE
    arr[:, :2] = _PLACEHOLDER_LINE
    arr[:, -2:] = _PLACEHOLDER_LINE
    try:
        from PIL import Image, ImageDraw, ImageFont

        im = Image.fromarray(arr, "RGB")
        draw = ImageDraw.Draw(im)
        label = "PDF" if kind == KIND_PDF else "EPUB"
        font = ImageFont.load_default()
        draw.text((10, 10), label, fill=_PLACEHOLDER_MUTED, font=font)
        text = (title or "").strip() or "Document"
        if len(text) > 42:
            text = text[:39] + "…"
        # Word-wrap against the tile.
        words = text.split()
        lines: list[str] = []
        current = ""
        for word in words:
            trial = (current + " " + word).strip()
            if len(trial) > 16 and current:
                lines.append(current)
                current = word
            else:
                current = trial
        if current:
            lines.append(current)
        y = edge // 2 - 8 * min(4, len(lines))
        for line in lines[:4]:
            draw.text((10, y), line, fill=_PLACEHOLDER_INK, font=font)
            y += 14
        return np.ascontiguousarray(im)
    except Exception:
        return arr


def render_document_cover_rgb(path: str, max_edge: int = 512) -> Optional[np.ndarray]:
    kind = document_kind(path)
    if kind is None:
        return None
    title = os.path.splitext(os.path.basename(path or ""))[0]
    arr = None
    if kind == KIND_PDF:
        try:
            from pdf_backend import render_pdf_cover_rgb

            arr = render_pdf_cover_rgb(path, max_edge=max_edge)
        except Exception:
            arr = None
    elif kind == KIND_EPUB:
        try:
            from epub_backend import epub_cover_rgb

            arr = epub_cover_rgb(path, max_edge=max_edge)
        except Exception:
            arr = None
    if arr is None:
        return _placeholder_rgb(title, kind, max_edge)
    return arr


def document_exif_stub(path: str) -> dict:
    """Minimal EXIF-shaped dict so the status HUD has a filename."""
    kind = document_kind(path) or "document"
    name = os.path.basename(path or "")
    title = os.path.splitext(name)[0]
    return {
        "FileName": name,
        "Title": title,
        "Format": kind.upper(),
        "ImageWidth": 0,
        "ImageHeight": 0,
    }


def cover_size_for_target(target: Optional[Tuple[int, int]], default: int = 512) -> int:
    if not target:
        return default
    w, h = int(target[0] or 0), int(target[1] or 0)
    return max(64, max(w, h, default))
