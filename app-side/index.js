// =============================================================
//  手機端 Side Service：下載圖磚 → 轉檔 → 傳到手錶 data://
//  手錶 device app 透過 this.request({method:'tile', params:{z,x,y}}) 觸發
//  傳完的檔會落在手錶的 data://download/t_{z}_{x}_{y}.png
// =============================================================
import { BaseSideService } from '@zeppos/zml/base-side';
import { convertLib } from '@zeppos/zml/base-side';

const LAYER = 'moi_osm'; // happyman 圖層
const URL = (z, x, y) => `https://tile.happyman.idv.tw/map/${LAYER}/${z}/${x}/${y}.png`;

// 取出 Google Drive 檔案 ID（支援 /file/d/ID/ 與 ?id=ID 兩種）
function driveId(u) {
  if (!u) return '';
  let m = u.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (m) return m[1];
  if (u.indexOf('drive.google.com') >= 0) { m = u.match(/[?&]id=([^&]+)/); if (m) return m[1]; }
  return '';
}

// 一個分享連結 → 一串「可能可直接下載」的候選網址（依序試）
function directCandidates(u) {
  const id = driveId(u);
  if (id) return [
    'https://drive.usercontent.google.com/download?id=' + id + '&export=download',
    'https://drive.google.com/uc?export=download&id=' + id,
  ];
  if (u && u.indexOf('dropbox.com') >= 0) return [u.replace('dl=0', 'dl=1').replace('?raw=0', '?raw=1')];
  return [u];
}

// 從下載回應標頭 Content-Disposition 取檔名（去掉 .gpx）；支援中文 filename*=UTF-8''…
function filenameFromHeaders(headers) {
  if (!headers) return '';
  const cd = headers['content-disposition'] || headers['Content-Disposition'] || '';
  if (!cd) return '';
  let m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[1]).replace(/\.gpx$/i, '').trim(); } catch (e) {} }
  m = cd.match(/filename="?([^";]+)"?/i);
  if (m) return m[1].replace(/\.gpx$/i, '').trim();
  return '';
}
// 從網址結尾取檔名（GitHub raw 等直接網址用）
function nameFromUrl(u) {
  if (!u) return '';
  const m = u.match(/\/([^/?#]+)\.gpx(\?|#|$)/i);
  if (m) { try { return decodeURIComponent(m[1]).trim(); } catch (e) { return m[1]; } }
  return '';
}

// 解析 GPX → 抽稀(最小間距8m) → 回傳精簡字串 "lat,lon;lat,lon;..." + 邊界 + 名稱
function parseGpx(xml) {
  const re = /<trkpt\s+lat="([\-0-9.]+)"\s+lon="([\-0-9.]+)"/g;
  const pts = []; let m;
  while ((m = re.exec(xml)) !== null) {
    const la = parseFloat(m[1]), lo = parseFloat(m[2]);
    if (isFinite(la) && isFinite(lo)) pts.push([la, lo]);
  }
  const out = [];
  if (pts.length) {
    out.push(pts[0]);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i];
      const dLat = (b[0] - a[0]) * 111320;
      const dLon = (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
      if (Math.sqrt(dLat * dLat + dLon * dLon) >= 8) out.push(b);
    }
    out.push(pts[pts.length - 1]);
  }
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, str = '';
  for (let i = 0; i < out.length; i++) {
    const la = r6(out[i][0]), lo = r6(out[i][1]);
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    str += (i ? ';' : '') + la + ',' + lo;
  }
  let name = '';
  const nm = xml.match(/<name>([^<]+)<\/name>/);
  if (nm) name = nm[1].replace(/\s+/g, ' ').trim().slice(0, 20);
  return { name: name || '匯入航跡', raw: pts.length, n: out.length, pts: str, bounds: { minLat, maxLat, minLon, maxLon } };
}

AppSideService(
  BaseSideService({
    onInit() {},
    onRun() {},
    onDestroy() {},

    // 下載一張圖磚（把回呼式的 download 包成 Promise）
    downloadTile(z, x, y) {
      return new Promise((resolve, reject) => {
        const task = this.download(URL(z, x, y), {
          headers: { 'User-Agent': 'trex-map/1.0', Referer: 'https://happyman.idv.tw/' },
          timeout: 60000,
          filePath: `t_${z}_${x}_${y}.png`, // 存到 side 的 data://download/
        });
        if (!task) return reject('no task');
        task.onSuccess = (data) => resolve(data.filePath);
        task.onFail = (data) => reject(data);
      });
    },

    async onRequest(req, res) {
      if (req.method === 'tile') {
        const { z, x, y } = req.params || {};
        try {
          const filePath = await this.downloadTile(z, x, y);     // 下載
          await convertLib.convert({ filePath, targetFilePath: filePath }); // 轉成手錶能顯示的格式
          this.sendFile(filePath, { type: 'png', name: `t_${z}_${x}_${y}.png` }); // 藍牙傳到手錶
          res(null, { ok: true, z, x, y });
        } catch (e) {
          res(null, { ok: false, z, x, y, error: String(e) });
        }
        return;
      }
      if (req.method === 'track') {
        let url = (req.params || {}).url;
        let userName = '';
        // 沒帶網址 → 讀手機設定頁填的 gpxUrl + gpxName（軌跡名稱）
        if (!url) {
          try { url = this.settings.getItem('gpxUrl'); } catch (e) {}
          try { userName = this.settings.getItem('gpxName') || ''; } catch (e) {}
        }
        try {
          if (!url) { res(null, { ok: false, error: '手機設定頁還沒填網址' }); return; }
          const cands = directCandidates(url);
          let got = '', info = '', fname = '';
          for (let i = 0; i < cands.length; i++) {
            const resp = await fetch({ url: cands[i], method: 'GET', headers: { 'User-Agent': 'trex-map/1.0' } });
            let body = resp && resp.body;
            if (typeof body !== 'string') body = body == null ? '' : String(body);
            info = '(' + body.length + 'B,st=' + (resp && resp.status) + ')';
            if (body.indexOf('<trkpt') >= 0) { got = body; fname = filenameFromHeaders(resp && resp.headers); break; }
          }
          if (!got) { res(null, { ok: false, error: 'no trkpt ' + info }); return; }
          const t = parseGpx(got);
          // 名字：手機設定的「軌跡名稱」優先；沒填才退回 下載檔名 → 網址檔名 → GPX 內 <name>
          const name = (userName && userName.trim()) || fname || nameFromUrl(url) || t.name;
          res(null, { ok: true, name, n: t.n, raw: t.raw, pts: t.pts, bounds: t.bounds });
        } catch (e) {
          res(null, { ok: false, error: String(e).slice(0, 60) });
        }
        return;
      }
      res(null, { ok: false, error: 'unknown method' });
    },
  })
);
