# Paperweight — develop

Windows users download **portable** or **installer** builds from GitHub **Releases**. macOS has no signed build to download — see below. This folder is the source for those builds.

Need Node, Rust, WebView2 on Windows, and Xcode command-line tools on macOS.

## Run

```bash
cd tauri
npm install
npm run tauri dev
```

Drop a PDF or EPUB on the window, click the empty area, or press Ctrl+O.

## Build

```bash
cd tauri
npm install
npm run tauri build
```

Tauri only bundles targets for **the OS you are on**.

**Windows**

- Portable: `src-tauri/target/release/paperweight.exe` — cannot register as a default app.
- Installer: `src-tauri/target/release/bundle/nsis/Paperweight_0.1.6_x64-setup.exe` — after install, set the default in Settings → Apps → Default apps → Paperweight, or Open with. The NSIS hooks restore the `.pdf` / `.epub` extension default so Explorer thumbnails stay intact.

**macOS** (run the same command on a Mac)

- App: `src-tauri/target/release/bundle/macos/Paperweight.app`
- Disk image: `src-tauri/target/release/bundle/dmg/Paperweight_0.1.6_*.dmg`

You cannot produce a `.app` / `.dmg` from Windows.

This is the only way to get Paperweight on macOS. The app isn't code-signed or notarized (no Apple Developer account), so CI's `.dmg`/`.app` build artifacts are for CI verification only, not for end-user distribution — a downloaded copy gets Gatekeeper-quarantined and macOS refuses to open it. A locally-built copy never picks up that quarantine flag, so it opens normally straight from `bundle/macos/Paperweight.app` (or drag it to `/Applications`).
