# Pageviewer

A lightweight **PDF / EPUB** reader. View only — no editing, no annotation, no form fill, no signing.

**Language / 語言：** English · [繁體中文](README.zh-TW.md)

## Why it exists

This is a **separate app** from [RAWviewer](https://github.com). Photo culling and document reading do not belong in the same window.

It is built for **ultrawide** screens (especially **32:9**): Auto layout shows **five** portrait pages across on 5120×1440, three on 21:9, two on 16:9. Override with **1–6**.

## Features

- **Zoom** (`+` / `−` / Ctrl+scroll). Double-click toggles fit and 160%. Drag to pan when zoomed.
- **Pages across:** Auto, or press **1–6**.
- **Chapters** when the file embeds a TOC (PDF bookmarks, EPUB NCX / nav). **T** or the left edge. Type a page number in the HUD.
- **F** / **F11** full-screen reading. Esc leaves full screen, then the drop zone.
- **Ctrl+← / Ctrl+→** previous / next PDF or EPUB in the same folder.
- **PDF signatures** are detected and badged (“Signed”). There is no signing UI.
- Encrypted PDFs are refused.

## Run

```bash
pixi install
pixi run start
# or: pixi run python src/main.py path\to\book.pdf
```

Drop a file on the window, or **Ctrl+O**.

```bash
pixi run test
```

## Not in this app

Editing, redaction, form fill, creating signatures, DRM / encrypted PDFs, publisher page numbers for EPUB (pagination is a viewport layout).
