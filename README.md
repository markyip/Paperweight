# Paperweight

A lightweight **PDF / EPUB** reader.

**Language / 語言：** English · [繁體中文](README.zh-TW.md)

## Why it exists

The most popular PDF viewer is bulky. That is a cloud client, an editor, and a form factory stuffed into one “PDF” box — not a viewer. You should not need all that just to *read a file* and hit Print.

This app is the opposite: **small**, **fast**, and only daily stuff — open a PDF or EPUB, scroll, zoom, contents, bookmarks, find text, light or dark, **Send to printer**. Not an enterprise PDF factory.

## Download

Get a build from **Releases**. You do not need the source code.

**Windows** (needs WebView2, already on most Windows 10/11 PCs)

- **Portable:** `paperweight.exe` — double-click; put it on a USB stick if you like. Portable builds cannot register as a default app.
- **Installer:** `Paperweight_*_x64-setup.exe` — Start menu shortcut and uninstall. Optional. After install, set Paperweight as the default PDF or EPUB opener in **Settings → Apps → Default apps → Paperweight**, or right-click a file → **Open with**. Windows still asks you to pick Paperweight; the installer does not steal Explorer’s default (that would hide PDF thumbnails).

**macOS**

- **`Paperweight_*.dmg`** — open the disk image and drag Paperweight to Applications. If macOS blocks it, right-click the app → **Open**.

macOS builds must be produced on a Mac (or GitHub Actions). They cannot be compiled from Windows.

## How to use

1. Open Paperweight.
2. Drop a PDF or EPUB on the window, click the empty area, or press **Ctrl+O**.
3. **Ctrl+P** to print.

That’s it.

## Features

- Open **PDF** and **EPUB**
- Scroll through the whole document
- Zoom, and fit the page in the window
- Contents, when the file has a table of contents
- Bookmarks, and it reopens the last file if it is still on the device
- Find text
- Select text and copy; PDF highlighter and page comments — stored locally, not written into the file
- Light, dark, or auto appearance
- **Ctrl+P** — Send to printer (system dialog)
- Password-locked PDFs: enter the password in the popup to open
- Optional pomodoro timer

No editing, forms, DRM, or writing into the original file.

## Build from source

Only if you are changing the app. Need Node, Rust, WebView2 on Windows, and Xcode command-line tools on a Mac. See `tauri/README.md`.
