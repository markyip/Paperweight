# Paperweight

輕量 **PDF／EPUB** 閱讀器。最熱門的 PDF 閱讀器太臃腫。

**Language / 語言：** [English](README.md) · 繁體中文

## 為什麼做這個

最熱門的 PDF 閱讀器太臃腫。那是雲端客戶端、編輯器、表單工廠，全塞進一個叫「PDF」的盒子——根本不是閱讀器。不該為了*讀一份檔案*再按一下列印，就裝那麼多東西。

這個程式反過來：**小**、**快**，只留日常會用的——開 PDF／EPUB、捲動、縮放、目錄、書籤、找文字、淺色／深色、**傳送到印表機**。不是企業級 PDF 工廠。

## 下載

到 **Releases** 下載即可，不必下載原始碼。

**Windows**（需要 WebView2，多數 Windows 10／11 已內建）

- **Portable：** `paperweight.exe` — 雙擊就能用，也可以放 USB。免安裝版無法登錄為預設應用程式。
- **安裝包：** `Paperweight_*_x64-setup.exe` — 開始功能表捷徑與解除安裝。可選。安裝後可把 Paperweight 設成 PDF 或 EPUB 的預設開啟程式：**設定 → 應用程式 → 預設應用程式 → Paperweight**，或對檔案按右鍵 → **開啟方式**。仍須由你在 Windows 裡選定；安裝程式不會搶走檔案總管的預設（以免 PDF 縮圖消失）。

**macOS**

目前沒有可直接執行的 macOS 下載版。App 未經簽章與公證，下載下來的 `.dmg`／`.app` 會被 Gatekeeper 隔離，macOS 會拒絕開啟（「Paperweight 已損毀，無法打開」）——未簽章的版本，右鍵→打開也沒用。請自行編譯，只要幾分鐘，而且編譯出來的檔案沒有被瀏覽器下載過，不會被隔離：

```bash
git clone https://github.com/markyip/Paperweight.git
cd Paperweight/tauri
npm install
npm run tauri build
```

需要 [Node.js](https://nodejs.org)、[Rust](https://rustup.rs)，以及 Xcode 命令列工具（`xcode-select --install`）。編譯完成的 App 在 `tauri/src-tauri/target/release/bundle/macos/Paperweight.app`（同目錄也會附帶 `.dmg`）。詳細說明見 `tauri/README.md`。

## 怎麼用

1. 開啟 Paperweight。
2. 把 PDF 或 EPUB 拖進視窗、點空白處，或按 **Ctrl+O**。
3. **Ctrl+P** 可列印。

就這樣。

## 功能

- 開啟 **PDF** 與 **EPUB**
- 連續捲動整份文件
- 縮放，以及把整頁縮進視窗
- 檔案有目錄時可跳章節
- 書籤；檔案還在裝置上時，下次會重開上次的文件
- 尋找文字
- 選取文字並複製；PDF 螢光筆與頁面註解 — 存在本機，不會寫進檔案
- 淺色、深色或跟隨系統
- **Ctrl+P** — 傳送到印表機（系統對話框）
- 有密碼的 PDF：在彈出視窗輸入密碼即可開啟
- 可選番茄鐘

不能編輯、填表，也不能開有 DRM 的檔，也不會改寫原檔。

## 從原始碼編譯

只有要改程式時才需要。請備妥 Node、Rust；Windows 上還要 WebView2，Mac 上還要 Xcode 命令列工具。說明在 `tauri/README.md`。
