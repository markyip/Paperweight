# Pageviewer

輕量 **PDF／EPUB** 閱讀器。只讀——不能編輯、標註、填表或簽署。

**Language / 語言：** [English](README.md) · 繁體中文

## 為什麼獨立

這是與 RAWviewer **分開的應用**。看 RAW 與看書不該塞在同一個視窗。

為 **超寬螢幕**（尤其 **32:9**）設計：自動排版在 5120×1440 上並排 **五** 頁直向頁面，21:9 三頁，16:9 兩頁。可用 **1–6** 覆寫。

## 功能

- **縮放**（`+`／`−`／Ctrl+捲動）。雙擊在適窗與 160% 之間切換。放大後可拖曳平移。
- **並排頁數：** 自動，或按 **1–6**。
- 檔案內嵌目錄時可跳 **章節**（PDF 書籤、EPUB NCX／nav）。**T** 或左緣。HUD 可輸入頁碼。
- **F**／**F11** 全螢幕閱讀。Esc 先離開全螢幕，再回到拖放區。
- **Ctrl+←／Ctrl+→** 同一個資料夾裡上一本／下一本 PDF 或 EPUB。
- **PDF 簽名**只偵測並標示（「Signed」）。沒有簽署介面。
- 加密 PDF 會被拒絕。

## 執行

```bash
pixi install
pixi run start
# 或：pixi run python src/main.py path\to\book.pdf
```

把檔案拖進視窗，或按 **Ctrl+O**。

```bash
pixi run test
```

## 不做的事

編輯、遮擋、填表、**建立**簽名、DRM／加密 PDF、EPUB 出版社頁碼（這裡的「頁」是依視窗切出來的）。
