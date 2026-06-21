// =============================================================
//  GPX → 航跡資料（在「電腦」上跑，不是手錶）
//  用法：node tools/gpx-to-track.js [來源.gpx] [輸出.js]
//    預設來源：C:\Users\<你>\Desktop\金面山.gpx
//    預設輸出：../utils/track-data.js（會被打包進 App，手錶離線即可畫線）
//
//  它會：抽出所有 <trkpt lat lon> → 依最小間距抽稀 → 算邊界 → 產生 track-data.js
//  之後在手錶上就能畫出這條黃色航跡。換航跡＝重跑這支 + 重新安裝。
// =============================================================
const fs = require('fs');
const path = require('path');

// ---------------- 可調設定 ----------------
const MIN_M = 6; // 抽稀：與「上一個保留點」距離 < 這個公尺數就略過（縮小檔案、加快畫線）
// ----------------------------------------

const inPath = process.argv[2] || path.join(require('os').homedir(), 'Desktop', '金面山.gpx');
const outPath = process.argv[3] || path.join(__dirname, '..', 'utils', 'track-data.js');

function parseTrkpts(xml) {
  const pts = [];
  // 只抓 <trkpt lat="..." lon="...">，不會誤抓 <bounds maxlat=...>
  const re = /<trkpt\s+lat="([\-0-9.]+)"\s+lon="([\-0-9.]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (isFinite(lat) && isFinite(lon)) pts.push([lat, lon]);
  }
  return pts;
}

// 等距投影估算公尺（小範圍夠準）
function metres(a, b) {
  const dLat = (b[0] - a[0]) * 111320;
  const dLon = (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function downsample(pts, minM) {
  if (pts.length === 0) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (metres(out[out.length - 1], pts[i]) >= minM) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]); // 一定保留最後一點
  return out;
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }

function main() {
  if (!fs.existsSync(inPath)) {
    console.error('✋ 找不到 GPX：' + inPath);
    console.error('   用法：node tools/gpx-to-track.js <來源.gpx> [輸出.js]');
    process.exit(1);
  }
  const xml = fs.readFileSync(inPath, 'utf8');
  const raw = parseTrkpts(xml);
  if (raw.length < 2) {
    console.error('✋ 這個 GPX 沒有足夠的航跡點（<trkpt>）。');
    process.exit(1);
  }
  const pts = downsample(raw, MIN_M).map((p) => [round6(p[0]), round6(p[1])]);

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLon) minLon = p[1];
    if (p[1] > maxLon) maxLon = p[1];
  }

  const name = path.basename(inPath).replace(/\.gpx$/i, '');
  const body =
`// =============================================================
//  航跡資料（由 tools/gpx-to-track.js 自動產生，請勿手改）
//  來源：${path.basename(inPath)}
//  原始點 ${raw.length} → 抽稀後 ${pts.length}（最小間距 ${MIN_M}m）
// =============================================================
export const TRACK_NAME = ${JSON.stringify(name)};

// [lat, lon] 陣列
export const TRACK = [
${pts.map((p) => `  [${p[0]}, ${p[1]}],`).join('\n')}
];

export const TRACK_BOUNDS = {
  minLat: ${round6(minLat)}, maxLat: ${round6(maxLat)},
  minLon: ${round6(minLon)}, maxLon: ${round6(maxLon)},
};
`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');

  console.log('✔ 航跡產生完成');
  console.log('  來源 :', inPath);
  console.log('  名稱 :', name);
  console.log('  點數 :', raw.length, '→', pts.length);
  console.log('  邊界 : lat', round6(minLat), '~', round6(maxLat), ' lon', round6(minLon), '~', round6(maxLon));
  console.log('  輸出 :', outPath);
}

main();
