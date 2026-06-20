// =============================================================
//  XYZ 圖磚下載器（在「電腦」上跑，不是手錶）
//  用法：node tools/download-tiles.js
//  會把 {z}/{x}/{y}.png 下載到 OUT_DIR，已存在的會跳過。
//
//  ⚠️ 請只抓你需要的範圍 + 層級；對免費圖磚伺服器要客氣（已內建延遲）。
// =============================================================
const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------- 你要改的設定 ----------------
const URL_TEMPLATE = 'https://tile.happyman.idv.tw/map/moi_osm/{z}/{x}/{y}.png';

// 邊界框：z18 高細節「只能用小範圍」！下面是台北市中心約 1.5km 的小框。
// ⚠️ 要換成你自己的地點：改這四個數字（範圍別超過約 2~3 公里，否則 z18 會爆量）
// 3km 框，中心 25.01728, 121.54033（你給的精確點，公館一帶）
const BBOX = {
  minLon: 121.5254, // 西
  minLat: 25.0038,  // 南
  maxLon: 121.5552, // 東
  maxLat: 25.0308,  // 北
};

const MIN_ZOOM = 15;   // 最小縮放（看越廣）
const MAX_ZOOM = 17;   // 最大縮放（z17 ≈ 100m）

const OUT_DIR = path.join(__dirname, '..', 'tiles_hd');   // 下載到 trex-map/tiles_hd/（乾淨、與舊的分開）
const CONCURRENCY = 4;     // 同時下載數（別調太高，對伺服器客氣）
const DELAY_MS = 80;       // 每張之間的延遲（毫秒）
const MAX_TILES = 20000;   // 安全上限：超過就中止，避免手滑抓爆
const USER_AGENT = 'trex-map-tiledownloader/1.0 (personal offline use)';
// ----------------------------------------------

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

// 先算出每個層級要抓哪些 x/y，並統計總數
function buildPlan() {
  const jobs = [];
  const perZoom = {};
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const xMin = lon2x(BBOX.minLon, z);
    const xMax = lon2x(BBOX.maxLon, z);
    const yMin = lat2y(BBOX.maxLat, z); // 北邊 y 較小
    const yMax = lat2y(BBOX.minLat, z);
    let count = 0;
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        jobs.push({ z, x, y });
        count++;
      }
    }
    perZoom[z] = count;
  }
  return { jobs, perZoom };
}

function tilePath(z, x, y) {
  return path.join(OUT_DIR, String(z), String(x), `${y}.png`);
}

function download({ z, x, y }) {
  return new Promise((resolve) => {
    const out = tilePath(z, x, y);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return resolve('skip');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const url = URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Referer: 'https://happyman.idv.tw/' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve('fail:' + res.statusCode); }
      const file = fs.createWriteStream(out);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve('ok')));
      file.on('error', () => resolve('fail:write'));
    });
    req.on('error', () => resolve('fail:net'));
    req.setTimeout(20000, () => { req.destroy(); resolve('fail:timeout'); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { jobs, perZoom } = buildPlan();
  console.log('=== 下載計畫 ===');
  for (const z of Object.keys(perZoom)) console.log(`  z${z}: ${perZoom[z]} 張`);
  console.log(`  合計: ${jobs.length} 張`);
  if (jobs.length > MAX_TILES) {
    console.error(`✋ 超過安全上限 ${MAX_TILES} 張，已中止。請縮小範圍/層級，或調高 MAX_TILES。`);
    process.exit(1);
  }
  console.log(`輸出資料夾: ${OUT_DIR}\n開始下載...\n`);

  let done = 0, ok = 0, skip = 0, fail = 0;
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      const r = await download(job);
      done++;
      if (r === 'ok') ok++; else if (r === 'skip') skip++; else { fail++; if (fail <= 20) console.warn(`  ✗ ${job.z}/${job.x}/${job.y} -> ${r}`); }
      if (done % 50 === 0 || done === jobs.length) {
        process.stdout.write(`\r進度 ${done}/${jobs.length}  (新增 ${ok} / 跳過 ${skip} / 失敗 ${fail})   `);
      }
      if (r === 'ok') await sleep(DELAY_MS); // 只有真的有抓才延遲
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 統計大小
  let bytes = 0;
  const walk = (d) => fs.existsSync(d) && fs.readdirSync(d).forEach((f) => {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    s.isDirectory() ? walk(p) : (bytes += s.size);
  });
  walk(OUT_DIR);
  console.log(`\n\n完成。新增 ${ok}、跳過 ${skip}、失敗 ${fail}。`);
  console.log(`tiles/ 目前總大小: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

main();
