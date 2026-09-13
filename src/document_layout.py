"""Ultrawide page-spread math for the PDF/EPUB reader. Qt-free.

A 32:9 monitor is ~3.56:1. Portrait pages (~0.707:1, A4) therefore fit about
five across if each page fills the height. 16:9 fits two; 21:9 fits three.
The user can override 1–6; 0 means auto.
"""

from __future__ import annotations

from typing import Iterable, Sequence, Tuple

# ISO 216 / US Letter portrait, width/height.
DEFAULT_PAGE_ASPECT = 210.0 / 297.0

MIN_COLUMNS = 1
MAX_COLUMNS = 6
MIN_ZOOM = 0.4
MAX_ZOOM = 4.0
ZOOM_STEP = 0.1
# Leave a little air between pages and at the edges so pages do not fuse.
GUTTER_FRACTION = 0.03
EDGE_MARGIN_PX = 16


def clamp_columns(n: int) -> int:
    try:
        value = int(n)
    except (TypeError, ValueError):
        value = MIN_COLUMNS
    return max(MIN_COLUMNS, min(MAX_COLUMNS, value))


def clamp_zoom(zoom: float) -> float:
    try:
        value = float(zoom)
    except (TypeError, ValueError):
        value = 1.0
    if value != value:  # NaN
        return 1.0
    return max(MIN_ZOOM, min(MAX_ZOOM, value))


def recommended_columns(
    viewport_w: float,
    viewport_h: float,
    page_aspect: float = DEFAULT_PAGE_ASPECT,
    *,
    min_columns: int = MIN_COLUMNS,
    max_columns: int = MAX_COLUMNS,
) -> int:
    """How many portrait pages fit side-by-side if they fill the height."""
    width = float(viewport_w or 0.0)
    height = float(viewport_h or 0.0)
    aspect = float(page_aspect or DEFAULT_PAGE_ASPECT)
    if width <= 1 or height <= 1 or aspect <= 0:
        return min_columns
    usable_aspect = (width / height) * (1.0 - GUTTER_FRACTION)
    raw = usable_aspect / aspect
    return clamp_columns(int(round(raw)))


def resolve_columns(
    requested: int,
    viewport_w: float,
    viewport_h: float,
    page_aspect: float = DEFAULT_PAGE_ASPECT,
) -> int:
    """0 = auto from the viewport; otherwise a clamped explicit count."""
    try:
        value = int(requested)
    except (TypeError, ValueError):
        value = 0
    if value <= 0:
        return recommended_columns(viewport_w, viewport_h, page_aspect)
    return clamp_columns(value)


def spread_start(page_index: int, columns: int) -> int:
    """First page of the spread that contains *page_index* (0-based)."""
    cols = clamp_columns(columns)
    if page_index < 0:
        page_index = 0
    return (int(page_index) // cols) * cols


def spread_pages(page_index: int, columns: int, page_count: int) -> Tuple[int, ...]:
    """0-based page indices in the current spread, clipped to *page_count*."""
    if page_count <= 0:
        return ()
    cols = clamp_columns(columns)
    start = spread_start(page_index, cols)
    end = min(page_count, start + cols)
    return tuple(range(start, end))


def next_spread_index(page_index: int, columns: int, page_count: int) -> int:
    cols = clamp_columns(columns)
    nxt = spread_start(page_index, cols) + cols
    if page_count <= 0:
        return 0
    return min(page_count - 1, nxt)


def prev_spread_index(page_index: int, columns: int) -> int:
    cols = clamp_columns(columns)
    start = spread_start(page_index, cols)
    return max(0, start - cols)


def fit_scale(
    viewport_w: float,
    viewport_h: float,
    page_sizes: Sequence[Tuple[float, float]],
    *,
    columns: int | None = None,
    gutter_px: float = 12.0,
    margin_px: float = EDGE_MARGIN_PX,
) -> float:
    """Scale that fits *page_sizes* (one spread) into the viewport.

    Each tuple is ``(width, height)`` in page-native pixels (72 dpi PDF units
    or the EPUB page box). Missing sizes fall back to a portrait A4 box.
    """
    pages = list(page_sizes) or [(DEFAULT_PAGE_ASPECT * 800.0, 800.0)]
    n = len(pages) if columns is None else max(1, min(len(pages), clamp_columns(columns)))
    pages = pages[:n]
    inner_w = max(1.0, float(viewport_w) - 2.0 * float(margin_px))
    inner_h = max(1.0, float(viewport_h) - 2.0 * float(margin_px))
    native_w = sum(max(1.0, float(w)) for w, _h in pages) + gutter_px * max(0, n - 1)
    native_h = max(max(1.0, float(h)) for _w, h in pages)
    scale_w = inner_w / native_w
    scale_h = inner_h / native_h
    return max(0.05, min(scale_w, scale_h))


def display_scale(fit: float, user_zoom: float) -> float:
    return max(0.05, float(fit) * clamp_zoom(user_zoom))


def zoom_in(zoom: float, steps: int = 1) -> float:
    return clamp_zoom(clamp_zoom(zoom) + ZOOM_STEP * steps)


def zoom_out(zoom: float, steps: int = 1) -> float:
    return clamp_zoom(clamp_zoom(zoom) - ZOOM_STEP * steps)


def page_label(pages: Iterable[int], page_count: int) -> str:
    """Human spread label, 1-based: ``3–5 of 120`` or ``12 of 12``."""
    idxs = [i for i in pages if 0 <= i < page_count]
    if not idxs or page_count <= 0:
        return "No pages"
    first = idxs[0] + 1
    last = idxs[-1] + 1
    if first == last:
        return f"{first} of {page_count}"
    return f"{first}–{last} of {page_count}"
