# Amazfit T-Rex Rudy Map

Amazfit T-Rex 3（Zepp OS）自訂離線等高線地圖 App。讀手錶 GPS、把圖磚顯示在錶面、可拖曳平移與縮放，圖磚以 `data://` 快取在手錶上（不打包進 App，安裝包僅約 100KB）。

A custom offline topographic-map app for the Amazfit T-Rex 3 (Zepp OS): shows your GPS position on contour map tiles, with drag-to-pan, zoom, and on-device `data://` tile caching.

## 功能 Features

- 🛰️ GPS 即時定位點（紅點）
- 🗺️ 等高線地圖（魯地圖 / MOI OSM 圖層）
- 🖐️ 拖曳平移、實體按鍵縮放（上＋ / 下－）、SELECT 回到定位
- 📏 比例尺、時鐘
- 💾 圖磚存在手錶 `data://`，下載過就快取、不重抓
- 📡 手機端 side service 下載圖磚 → 藍牙傳到手錶（ZML）

## 圖資來源 / Attribution

地圖圖磚來自 **happyman（魯地圖）** `https://tile.happyman.idv.tw/`，底圖資料為 **© OpenStreetMap contributors** 與內政部（MOI）圖資。

> ⚠️ 本專案**不含、也不重新散布任何圖磚**；圖磚由 App 於執行時向上述服務下載。使用時請遵守該服務的使用條款與流量規範（僅供個人、非商業用途，勿大量抓取）。

## 架構 Architecture

- `page/index.js` — 手錶端 UI / 地圖渲染（ZML `BasePage`）
- `app-side/index.js` — 手機端 side service：下載 → 轉檔 → 傳輸（ZML `BaseSideService`）
- `utils/tile.js` — Web Mercator 圖磚數學
- `tools/download-tiles.js` — 電腦端批次下載工具（可選）

## 開發 Development

```bash
npm i @zeppos/zeus-cli -g   # Zeus CLI
npm install                 # 專案依賴
zeus dev                    # 模擬器預覽
zeus preview                # 產生 QR 安裝到手錶（需手機 Zepp App 開發者模式）
```

需要手機 Zepp App 連線（side service 在手機端執行才能下載圖磚）。

## License

程式碼 MIT。地圖圖磚與底圖資料的權利屬原始提供者（happyman / OpenStreetMap / MOI），不在本授權範圍內。
