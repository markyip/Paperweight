"""PDF / EPUB detection. Qt-free so tests can import it cheaply."""

from __future__ import annotations

import os
from typing import Optional

DOCUMENT_EXTENSIONS: frozenset[str] = frozenset({".pdf", ".epub"})

KIND_PDF = "pdf"
KIND_EPUB = "epub"


def document_extension(path: Optional[str]) -> str:
    if not path:
        return ""
    return os.path.splitext(path)[1].lower()


def is_document_file(path: Optional[str]) -> bool:
    return document_extension(path) in DOCUMENT_EXTENSIONS


def document_kind(path: Optional[str]) -> Optional[str]:
    ext = document_extension(path)
    if ext == ".pdf":
        return KIND_PDF
    if ext == ".epub":
        return KIND_EPUB
    return None


def get_document_extensions() -> list[str]:
    """Leading-dot extensions, stable order for file dialogs."""
    return [".pdf", ".epub"]


def get_openable_extensions() -> list[str]:
    return get_document_extensions()
