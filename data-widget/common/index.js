// =============================================================
//  Workout Extension（運動中的離線地圖頁）
//  和主 App 同一個 appId → 共用 data://：讀「選定的航跡」(active.txt + tracks.json)
//  和「已下載的圖磚」(data://download)。畫：圖磚 + 選定航跡黃線 + GPS 紅點 + 縮放。
//  ⚠️ 運動頁很在意效能與生命週期：暫停/結束時若還在重畫會卡死、甚至黑屏 → 嚴格守衛。
// =============================================================
import { createWidget, deleteWidget, widget, align } from '@zos/ui';
import { Geolocation } from '@zos/sensor';
import { queryPermission, requestPermission } from '@zos/app';
import { statSync, readFileSync, readdirSync } from '@zos/fs';
import { lonToTileX, latToTileY, TILE_SIZE } from '../../utils/tile';
import { TRACK, TRACK_BOUNDS, TRACK_NAME } from '../../utils/track-data';

const SCREEN = 480, CENTER = 240;
const MIN_Z = 17, MAX_Z = 18, DEF_Z = 17; // 運動頁只給 z17/z18（沿線下載最密的兩層）
const TRACK_COLOR = 0xffe600;
const RENDER_MS = 2000; // GPS 重畫節流：最快 2 秒一次（運動頁要省）
const tilePath = (z, x, y) => `data://download/t_${z}_${x}_${y}.png`;

function parsePts(s) {
  const out = [];
  if (!s) return out;
  const parts = s.split(';');
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i].split(',');
    if (c.length === 2) { const la = parseFloat(c[0]), lo = parseFloat(c[1]); if (isFinite(la) && isFinite(lo)) out.push([la, lo]); }
  }
  return out;
}
function readShared(name) {
  let s = null;
  try { s = readFileSync({ path: name, options: { encoding: 'utf8' } }); } catch (e) {}
  if (!s) { try { s = readFileSync({ path: 'data://' + name, options: { encoding: 'utf8' } }); } catch (e) {} }
  return (s && typeof s === 'string') ? s : '';
}

DataWidget({
  build() {
    this._alive = true;
    this._paused = false;
    this._everFixed = false;
    this._lastRenderTs = 0;
    this._synced = {};
    this._scanned = false;
    this._w = [];

    const at = this.loadActiveTrack();         // 讀主 App 選定的航跡（共用 data://）
    this.trk = at ? at.pts : null;
    this.trkName = at ? at.name : '';
    const c = (at && at.bounds)
      ? { lat: (at.bounds.minLat + at.bounds.maxLat) / 2, lon: (at.bounds.minLon + at.bounds.maxLon) / 2 }
      : { lat: 25.01728, lon: 121.54033 };
    this.viewLat = c.lat; this.viewLon = c.lon;
    this.gpsLat = null; this.gpsLon = null; this.hasFix = false;
    this.z = DEF_Z;

    this.render();
    this.startGps();
  },

  // 選定的航跡：active.txt 的 id → 'builtin'/空=打包金面山；否則去 tracks.json 找
  loadActiveTrack() {
    let activeId = readShared('active.txt').trim();
    if (!activeId || activeId === 'builtin') {
      if (TRACK && TRACK.length >= 2) return { pts: TRACK, bounds: TRACK_BOUNDS, name: TRACK_NAME };
    }
    try {
      const s = readShared('tracks.json');
      if (s) {
        const arr = JSON.parse(s);
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].id === activeId) {
            const pts = parsePts(arr[i].pts);
            if (pts.length >= 2) return { pts, bounds: arr[i].bounds, name: arr[i].name };
          }
        }
      }
    } catch (e) {}
    if (TRACK && TRACK.length >= 2) return { pts: TRACK, bounds: TRACK_BOUNDS, name: TRACK_NAME }; // 退回打包金面山
    return null;
  },

  // 一次把已下載圖磚清單讀進記憶體（之後查記憶體，不要每次重畫都逐張 statSync → 那會卡）
  scanTiles() {
    this._synced = {};
    let names = null;
    try { names = readdirSync({ path: 'data://download' }); } catch (e) {}
    if (!names) { try { names = readdirSync({ path: 'download' }); } catch (e) {} }
    if (names) {
      for (let i = 0; i < names.length; i++) {
        const m = names[i].match(/^t_(\d+)_(\d+)_(\d+)\.png$/);
        if (m) this._synced[`${m[1]}_${m[2]}_${m[3]}`] = true;
      }
    }
    this._scanned = true;
  },
  tileReady(z, x, y) {
    const k = `${z}_${x}_${y}`;
    if (this._synced[k]) return true;
    // 保險：清單沒掃到時偶爾用 statSync 補一張（極少走到）
    try { const s = statSync({ path: tilePath(z, x, y) }); if (s && (s.size === undefined || s.size > 0)) { this._synced[k] = true; return true; } } catch (e) {}
    return false;
  },

  startGps() {
    if (!this._alive || this.geo) return;
    const go = () => {
      if (!this._alive) return;
      try {
        this.geo = new Geolocation();
        this.geo.start();
        this.geo.onChange(() => {
          if (!this._alive || this._paused) return; // 暫停/結束就完全不動畫面（避免卡死/黑屏）
          try {
            if (this.geo.getStatus && this.geo.getStatus() !== 'A') return;
            const la = this.geo.getLatitude(), lo = this.geo.getLongitude();
            if (!isFinite(la) || !isFinite(lo)) return;
            this.gpsLat = la; this.gpsLon = lo; this.hasFix = true;
            this.viewLat = la; this.viewLon = lo;
            if (!this._everFixed) { this._everFixed = true; this.render(); } // 第一次定位馬上畫
            else this.maybeRender();                                        // 之後節流
          } catch (e) {}
        });
      } catch (e) {}
    };
    try {
      let granted = false;
      try { const r = queryPermission({ permissions: ['device:os.geolocation'] }); granted = r && r[0] === 2; } catch (e) {}
      if (granted) go();
      else requestPermission({ permissions: ['device:os.geolocation'], callback: (res) => { try { if (res && res[0] === 2) go(); } catch (e) {} } });
    } catch (e) {}
  },
  stopGps() { try { if (this.geo) this.geo.stop(); } catch (e) {} this.geo = null; },

  // GPS 觸發的重畫：節流（運動頁省電、也避免一直 delete/create widget 卡）
  maybeRender() {
    if (!this._alive || this._paused) return;
    if (Date.now() - this._lastRenderTs < RENDER_MS) return;
    this.render();
  },

  zoomBy(d) {
    if (!this._alive) return;
    const nz = this.z + d;
    if (nz < MIN_Z || nz > MAX_Z) return;
    this.z = nz;
    this.render(); // 使用者按的，立即重畫
  },

  clear() { for (let i = 0; i < this._w.length; i++) { try { deleteWidget(this._w[i]); } catch (e) {} } this._w = []; },

  render() {
    if (!this._alive) return;            // 結束後絕不再碰畫面
    this._lastRenderTs = Date.now();
    if (!this._scanned) this.scanTiles(); // 第一次重畫才掃一次圖磚清單
    this.clear();

    const z = this.z;
    const fx = lonToTileX(this.viewLon, z), fy = latToTileY(this.viewLat, z);
    const cx = Math.floor(fx), cy = Math.floor(fy);

    this._w.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: SCREEN, color: 0x555555 }));

    // 圖磚（共用主 App 下載好的；缺的畫灰）— 查記憶體清單，不逐張 statSync
    for (let tx = cx - 2; tx <= cx + 2; tx++) {
      for (let ty = cy - 2; ty <= cy + 2; ty++) {
        const sx = Math.round(CENTER - (fx - tx) * TILE_SIZE);
        const sy = Math.round(CENTER - (fy - ty) * TILE_SIZE);
        if (sx >= SCREEN || sy >= SCREEN || sx + TILE_SIZE <= 0 || sy + TILE_SIZE <= 0) continue;
        if (this.tileReady(z, tx, ty)) this._w.push(createWidget(widget.IMG, { x: sx, y: sy, w: TILE_SIZE, h: TILE_SIZE, src: tilePath(z, tx, ty) }));
        else this._w.push(createWidget(widget.FILL_RECT, { x: sx, y: sy, w: TILE_SIZE, h: TILE_SIZE, color: 0x666666 }));
      }
    }

    // 選定航跡黃線：只投影/畫「視窗附近」的點（先用經緯度粗篩，省掉長航跡幾千點的投影）
    if (this.trk && this.trk.length >= 2) {
      try {
        const cv = createWidget(widget.CANVAS, { x: 0, y: 0, w: SCREEN, h: SCREEN });
        const margin = (12 * 360) / Math.pow(2, z); // 約 12 塊圖磚的經度跨度
        const vLat = this.viewLat, vLon = this.viewLon;
        const near = (p) => (Math.abs(p[0] - vLat) < margin && Math.abs(p[1] - vLon) < margin);
        const sx = (lon) => Math.round(CENTER - (fx - lonToTileX(lon, z)) * TILE_SIZE);
        const sy = (lat) => Math.round(CENTER - (fy - latToTileY(lat, z)) * TILE_SIZE);
        for (let i = 1; i < this.trk.length; i++) {
          const p0 = this.trk[i - 1], p1 = this.trk[i];
          if (!near(p0) && !near(p1)) continue; // 兩端都離視窗很遠 → 跳過（不投影、不畫）
          const ax = sx(p0[1]), ay = sy(p0[0]), bx = sx(p1[1]), by = sy(p1[0]);
          const dx = bx - ax, dy = by - ay;
          const len = Math.sqrt(dx * dx + dy * dy);
          let nx = 0, ny = 0; if (len > 0.001) { nx = -dy / len; ny = dx / len; }
          for (let o = -1; o <= 1; o++) {
            cv.drawLine({ x1: Math.round(ax + nx * o), y1: Math.round(ay + ny * o), x2: Math.round(bx + nx * o), y2: Math.round(by + ny * o), color: TRACK_COLOR });
          }
        }
        this._w.push(cv);
      } catch (e) {}
    }

    // GPS 紅點
    if (this.hasFix) {
      const gx = lonToTileX(this.gpsLon, z), gy = latToTileY(this.gpsLat, z);
      const mx = Math.round(CENTER - (fx - gx) * TILE_SIZE), my = Math.round(CENTER - (fy - gy) * TILE_SIZE);
      if (mx > -20 && mx < SCREEN + 20 && my > -20 && my < SCREEN + 20) {
        const c = createWidget(widget.CANVAS, { x: mx - 16, y: my - 16, w: 32, h: 32 });
        c.drawCircle({ center_x: 16, center_y: 16, radius: 9, color: 0xffffff });
        c.drawCircle({ center_x: 16, center_y: 16, radius: 6, color: 0xff3030 });
        this._w.push(c);
      }
    }

    // 標題（選定航跡名稱）
    const title = (this.trkName || 'Rudy map') + (this.hasFix ? '' : ' · 定位中');
    this._w.push(createWidget(widget.TEXT, {
      x: 0, y: 8, w: SCREEN, h: 28, text: title, text_size: 22, color: 0x000000,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    }));

    // 縮放 −／＋（z17–18）+ 目前層級
    this._w.push(createWidget(widget.BUTTON, {
      x: 96, y: 360, w: 76, h: 76, text: '－', text_size: 40,
      normal_color: 0x000000, press_color: 0x444444, radius: 38, click_func: () => { this.zoomBy(-1); },
    }));
    this._w.push(createWidget(widget.BUTTON, {
      x: 308, y: 360, w: 76, h: 76, text: '＋', text_size: 40,
      normal_color: 0x000000, press_color: 0x444444, radius: 38, click_func: () => { this.zoomBy(1); },
    }));
    this._w.push(createWidget(widget.TEXT, {
      x: 0, y: 384, w: SCREEN, h: 28, text: 'z' + z, text_size: 22, color: 0x000000,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    }));
  },

  onInit() {},
  // 運動頁的生命週期：暫停就停 GPS、不再重畫；恢復再開
  onPause() { this._paused = true; this.stopGps(); },
  onResume() { this._paused = false; if (this._alive) { this.startGps(); this.render(); } },
  onDestroy() { this._alive = false; this.stopGps(); },
});
