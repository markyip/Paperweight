"""Lightweight PDF / EPUB reader overlay. View only — no edit, no annotation."""

from __future__ import annotations

import logging
import os
import posixpath
from typing import Dict, List, Optional, Sequence, Tuple

from PyQt6.QtCore import (
    QPoint,
    QRect,
    QSize,
    Qt,
    QTimer,
    pyqtSignal,
)
from PyQt6.QtGui import (
    QColor,
    QCursor,
    QFont,
    QImage,
    QKeyEvent,
    QMouseEvent,
    QPainter,
    QPixmap,
    QShowEvent,
    QWheelEvent,
)
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTreeWidget,
    QTreeWidgetItem,
    QWidget,
)

import theme
from document_layout import (
    MAX_COLUMNS,
    MIN_COLUMNS,
    clamp_zoom,
    display_scale,
    fit_scale,
    next_spread_index,
    page_label,
    prev_spread_index,
    recommended_columns,
    resolve_columns,
    spread_pages,
    zoom_in,
    zoom_out,
)
from document_types import KIND_EPUB, KIND_PDF, document_kind, is_document_file

logger = logging.getLogger(__name__)

_HUD_HIDE_MS = 2200
_PAGE_CACHE_MAX = 28
_VOID = QColor(*theme.VOID_RGB)
_INK = QColor(*theme.INK_RGB)


def _qimage_from_bgra(arr) -> Optional[QImage]:
    if arr is None:
        return None
    try:
        h, w = arr.shape[:2]
        ch = arr.shape[2] if arr.ndim == 3 else 1
        if ch >= 4:
            fmt = QImage.Format.Format_ARGB32
            bpl = int(arr.strides[0])
            img = QImage(arr.data, w, h, bpl, fmt).copy()
            return img
        if ch == 3:
            img = QImage(arr.data, w, h, int(arr.strides[0]), QImage.Format.Format_RGB888).copy()
            return img
    except Exception:
        logger.debug("document qimage convert failed", exc_info=True)
    return None


class _EpubTextDocument:
    """Paginate one EPUB chapter with QTextDocument (HTML subset)."""

    def __init__(self, html: str, images: Dict[str, bytes], font_pt: float = 17.0):
        from PyQt6.QtGui import QTextDocument

        class _Doc(QTextDocument):
            def __init__(self_inner, image_map: Dict[str, bytes]):
                super().__init__()
                self_inner._image_map = image_map

            def loadResource(self_inner, resource_type, url):  # noqa: N802
                from PyQt6.QtGui import QTextDocument as _QTD

                if resource_type == int(_QTD.ResourceType.ImageResource):
                    key = url.toString() if hasattr(url, "toString") else str(url)
                    if key.startswith("epub-res:"):
                        key = key[len("epub-res:") :]
                    blob = self_inner._image_map.get(key)
                    if blob is None:
                        blob = self_inner._image_map.get(posixpath.basename(key))
                    if blob:
                        img = QImage.fromData(blob)
                        if not img.isNull():
                            return img
                return super().loadResource(resource_type, url)

        wrapped = (
            "<html><head><meta charset='utf-8'></head>"
            f"<body style='color:{theme.INK}; background:{theme.VOID};"
            f" font-size:{font_pt:.0f}pt; line-height:1.45;'>"
            f"{html}</body></html>"
        )
        self.doc = _Doc(images)
        self.doc.setDefaultStyleSheet(
            f"body {{ color: {theme.INK}; background-color: {theme.VOID}; }}"
            f" a {{ color: {theme.DODGE}; }}"
            " img { max-width: 100%; }"
        )
        self.doc.setHtml(wrapped)
        self._page_w = 0.0
        self._page_h = 0.0
        self.page_count = 1

    def relayout(self, page_w: float, page_h: float) -> int:
        from PyQt6.QtCore import QSizeF

        page_w = max(120.0, float(page_w))
        page_h = max(160.0, float(page_h))
        self._page_w = page_w
        self._page_h = page_h
        self.doc.setPageSize(QSizeF(page_w, page_h))
        self.page_count = max(1, int(self.doc.pageCount()))
        return self.page_count

    def render_page(self, page_index: int, dpr: float = 1.0) -> Optional[QImage]:
        if page_index < 0 or page_index >= self.page_count:
            return None
        from PyQt6.QtCore import QRectF

        w = max(1, int(self._page_w * dpr))
        h = max(1, int(self._page_h * dpr))
        img = QImage(w, h, QImage.Format.Format_ARGB32_Premultiplied)
        img.setDevicePixelRatio(dpr)
        img.fill(_VOID)
        painter = QPainter(img)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        painter.scale(dpr, dpr)
        painter.translate(0.0, -page_index * self._page_h)
        clip = QRectF(0.0, page_index * self._page_h, self._page_w, self._page_h)
        self.doc.drawContents(painter, clip)
        painter.end()
        return img


class DocumentCanvas(QWidget):
    """Paints one spread and pans when zoomed past fit."""

    doubleClicked = pyqtSignal()
    zoomDelta = pyqtSignal(int)  # +1 / -1 steps
    turnSpread = pyqtSignal(int)  # -1 / +1
    activity = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._pixmaps: List[QPixmap] = []
        self._pan = QPoint(0, 0)
        self._drag_origin: Optional[QPoint] = None
        self._pan_origin = QPoint(0, 0)
        self._gutter = 14
        self._can_pan = False

    def set_spread(self, pixmaps: Sequence[QPixmap], *, can_pan: bool) -> None:
        self._pixmaps = [pm for pm in pixmaps if pm is not None and not pm.isNull()]
        self._can_pan = bool(can_pan)
        if not can_pan:
            self._pan = QPoint(0, 0)
        self.update()

    def reset_pan(self) -> None:
        self._pan = QPoint(0, 0)
        self.update()

    def _spread_size(self) -> QSize:
        if not self._pixmaps:
            return QSize(0, 0)
        widths = [pm.width() / max(pm.devicePixelRatio(), 1.0) for pm in self._pixmaps]
        heights = [pm.height() / max(pm.devicePixelRatio(), 1.0) for pm in self._pixmaps]
        w = int(sum(widths) + self._gutter * (len(self._pixmaps) - 1))
        h = int(max(heights) if heights else 0)
        return QSize(w, h)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), _VOID)
        if not self._pixmaps:
            p.setPen(_INK)
            font = QFont()
            font.setPointSize(13)
            p.setFont(font)
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "Open a PDF or EPUB")
            p.end()
            return
        size = self._spread_size()
        x0 = (self.width() - size.width()) // 2 + self._pan.x()
        y0 = (self.height() - size.height()) // 2 + self._pan.y()
        x = x0
        for pm in self._pixmaps:
            dpr = max(pm.devicePixelRatio(), 1.0)
            w = int(pm.width() / dpr)
            h = int(pm.height() / dpr)
            y = y0 + (size.height() - h) // 2
            p.drawPixmap(QRect(x, y, w, h), pm)
            x += w + self._gutter
        p.end()

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self.activity.emit()
        if event.button() == Qt.MouseButton.LeftButton and self._can_pan:
            self._drag_origin = event.position().toPoint()
            self._pan_origin = QPoint(self._pan)
            self.setCursor(QCursor(Qt.CursorShape.ClosedHandCursor))
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self.activity.emit()
        if self._drag_origin is not None:
            delta = event.position().toPoint() - self._drag_origin
            self._pan = self._pan_origin + delta
            self.update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_origin = None
            self.setCursor(QCursor(Qt.CursorShape.ArrowCursor))
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self.activity.emit()
        self.doubleClicked.emit()
        event.accept()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        self.activity.emit()
        mods = event.modifiers()
        dy = event.angleDelta().y()
        if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier):
            self.zoomDelta.emit(1 if dy > 0 else -1)
            event.accept()
            return
        if abs(dy) >= 15:
            self.turnSpread.emit(-1 if dy > 0 else 1)
            event.accept()
            return
        super().wheelEvent(event)


class _HudButton(QPushButton):
    def __init__(self, text: str, parent=None, *, checkable: bool = False):
        super().__init__(text, parent)
        self.setCheckable(checkable)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setStyleSheet(
            f"""
            QPushButton {{
                color: {theme.INK_MUTED};
                background: transparent;
                border: 1px solid {theme.LINE};
                border-radius: 4px;
                padding: 3px 8px;
                font-size: 12px;
            }}
            QPushButton:hover {{
                color: {theme.INK};
                border-color: {theme.INK_FAINT};
            }}
            QPushButton:checked {{
                color: {theme.INK};
                background: {theme.EMBER_DIM};
                border-color: {theme.EMBER};
            }}
            """
        )


class DocumentView(QWidget):
    """Full-area reader. Parent it on the main window host."""

    requestGallery = pyqtSignal()
    requestPrevFile = pyqtSignal()
    requestNextFile = pyqtSignal()
    immersiveChanged = pyqtSignal(bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("document_view")
        self.setStyleSheet(f"#document_view {{ background-color: {theme.VOID}; }}")
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMouseTracking(True)

        self._path: Optional[str] = None
        self._kind: Optional[str] = None
        self._pdf = None
        self._epub = None
        self._epub_docs: List[_EpubTextDocument] = []
        self._epub_page_starts: List[int] = []
        self._page_count = 0
        self._page_index = 0
        self._columns_pref = 0  # 0 = auto
        self._zoom = 1.0
        self._signed = False
        self._title = ""
        self._toc_open = False
        self._immersive = False
        self._error = ""
        self._page_cache: Dict[Tuple[int, str], QPixmap] = {}
        self._dpr = 1.0
        self._last_turn_ts = 0.0
        self._last_turn_delta = 0

        self.canvas = DocumentCanvas(self)
        self.canvas.zoomDelta.connect(self._on_zoom_delta)
        self.canvas.turnSpread.connect(self._on_turn_spread)
        self.canvas.doubleClicked.connect(self._on_canvas_double_click)
        self.canvas.activity.connect(self._bump_hud)

        self.toc = QTreeWidget(self)
        self.toc.setHeaderHidden(True)
        self.toc.setRootIsDecorated(True)
        self.toc.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.toc.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.toc.itemClicked.connect(self._on_toc_clicked)
        self.toc.setStyleSheet(
            f"""
            QTreeWidget {{
                background: {theme.SURFACE};
                color: {theme.INK};
                border: none;
                border-right: 1px solid {theme.LINE};
                font-size: 13px;
                padding: 8px 4px;
            }}
            QTreeWidget::item {{
                padding: 4px 6px;
            }}
            QTreeWidget::item:selected {{
                background: {theme.EMBER_DIM};
                color: {theme.INK};
            }}
            """
        )
        self.toc.hide()

        self.hud = QFrame(self)
        self.hud.setObjectName("document_hud")
        self.hud.setStyleSheet(
            f"""
            QFrame#document_hud {{
                background-color: {theme.rgba(theme.SURFACE_RGB, 230)};
                border: 1px solid {theme.LINE};
                border-radius: 8px;
            }}
            QLabel {{ color: {theme.INK}; font-size: 12px; }}
            QLineEdit {{
                color: {theme.INK};
                background: {theme.RAISED};
                border: 1px solid {theme.LINE};
                border-radius: 4px;
                padding: 2px 6px;
                min-width: 44px;
                max-width: 64px;
            }}
            """
        )
        hud_layout = QHBoxLayout(self.hud)
        hud_layout.setContentsMargins(10, 6, 10, 6)
        hud_layout.setSpacing(6)

        self._toc_btn = _HudButton("Chapters", self.hud, checkable=True)
        self._toc_btn.clicked.connect(self._toggle_toc)
        hud_layout.addWidget(self._toc_btn)

        self._page_label = QLabel("", self.hud)
        hud_layout.addWidget(self._page_label)

        self._goto = QLineEdit(self.hud)
        self._goto.setPlaceholderText("page")
        self._goto.setMaxLength(6)
        self._goto.returnPressed.connect(self._goto_page)
        self._goto.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
        hud_layout.addWidget(self._goto)

        self._zoom_out_btn = _HudButton("−", self.hud)
        self._zoom_out_btn.clicked.connect(lambda: self._on_zoom_delta(-1))
        hud_layout.addWidget(self._zoom_out_btn)
        self._zoom_label = QLabel("100%", self.hud)
        hud_layout.addWidget(self._zoom_label)
        self._zoom_in_btn = _HudButton("+", self.hud)
        self._zoom_in_btn.clicked.connect(lambda: self._on_zoom_delta(1))
        hud_layout.addWidget(self._zoom_in_btn)

        hud_layout.addWidget(self._v_rule())
        self._col_buttons: List[_HudButton] = []
        auto_btn = _HudButton("Auto", self.hud, checkable=True)
        auto_btn.clicked.connect(lambda: self._set_columns_pref(0))
        self._auto_btn = auto_btn
        hud_layout.addWidget(auto_btn)
        for n in range(MIN_COLUMNS, MAX_COLUMNS + 1):
            btn = _HudButton(str(n), self.hud, checkable=True)
            btn.clicked.connect(lambda _c=False, k=n: self._set_columns_pref(k))
            self._col_buttons.append(btn)
            hud_layout.addWidget(btn)

        self._signed_badge = QLabel("", self.hud)
        self._signed_badge.setStyleSheet(f"color: {theme.DODGE}; font-size: 12px;")
        hud_layout.addWidget(self._signed_badge)

        hud_layout.addStretch(1)
        self._title_label = QLabel("", self.hud)
        self._title_label.setStyleSheet(f"color: {theme.INK_MUTED}; font-size: 12px;")
        hud_layout.addWidget(self._title_label)

        self._immersive_btn = _HudButton("Full screen", self.hud, checkable=True)
        self._immersive_btn.clicked.connect(self._toggle_immersive)
        hud_layout.addWidget(self._immersive_btn)

        self._error_label = QLabel("", self)
        self._error_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._error_label.setStyleSheet(f"color: {theme.INK}; font-size: 14px;")
        self._error_label.hide()

        self._hud_timer = QTimer(self)
        self._hud_timer.setSingleShot(True)
        self._hud_timer.timeout.connect(self._hide_hud_if_idle)
        self._bump_hud()

    def _v_rule(self) -> QFrame:
        line = QFrame(self.hud)
        line.setFixedWidth(1)
        line.setStyleSheet(f"background: {theme.LINE};")
        return line

    # --- public API --------------------------------------------------------

    def is_open(self) -> bool:
        return bool(self._path) and self.isVisible()

    def current_path(self) -> Optional[str]:
        return self._path

    def is_immersive(self) -> bool:
        return self._immersive

    def open_path(self, path: str) -> bool:
        self.close_document()
        if not is_document_file(path):
            return False
        self._path = path
        self._kind = document_kind(path)
        self._page_index = 0
        self._zoom = 1.0
        self._error = ""
        self._page_cache.clear()
        self.canvas.reset_pan()
        try:
            if self._kind == KIND_PDF:
                self._open_pdf(path)
            else:
                self._open_epub(path)
        except Exception as exc:
            logger.warning("Failed to open document %s: %s", path, exc, exc_info=True)
            self._error = str(exc)
            self._page_count = 0
            self._show_error()
            self.show()
            self.raise_()
            return False
        self._rebuild_toc()
        self._error_label.hide()
        self._layout_children()
        self._refresh_spread()
        self._update_hud()
        self.show()
        self.raise_()
        self._bump_hud()
        return True

    def close_document(self) -> None:
        if self._pdf is not None:
            try:
                self._pdf.close()
            except Exception:
                pass
        self._pdf = None
        self._epub = None
        self._epub_docs = []
        self._epub_page_starts = []
        self._page_cache.clear()
        self._path = None
        self._kind = None
        self._page_count = 0
        self._signed = False
        self.canvas.set_spread([], can_pan=False)
        if self._immersive:
            self._set_immersive(False)

    def handle_key(self, event: QKeyEvent) -> bool:
        if not self.is_open() and not self._error:
            return False
        key = event.key()
        mods = event.modifiers()
        ctrl = bool(mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier))
        toggle_keys = {
            Qt.Key.Key_T,
            Qt.Key.Key_F,
            Qt.Key.Key_F11,
            Qt.Key.Key_1,
            Qt.Key.Key_2,
            Qt.Key.Key_3,
            Qt.Key.Key_4,
            Qt.Key.Key_5,
            Qt.Key.Key_6,
        }
        if event.isAutoRepeat() and key in toggle_keys:
            return True
        if key in (Qt.Key.Key_Left, Qt.Key.Key_PageUp, Qt.Key.Key_Backspace):
            if ctrl:
                self.requestPrevFile.emit()
            else:
                self._on_turn_spread(-1)
            return True
        if key in (Qt.Key.Key_Right, Qt.Key.Key_PageDown, Qt.Key.Key_Space):
            if ctrl:
                self.requestNextFile.emit()
            else:
                self._on_turn_spread(1)
            return True
        if key == Qt.Key.Key_Home:
            self._goto_index(0)
            return True
        if key == Qt.Key.Key_End:
            self._goto_index(max(0, self._page_count - 1))
            return True
        if key in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self._on_zoom_delta(1)
            return True
        if key in (Qt.Key.Key_Minus, Qt.Key.Key_Underscore):
            self._on_zoom_delta(-1)
            return True
        if key == Qt.Key.Key_0 and ctrl:
            self._zoom = 1.0
            self.canvas.reset_pan()
            self._refresh_spread()
            return True
        if key == Qt.Key.Key_T:
            self._toggle_toc()
            return True
        if key in (Qt.Key.Key_F, Qt.Key.Key_F11):
            self._toggle_immersive()
            return True
        if key == Qt.Key.Key_G and ctrl:
            self._goto.setFocus()
            self._goto.selectAll()
            self._bump_hud()
            return True
        if Qt.Key.Key_1 <= key <= Qt.Key.Key_6 and not ctrl:
            self._set_columns_pref(key - Qt.Key.Key_0)
            return True
        if key == Qt.Key.Key_Escape:
            if self._goto.hasFocus():
                self._goto.clearFocus()
                self.setFocus()
                return True
            if self._toc_open:
                self._set_toc_open(False)
                return True
            if self._immersive:
                self._set_immersive(False)
                return True
            self.requestGallery.emit()
            return True
        return False

    # --- open helpers ------------------------------------------------------

    def _open_pdf(self, path: str) -> None:
        from pdf_backend import open_pdf, pdfium_available

        if not pdfium_available():
            raise RuntimeError(
                "PDF viewing needs pypdfium2. Install it, then reopen this file."
            )
        handle = open_pdf(path)
        self._pdf = handle
        self._page_count = handle.page_count
        self._signed = bool(handle.signed)
        self._title = handle.title or os.path.basename(path)

    def _open_epub(self, path: str) -> None:
        from epub_backend import open_epub

        doc = open_epub(path)
        self._epub = doc
        self._title = doc.title or os.path.basename(path)
        self._signed = False
        self._epub_docs = [
            _EpubTextDocument(ch.html, doc.images) for ch in doc.spine
        ]
        self._relayout_epub()

    def _relayout_epub(self) -> None:
        if not self._epub_docs:
            self._page_count = 0
            return
        cols = self._columns()
        box = self._page_box(cols)
        starts: List[int] = []
        total = 0
        for chapter in self._epub_docs:
            starts.append(total)
            total += chapter.relayout(box[0], box[1])
        self._epub_page_starts = starts
        self._page_count = max(1, total)

    def _page_box(self, cols: int) -> Tuple[float, float]:
        from document_layout import DEFAULT_PAGE_ASPECT

        toc_w = 280 if self._toc_open else 0
        avail_w = max(200.0, float(self.width() - toc_w - 48))
        avail_h = max(240.0, float(self.height() - 48))
        cols = max(1, int(cols))
        slot_w = avail_w / cols - 12.0
        page_h = avail_h
        page_w = page_h * DEFAULT_PAGE_ASPECT
        if page_w > slot_w:
            page_w = max(120.0, slot_w)
            page_h = page_w / DEFAULT_PAGE_ASPECT
        return float(page_w), float(page_h)

    def _columns(self) -> int:
        aspect = self._page_aspect()
        return resolve_columns(self._columns_pref, self.width(), self.height(), aspect)

    def _page_aspect(self) -> float:
        from document_layout import DEFAULT_PAGE_ASPECT

        if self._pdf is not None and self._pdf.page_sizes:
            w, h = self._pdf.page_sizes[0]
            if h > 0:
                return float(w) / float(h)
        return DEFAULT_PAGE_ASPECT

    # --- paint / cache -----------------------------------------------------

    def _refresh_spread(self) -> None:
        if self._error:
            self._show_error()
            return
        if self._kind == KIND_EPUB:
            self._relayout_epub()
        cols = self._columns()
        pages = spread_pages(self._page_index, cols, self._page_count)
        pixmaps: List[QPixmap] = []
        native_sizes: List[Tuple[float, float]] = []
        for idx in pages:
            native_sizes.append(self._native_size(idx))
        toc_w = 280 if self._toc_open else 0
        avail_w = max(80, self.width() - toc_w)
        fit = fit_scale(avail_w, self.height(), native_sizes, columns=len(native_sizes) or 1)
        scale = display_scale(fit, self._zoom)
        dpr = max(1.0, float(self.devicePixelRatioF()))
        self._dpr = dpr
        for idx in pages:
            pixmaps.append(self._page_pixmap(idx, scale, dpr))
        can_pan = self._zoom > 1.02
        self.canvas.set_spread(pixmaps, can_pan=can_pan)
        self._update_hud()

    def _native_size(self, page_index: int) -> Tuple[float, float]:
        if self._pdf is not None and 0 <= page_index < len(self._pdf.page_sizes):
            return self._pdf.page_sizes[page_index]
        box = self._page_box(self._columns())
        return box

    def _page_pixmap(self, page_index: int, scale: float, dpr: float) -> QPixmap:
        key = (page_index, f"{self._kind}:{scale:.3f}:{dpr:.2f}:{self.width()}x{self.height()}")
        hit = self._page_cache.get(key)
        if hit is not None:
            return hit
        img: Optional[QImage] = None
        if self._kind == KIND_PDF and self._pdf is not None:
            from pdf_backend import render_pdf_page_rgba

            arr = render_pdf_page_rgba(self._pdf, page_index, scale=scale * dpr)
            img = _qimage_from_bgra(arr)
            if img is not None:
                img.setDevicePixelRatio(dpr)
        elif self._kind == KIND_EPUB:
            spine, local = self._epub_split(page_index)
            if 0 <= spine < len(self._epub_docs):
                img = self._epub_docs[spine].render_page(local, dpr=dpr)
        if img is None or img.isNull():
            img = QImage(8, 8, QImage.Format.Format_ARGB32)
            img.fill(_VOID)
        pm = QPixmap.fromImage(img)
        self._page_cache[key] = pm
        if len(self._page_cache) > _PAGE_CACHE_MAX:
            # Drop oldest insertion order (Py3.7+ dict).
            for old in list(self._page_cache.keys())[: len(self._page_cache) - _PAGE_CACHE_MAX]:
                self._page_cache.pop(old, None)
        return pm

    def _epub_split(self, global_index: int) -> Tuple[int, int]:
        starts = self._epub_page_starts
        if not starts:
            return 0, 0
        spine = 0
        for i, start in enumerate(starts):
            if start <= global_index:
                spine = i
            else:
                break
        return spine, global_index - starts[spine]

    def _show_error(self) -> None:
        self.canvas.set_spread([], can_pan=False)
        self._error_label.setText(self._error or "Could not open this document.")
        self._error_label.show()
        self._error_label.raise_()

    # --- navigation --------------------------------------------------------

    def _on_turn_spread(self, delta: int) -> None:
        import time

        now = time.monotonic()
        if now - self._last_turn_ts < 0.06 and delta == self._last_turn_delta:
            return
        self._last_turn_ts = now
        self._last_turn_delta = int(delta)
        if self._page_count <= 0:
            return
        cols = self._columns()
        if delta < 0:
            self._page_index = prev_spread_index(self._page_index, cols)
        else:
            self._page_index = next_spread_index(self._page_index, cols, self._page_count)
        self.canvas.reset_pan()
        self._refresh_spread()
        self._bump_hud()

    def _goto_index(self, page_index: int) -> None:
        if self._page_count <= 0:
            return
        self._page_index = max(0, min(self._page_count - 1, int(page_index)))
        self.canvas.reset_pan()
        self._refresh_spread()
        self._bump_hud()

    def _goto_page(self) -> None:
        text = (self._goto.text() or "").strip()
        self._goto.clearFocus()
        try:
            n = int(text)
        except ValueError:
            return
        self._goto_index(n - 1)

    def _on_zoom_delta(self, steps: int) -> None:
        if steps >= 0:
            self._zoom = zoom_in(self._zoom, steps)
        else:
            self._zoom = zoom_out(self._zoom, -steps)
        if self._zoom <= 1.02:
            self.canvas.reset_pan()
        self._refresh_spread()
        self._bump_hud()

    def _on_canvas_double_click(self) -> None:
        self._zoom = 1.0 if self._zoom > 1.05 else 1.6
        if self._zoom <= 1.02:
            self.canvas.reset_pan()
        self._refresh_spread()
        self._bump_hud()

    def _set_columns_pref(self, n: int) -> None:
        self._columns_pref = 0 if n <= 0 else max(MIN_COLUMNS, min(MAX_COLUMNS, n))
        self.canvas.reset_pan()
        self._page_cache.clear()
        self._refresh_spread()
        self._bump_hud()

    def _toggle_toc(self) -> None:
        self._set_toc_open(not self._toc_open)

    def _set_toc_open(self, open_: bool) -> None:
        self._toc_open = bool(open_) and self.toc.topLevelItemCount() > 0
        self._toc_btn.setChecked(self._toc_open)
        self.toc.setVisible(self._toc_open)
        self._layout_children()
        self._page_cache.clear()
        self._refresh_spread()
        self._bump_hud()

    def _toggle_immersive(self) -> None:
        import time

        now = time.monotonic()
        if now - getattr(self, "_last_immersive_ts", 0.0) < 0.12:
            return
        self._last_immersive_ts = now
        self._set_immersive(not self._immersive)

    def _set_immersive(self, on: bool) -> None:
        self._immersive = bool(on)
        self._immersive_btn.setChecked(self._immersive)
        if self._immersive:
            self._set_toc_open(False)
        self.immersiveChanged.emit(self._immersive)
        self._bump_hud()

    def _on_toc_clicked(self, item: QTreeWidgetItem, _col: int) -> None:
        page = item.data(0, Qt.ItemDataRole.UserRole)
        try:
            idx = int(page)
        except (TypeError, ValueError):
            return
        if idx >= 0:
            self._goto_index(idx)

    def _rebuild_toc(self) -> None:
        self.toc.clear()
        items: List[Tuple[int, str, int]] = []
        if self._kind == KIND_PDF and self._pdf is not None:
            for entry in self._pdf.toc:
                items.append((entry.level, entry.title, entry.page_index))
        elif self._kind == KIND_EPUB and self._epub is not None:
            for entry in self._epub.toc:
                page = 0
                if 0 <= entry.spine_index < len(self._epub_page_starts):
                    page = self._epub_page_starts[entry.spine_index]
                items.append((entry.level, entry.title, page))
        if not items:
            self._toc_btn.setEnabled(False)
            self._set_toc_open(False)
            return
        self._toc_btn.setEnabled(True)
        stack: List[QTreeWidgetItem] = []
        for level, title, page in items:
            node = QTreeWidgetItem([title])
            node.setData(0, Qt.ItemDataRole.UserRole, int(page))
            while len(stack) > level:
                stack.pop()
            if not stack:
                self.toc.addTopLevelItem(node)
            else:
                stack[-1].addChild(node)
            stack.append(node)
        self.toc.expandToDepth(1)

    # --- HUD / layout ------------------------------------------------------

    def _update_hud(self) -> None:
        cols = self._columns()
        pages = spread_pages(self._page_index, cols, self._page_count)
        self._page_label.setText(page_label(pages, self._page_count))
        self._zoom_label.setText(f"{int(round(self._zoom * 100))}%")
        self._title_label.setText(self._title)
        self._signed_badge.setText("Signed" if self._signed else "")
        self._signed_badge.setVisible(self._signed)
        self._auto_btn.setChecked(self._columns_pref <= 0)
        for i, btn in enumerate(self._col_buttons, start=1):
            btn.setChecked(self._columns_pref == i)
        self._goto.setPlaceholderText("page")

    def _bump_hud(self) -> None:
        self.hud.show()
        self.hud.raise_()
        self._hud_timer.start(_HUD_HIDE_MS)

    def _hide_hud_if_idle(self) -> None:
        if self._goto.hasFocus():
            return
        # Keep a sliver of chrome unless immersive — still fade the bar.
        self.hud.hide()

    def _layout_children(self) -> None:
        w, h = self.width(), self.height()
        toc_w = 280 if self._toc_open else 0
        if self._toc_open:
            self.toc.setGeometry(0, 0, toc_w, h)
            self.toc.show()
            self.toc.raise_()
        self.canvas.setGeometry(toc_w, 0, max(1, w - toc_w), h)
        hud_h = 44
        hud_w = min(w - 24, 980)
        self.hud.setGeometry((w - hud_w) // 2, h - hud_h - 14, hud_w, hud_h)
        self._error_label.setGeometry(toc_w, h // 2 - 40, max(1, w - toc_w), 80)
        self.hud.raise_()

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._layout_children()
        self._page_cache.clear()
        if self._path:
            self._refresh_spread()

    def showEvent(self, event: QShowEvent) -> None:  # noqa: N802
        super().showEvent(event)
        self._layout_children()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._bump_hud()
        # Left-edge hover reveals TOC when the file has chapters.
        if (not self._toc_open) and event.position().x() < 18 and self.toc.topLevelItemCount():
            self._set_toc_open(True)
        super().mouseMoveEvent(event)
