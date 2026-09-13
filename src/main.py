#!/usr/bin/env python3
"""Pageviewer — lightweight PDF / EPUB reader."""

from __future__ import annotations

import logging
import os
import sys

from PyQt6.QtCore import QSettings, Qt, QTimer
from PyQt6.QtGui import (
    QAction,
    QDragEnterEvent,
    QDropEvent,
    QGuiApplication,
    QKeyEvent,
)
from PyQt6.QtWidgets import (
    QApplication,
    QFileDialog,
    QLabel,
    QMainWindow,
    QStatusBar,
    QWidget,
)

import theme
from document_types import get_openable_extensions, is_document_file
from document_view import DocumentView

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pageviewer")

APP_NAME = "Pageviewer"
ORG_NAME = "Pageviewer"


def _apply_app_font(app: QApplication) -> None:
    font = app.font()
    font.setFamilies(list(theme.FONT_FAMILIES))
    if font.pointSizeF() > 0:
        font.setPointSizeF(font.pointSizeF() + theme.FONT_BASE_BUMP_PT)
    app.setFont(font)


def _sibling_documents(path: str) -> list[str]:
    folder = os.path.dirname(os.path.abspath(path))
    try:
        names = os.listdir(folder)
    except OSError:
        return [os.path.abspath(path)]
    files = []
    for name in names:
        full = os.path.join(folder, name)
        if os.path.isfile(full) and is_document_file(full):
            files.append(os.path.abspath(full))
    files.sort(key=lambda p: os.path.basename(p).lower())
    current = os.path.abspath(path)
    if current not in files:
        files.append(current)
        files.sort(key=lambda p: os.path.basename(p).lower())
    return files


class PageWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setAcceptDrops(True)
        self.resize(1400, 900)
        self._files: list[str] = []
        self._index = 0
        self._pre_immersive: dict | None = None

        host = QWidget(self)
        host.setObjectName("page_host")
        host.setStyleSheet(f"#page_host {{ background-color: {theme.VOID}; }}")
        self.setCentralWidget(host)

        self.empty = QLabel(
            "Drop a PDF or EPUB here\nCtrl+O to open",
            host,
        )
        self.empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty.setStyleSheet(
            f"color: {theme.INK_MUTED}; font-size: 18px; background: transparent;"
        )

        self.reader = DocumentView(host)
        self.reader.requestGallery.connect(self._close_current)
        self.reader.requestPrevFile.connect(lambda: self._step_file(-1))
        self.reader.requestNextFile.connect(lambda: self._step_file(1))
        self.reader.immersiveChanged.connect(self._on_immersive_changed)
        self.reader.hide()

        status = QStatusBar(self)
        status.setStyleSheet(
            f"color: {theme.INK_MUTED}; background: {theme.SURFACE}; "
            f"border-top: 1px solid {theme.LINE};"
        )
        self.setStatusBar(status)

        self._load_prefs()
        self._build_menu()
        QTimer.singleShot(0, self._layout_host)

    def settings(self) -> QSettings:
        return QSettings(ORG_NAME, APP_NAME)

    def _load_prefs(self) -> None:
        s = self.settings()
        try:
            self.reader._columns_pref = int(s.value("pages_across", 0))
        except (TypeError, ValueError):
            self.reader._columns_pref = 0
        try:
            self.reader._toc_open = bool(s.value("toc_open", False, type=bool))
        except Exception:
            self.reader._toc_open = False

    def _save_prefs(self) -> None:
        s = self.settings()
        s.setValue("pages_across", int(getattr(self.reader, "_columns_pref", 0)))
        s.setValue("toc_open", bool(getattr(self.reader, "_toc_open", False)))

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("&File")
        open_act = QAction("&Open…", self)
        open_act.setShortcut("Ctrl+O")
        open_act.triggered.connect(self._choose_file)
        file_menu.addAction(open_act)

        quit_act = QAction("&Quit", self)
        quit_act.setShortcut("Ctrl+Q")
        quit_act.triggered.connect(self.close)
        file_menu.addAction(quit_act)

        view_menu = self.menuBar().addMenu("&View")
        full_act = QAction("&Full screen", self)
        full_act.setShortcut("F11")
        full_act.triggered.connect(self.reader._toggle_immersive)
        view_menu.addAction(full_act)

        help_menu = self.menuBar().addMenu("&Help")
        keys_act = QAction("&Shortcuts", self)
        keys_act.triggered.connect(self._show_shortcuts)
        help_menu.addAction(keys_act)

    def _show_shortcuts(self) -> None:
        self.statusBar().showMessage(
            "←/→ spread  ·  1–6 pages across  ·  +/− zoom  ·  T chapters  ·  "
            "F / F11 full screen  ·  Ctrl+←/→ next file  ·  Esc back",
            8000,
        )

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._layout_host()

    def _layout_host(self) -> None:
        host = self.centralWidget()
        if host is None:
            return
        geo = host.rect()
        self.empty.setGeometry(geo)
        self.reader.setGeometry(geo)
        if self.reader.isVisible():
            self.reader.raise_()
        else:
            self.empty.raise_()

    def _choose_file(self) -> None:
        exts = " ".join(f"*{e}" for e in get_openable_extensions())
        path, _ = QFileDialog.getOpenFileName(
            self,
            "Open document",
            self.settings().value("last_dir", "") or "",
            f"Documents ({exts});;All Files (*)",
        )
        if path:
            self.open_path(path)

    def open_path(self, path: str) -> bool:
        path = os.path.abspath(path)
        if not is_document_file(path):
            self.statusBar().showMessage("Not a PDF or EPUB", 4000)
            return False
        self._files = _sibling_documents(path)
        try:
            self._index = self._files.index(path)
        except ValueError:
            self._files = [path]
            self._index = 0
        self.settings().setValue("last_dir", os.path.dirname(path))
        ok = self.reader.open_path(path)
        self.empty.hide()
        self.reader.show()
        self.reader.raise_()
        self.reader.setFocus()
        self._apply_title()
        return ok

    def _close_current(self) -> None:
        if self.reader.is_immersive():
            self.reader._set_immersive(False)
            return
        self.reader.close_document()
        self.reader.hide()
        self.empty.show()
        self.empty.raise_()
        self.setWindowTitle(APP_NAME)
        self.statusBar().clearMessage()
        self._save_prefs()

    def _step_file(self, delta: int) -> None:
        if not self._files:
            return
        self._index = (self._index + int(delta)) % len(self._files)
        self.open_path(self._files[self._index])

    def _apply_title(self) -> None:
        path = self.reader.current_path() or ""
        name = os.path.basename(path) or APP_NAME
        kind = "PDF" if name.lower().endswith(".pdf") else "EPUB"
        signed = " · signed" if getattr(self.reader, "_signed", False) else ""
        title = getattr(self.reader, "_title", "") or name
        pages = int(getattr(self.reader, "_page_count", 0) or 0)
        self.setWindowTitle(f"{title} — {APP_NAME}")
        self.statusBar().showMessage(
            f"{kind}{signed}  ·  {pages} page{'s' if pages != 1 else ''}  ·  "
            f"{self._index + 1}/{len(self._files)} in folder",
            4000,
        )

    def _on_immersive_changed(self, on: bool) -> None:
        if on:
            self._pre_immersive = {
                "maximized": bool(self.isMaximized()),
                "fullscreen": bool(self.isFullScreen()),
                "geom": self.geometry(),
                "status": bool(self.statusBar() and self.statusBar().isVisible()),
                "menu": bool(self.menuBar() and self.menuBar().isVisible()),
            }
            if self.statusBar():
                self.statusBar().hide()
            if self.menuBar():
                self.menuBar().hide()
            self.showFullScreen()
            screen = self.screen() or QGuiApplication.primaryScreen()
            if screen is not None:
                self.setGeometry(screen.geometry())
        else:
            saved = self._pre_immersive or {}
            if saved.get("status") and self.statusBar():
                self.statusBar().show()
            if saved.get("menu") and self.menuBar():
                self.menuBar().show()
            if saved.get("fullscreen"):
                self.showFullScreen()
            elif saved.get("maximized"):
                self.showNormal()
                self.showMaximized()
            else:
                self.showNormal()
                geom = saved.get("geom")
                if geom is not None:
                    self.setGeometry(geom)
            self._pre_immersive = None
        self._layout_host()

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:  # noqa: N802
        md = event.mimeData()
        if md is None or not md.hasUrls():
            return
        for url in md.urls():
            if is_document_file(url.toLocalFile()):
                event.acceptProposedAction()
                return

    def dropEvent(self, event: QDropEvent) -> None:  # noqa: N802
        md = event.mimeData()
        if md is None:
            return
        for url in md.urls():
            path = url.toLocalFile()
            if is_document_file(path):
                self.open_path(path)
                event.acceptProposedAction()
                return

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if self.reader.isVisible() and self.reader.handle_key(event):
            return
        super().keyPressEvent(event)

    def closeEvent(self, event) -> None:  # noqa: N802
        self._save_prefs()
        self.reader.close_document()
        super().closeEvent(event)


def main() -> int:
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(ORG_NAME)
    _apply_app_font(app)
    app.setStyleSheet(
        f"""
        QMainWindow, QWidget {{ background-color: {theme.VOID}; color: {theme.INK}; }}
        QMenuBar {{ background: {theme.SURFACE}; color: {theme.INK}; }}
        QMenuBar::item:selected {{ background: {theme.RAISED}; }}
        QMenu {{ background: {theme.SURFACE}; color: {theme.INK};
                 border: 1px solid {theme.LINE}; }}
        QMenu::item:selected {{ background: {theme.EMBER_DIM}; }}
        """
    )
    win = PageWindow()
    argv_path = next((a for a in sys.argv[1:] if not a.startswith("-")), "")
    if argv_path and os.path.isfile(argv_path):
        win.open_path(argv_path)
    win.show()
    return app.exec()


if __name__ == "__main__":
    src = os.path.dirname(os.path.abspath(__file__))
    if src not in sys.path:
        sys.path.insert(0, src)
    raise SystemExit(main())
