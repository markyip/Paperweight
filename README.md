<p align="center">
  <img src="assets/pageviewer.png" width="128" height="128" alt="Paperweight">
</p>

<h1 align="center">Paperweight</h1>

<p align="center">A lightweight <strong>PDF / EPUB</strong> reader.</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/markyip/Paperweight?style=flat-square&labelColor=111113&color=3b82f6&label=version" alt="Latest version">
  <img src="https://img.shields.io/github/downloads/markyip/Paperweight/total?style=flat-square&labelColor=111113&color=3b82f6&label=downloads" alt="Total downloads">
  <img src="https://img.shields.io/badge/license-MIT-a1a1aa?style=flat-square&labelColor=111113" alt="License: MIT">
  <a href="https://www.buymeacoffee.com/markyip">
    <img src="https://img.shields.io/badge/buy%20me%20a%20coffee-☕-d9a441?style=flat-square&labelColor=111113" alt="Buy Me a Coffee">
  </a>
</p>

<p align="center"><strong>Language / 語言：</strong> English · <a href="README.zh-TW.md">繁體中文</a></p>

## Why it exists

The most popular PDF viewer is bulky. That is a cloud client, an editor, and a form factory stuffed into one “PDF” box — not a viewer. You should not need all that just to *read a file* and hit Print.

This app is the opposite: **small**, **fast**, and only daily stuff — open a PDF or EPUB, scroll, zoom, contents, bookmarks, find text, light or dark, **Send to printer**. Not an enterprise PDF factory.

## Download

Get a build from **Releases**. You do not need the source code.

**Windows** (needs WebView2, already on most Windows 10/11 PCs)

- **Portable:** `paperweight.exe` — double-click; put it on a USB stick if you like. Portable builds cannot register as a default app.
- **Installer:** `Paperweight_*_x64-setup.exe` — Start menu shortcut and uninstall. Optional. After install, set Paperweight as the default PDF or EPUB opener in **Settings → Apps → Default apps → Paperweight**, or right-click a file → **Open with**. Windows still asks you to pick Paperweight; the installer does not steal Explorer’s default (that would hide PDF thumbnails).

**macOS**

There is no ready-to-run macOS download. The app isn't code-signed or notarized, so a downloaded `.dmg`/`.app` gets quarantined by Gatekeeper and macOS refuses to open it ("Paperweight is damaged and can't be opened") — right-click → Open doesn't get past that for an unsigned build. Build it yourself instead; it takes a few minutes and the result isn't quarantined since it never touched a browser download:

```bash
git clone https://github.com/markyip/Paperweight.git
cd Paperweight/tauri
npm install
npm run tauri build
```

Needs [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and Xcode command-line tools (`xcode-select --install`). The app lands at `tauri/src-tauri/target/release/bundle/macos/Paperweight.app` (also bundled as a `.dmg` alongside it). See `tauri/README.md` for details.

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
