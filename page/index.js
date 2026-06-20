// =============================================================
//  T-Rex Map 主畫面（data:// 版）
//  圖磚不再打包進 App，而是從手錶 data://download/ 讀；缺的就請手機端下載傳來。
//  保留：GPS 紅點、拖曳平移、實體按鍵縮放/回中、時鐘、比例尺
// =============================================================
import { createWidget, deleteWidget, widget, align, prop, event } from '@zos/ui';
import { Geolocation, Time } from '@zos/sensor';
import { queryPermission, requestPermission } from '@zos/app';
import {
  onKey, KEY_SELECT, KEY_SHORTCUT, KEY_UP, KEY_DOWN, KEY_EVENT_CLICK, onGesture,
} from '@zos/interaction';
import { statSync } from '@zos/fs';
import { setScrollLock } from '@zos/page';
import { BasePage } from '@zeppos/zml/base-page';
import {
  lonToTileX, latToTileY, tileXToLon, tileYToLat, TILE_SIZE,
} from '../utils/tile';

const SCREEN = 480;
const CENTER = 240;
const MIN_Z = 14;
const MAX_Z = 18;

// 沒 GPS 時的預設中心（你給的公館點）
const DEFAULT = { lat: 25.01728, lon: 121.54033 };

// 圖磚在手錶上的路徑
const tileKey = (z, x, y) => `${z}_${x}_${y}`;
const tilePath = (z, x, y) => `data://download/t_${z}_${x}_${y}.png`;

Page(
  BasePage({
    build() {
      // 鎖住頁面自由捲動，否則上下拖曳時整個畫面(含 UI)會跟著被頁面推走
      try { setScrollLock({ lock: true }); } catch (e) {}

      this.z = 17;
      this.gpsLat = null;
      this.gpsLon = null;
      this.hasFix = false;
      this.viewLat = DEFAULT.lat;
      this.viewLon = DEFAULT.lon;
      this.follow = true;

      this.scene = [];
      this.mapLayer = [];
      this._dragging = false;
      this._dx0 = 0; this._dy0 = 0; this._lastDx = 0; this._lastDy = 0;

      this.synced = {};    // 已在 data:// 的圖磚 key -> true
      this.requested = {}; // 已請求過的 key（避免重複請求）
      this.pending = 0;    // 還在等的張數

      // 螢幕上診斷用計數器（因為 log 看不到）
      this._sent = 0;      // 送出的請求數
      this._okResp = 0;    // 手機回「下載傳輸成功」數
      this._failResp = 0;  // 手機回失敗數
      this._recv = 0;      // 實際收到檔案數
      this._lastErr = '';  // 最後一個錯誤訊息

      try {
        this.time = new Time();
        this.time.onPerMinute(() => { if (!this._dragging) this.render(); });
      } catch (e) { this.time = null; }

      this.render();
      this.ensureGps();
      this.setupKeys();
    },

    // ---------- 圖磚是否已在手錶 ----------
    tileReady(z, x, y) {
      const k = tileKey(z, x, y);
      if (this.synced[k]) return true;
      // 持久化：檔案已存在（之前下載過）就直接認可，不用重傳
      try {
        const s = statSync({ path: tilePath(z, x, y) });
        if (s && (s.size === undefined || s.size > 0)) { this.synced[k] = true; return true; }
      } catch (e) {}
      return false;
    },

    // ---------- 請手機端下載這張圖磚 ----------
    requestTile(z, x, y) {
      const k = tileKey(z, x, y);
      if (this.requested[k]) return;
      this.requested[k] = true;
      this.pending++;
      this._sent++;
      try {
        this.request({ method: 'tile', params: { z, x, y } })
          .then((r) => {
            if (r && r.ok) { this._okResp++; }
            else { this._failResp++; this._lastErr = (r && r.error) ? String(r.error).slice(0, 40) : 'no-ok'; }
            this._maybeRender();
          })
          .catch((e) => {
            this._failResp++;
            this._lastErr = 'catch:' + String(e).slice(0, 30);
            this.requested[k] = false;
            this.pending = Math.max(0, this.pending - 1);
            this._maybeRender();
          });
      } catch (e) {
        // this.request 同步丟錯（例如還沒連上）→ 不讓它崩 render
        this._failResp++;
        this._lastErr = 'throw:' + String(e).slice(0, 30);
        this.requested[k] = false;
        this.pending = Math.max(0, this.pending - 1);
      }
    },

    // 節流重畫（避免回應一多就狂閃）
    _maybeRender() {
      const now = Date.now();
      if (now - (this._lastRenderTs || 0) < 400) return;
      if (this._dragging) return;
      this.render();
    },

    // ZML：手機端傳檔過來時觸發
    onReceivedFile(fileHandler) {
      try {
        fileHandler.on('change', (e) => {
          if (e.data && e.data.readyState === 'transferred') {
            // 檔名 t_z_x_y.png -> 標記為已同步，重畫讓它顯示
            const name = fileHandler.fileName || '';
            const m = name.match(/t_(\d+)_(\d+)_(\d+)\.png/);
            this._recv++;
            if (m) {
              this.synced[`${m[1]}_${m[2]}_${m[3]}`] = true;
              this.pending = Math.max(0, this.pending - 1);
            }
            this._maybeRender();
          }
        });
      } catch (err) {}
    },

    // ---------- 權限 + GPS ----------
    ensureGps() {
      try {
        let granted = false;
        try {
          const res = queryPermission({ permissions: ['device:os.geolocation'] });
          granted = res && res[0] === 2;
        } catch (e) {}
        if (granted) { this.beginGeo(); return; }
        requestPermission({
          permissions: ['device:os.geolocation'],
          callback: (result) => { try { if (result && result[0] === 2) this.beginGeo(); } catch (e) {} },
        });
      } catch (e) { try { this.beginGeo(); } catch (e2) {} }
    },

    beginGeo() {
      this.geo = new Geolocation();
      this.geo.start();
      this.geo.onChange(() => {
        if (this._dragging) return;
        if (this.geo.getStatus() !== 'A') return;
        const lat = this.geo.getLatitude();
        const lon = this.geo.getLongitude();
        this.gpsLat = lat; this.gpsLon = lon; this.hasFix = true;
        if (this.follow) { this.viewLat = lat; this.viewLon = lon; }
        this.render();
      });
    },

    // ---------- 實體按鍵：上=放大 / 下=縮小 / SELECT=回中 ----------
    setupKeys() {
      try {
        onKey({
          callback: (key, keyEvent) => {
            if (keyEvent !== KEY_EVENT_CLICK) return false;
            if (key === KEY_UP) { this.zoomBy(1); return true; }
            if (key === KEY_DOWN) { this.zoomBy(-1); return true; }
            if (key === KEY_SELECT || key === KEY_SHORTCUT) { this.recenter(); return true; }
            return false;
          },
        });
      } catch (e) {}

      // 阻擋系統滑動手勢（拖地圖時不會誤觸右滑返回；離開請用實體返回鍵）
      try {
        onGesture({ callback: () => true });
      } catch (e) {}
    },

    zoomBy(d) {
      this._dragging = false; // 保險：清掉可能卡住的拖曳狀態
      const nz = this.z + d;
      if (nz < MIN_Z || nz > MAX_Z) return;
      this.z = nz;
      this.render();
    },

    recenter() {
      this._dragging = false; // 保險：清掉拖曳狀態，否則 GPS 會一直被擋住不追蹤
      this.follow = true;
      if (this.hasFix) { this.viewLat = this.gpsLat; this.viewLon = this.gpsLon; }
      else { this.viewLat = DEFAULT.lat; this.viewLon = DEFAULT.lon; }
      this.render();
    },

    // ---------- 拖曳 ----------
    attachDrag(w, bx, by) {
      try {
        w.addEventListener(event.CLICK_DOWN, (e) => {
          this._dragging = true; this._dx0 = e.x; this._dy0 = e.y; this._lastDx = 0; this._lastDy = 0;
        });
        w.addEventListener(event.MOVE, (e) => {
          if (!this._dragging) return;
          const dx = e.x - this._dx0, dy = e.y - this._dy0;
          this._lastDx = dx; this._lastDy = dy;
          for (let i = 0; i < this.mapLayer.length; i++) {
            const it = this.mapLayer[i];
            try { it.w.setProperty(prop.MORE, { x: it.bx + dx, y: it.by + dy }); } catch (err) {}
          }
        });
        w.addEventListener(event.CLICK_UP, () => {
          if (!this._dragging) return;
          this._dragging = false;
          const dx = this._lastDx, dy = this._lastDy;
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          this.commitPan(dx, dy);
        });
      } catch (e) {}
    },

    commitPan(dx, dy) {
      const z = this.z;
      const fx = lonToTileX(this.viewLon, z) - dx / TILE_SIZE;
      const fy = latToTileY(this.viewLat, z) - dy / TILE_SIZE;
      this.viewLon = tileXToLon(fx, z);
      this.viewLat = tileYToLat(fy, z);
      this.follow = false;
      this.render();
    },

    // ---------- 繪製 ----------
    clearScene() {
      this.scene.forEach((w) => { try { deleteWidget(w); } catch (e) {} });
      this.scene = [];
      this.mapLayer = [];
    },

    render() {
      this._lastRenderTs = Date.now();
      this.clearScene();
      const z = this.z;
      const fx = lonToTileX(this.viewLon, z);
      const fy = latToTileY(this.viewLat, z);
      const cx = Math.floor(fx), cy = Math.floor(fy);

      // 全螢幕灰底（最底層）：拖曳露出未載入區時是灰色而非黑色
      try {
        this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: SCREEN, color: 0x555555 }));
      } catch (e) {}

      // 5x5 圖磚（只建畫面內/稍微出界的，避免負座標太多把版面搞亂）
      for (let tx = cx - 2; tx <= cx + 2; tx++) {
        for (let ty = cy - 2; ty <= cy + 2; ty++) {
          const sx = Math.round(CENTER - (fx - tx) * TILE_SIZE);
          const sy = Math.round(CENTER - (fy - ty) * TILE_SIZE);
          // 完全在畫面外(且超過一塊邊界)就不建，避免大量負座標 widget
          if (sx >= SCREEN || sy >= SCREEN || sx + TILE_SIZE <= 0 || sy + TILE_SIZE <= 0) continue;
          if (this.tileReady(z, tx, ty)) {
            const img = createWidget(widget.IMG, {
              x: sx, y: sy, w: TILE_SIZE, h: TILE_SIZE, src: tilePath(z, tx, ty),
            });
            this.scene.push(img);
            this.mapLayer.push({ w: img, bx: sx, by: sy });
            this.attachDrag(img, sx, sy);
          } else {
            // 占位（淺灰）+ 請求下載
            try {
              const ph = createWidget(widget.FILL_RECT, { x: sx, y: sy, w: TILE_SIZE, h: TILE_SIZE, color: 0x666666 });
              this.scene.push(ph);
              this.mapLayer.push({ w: ph, bx: sx, by: sy });
              this.attachDrag(ph, sx, sy);
            } catch (e) {}
            this.requestTile(z, tx, ty);
          }
        }
      }

      // 紅點（GPS 真實位置相對畫面中心）
      if (this.hasFix) {
        const gx = lonToTileX(this.gpsLon, z);
        const gy = latToTileY(this.gpsLat, z);
        const mx = Math.round(CENTER - (fx - gx) * TILE_SIZE);
        const my = Math.round(CENTER - (fy - gy) * TILE_SIZE);
        if (mx > -20 && mx < SCREEN + 20 && my > -20 && my < SCREEN + 20) {
          const c = createWidget(widget.CANVAS, { x: mx - 16, y: my - 16, w: 32, h: 32 });
          c.drawCircle({ center_x: 16, center_y: 16, radius: 9, color: 0xffffff });
          c.drawCircle({ center_x: 16, center_y: 16, radius: 6, color: 0xff3030 });
          this.scene.push(c);
          this.mapLayer.push({ w: c, bx: mx - 16, by: my - 16 });
        }
      }

      // 頂部底色 + 時鐘 + 狀態
      try {
        const topbg = createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: 76, radius: 0, color: 0xffffff, alpha: 180 });
        try { topbg.setAlpha(180); } catch (e) {}
        this.scene.push(topbg);
      } catch (e) {}
      let clock = '';
      try {
        if (this.time) {
          const hh = this.time.getHours(), mm = this.time.getMinutes();
          clock = `${hh < 10 ? '0' + hh : hh}:${mm < 10 ? '0' + mm : mm}`;
        }
      } catch (e) {}
      if (clock) {
        this.scene.push(createWidget(widget.TEXT, {
          x: 0, y: 6, w: SCREEN, h: 36, text: clock, text_size: 32, color: 0x000000,
          align_h: align.CENTER_H, align_v: align.CENTER_V,
        }));
      }
      const status = this.pending > 0
        ? `z${z}  同步中 ${this.pending} 張…`
        : !this.hasFix
        ? `z${z}  定位中…`
        : `z${z}  ${this.gpsLat.toFixed(5)}, ${this.gpsLon.toFixed(5)}`;
      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 44, w: SCREEN, h: 26, text: status, text_size: 20, color: 0x333333,
        align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));


      // 比例尺
      let niceDist = 0, half = 0;
      try {
        const mpp = (156543.03392 * Math.cos((this.viewLat * Math.PI) / 180)) / Math.pow(2, z);
        const cands = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
        niceDist = cands[0];
        for (let i = 0; i < cands.length; i++) { if (cands[i] / mpp <= 130) niceDist = cands[i]; }
        half = Math.round(niceDist / mpp / 2);
      } catch (e) {}
      if (niceDist > 0) {
        const scaleLabel = niceDist >= 1000 ? `${niceDist / 1000} km` : `${niceDist} m`;
        try {
          const scbg = createWidget(widget.FILL_RECT, { x: CENTER - 70, y: 278, w: 140, h: 46, radius: 10, color: 0xffffff, alpha: 180 });
          try { scbg.setAlpha(180); } catch (e) {}
          this.scene.push(scbg);
        } catch (e) {}
        this.scene.push(createWidget(widget.TEXT, {
          x: CENTER - 100, y: 282, w: 200, h: 24, text: scaleLabel, text_size: 22, color: 0x000000,
          align_h: align.CENTER_H, align_v: align.CENTER_V,
        }));
        try {
          const sc = createWidget(widget.CANVAS, { x: CENTER - 100, y: 308, w: 200, h: 10 });
          sc.drawRect({ x1: 100 - half, y1: 3, x2: 100 + half, y2: 7, color: 0x000000 });
          sc.drawRect({ x1: 100 - half, y1: 0, x2: 100 - half + 3, y2: 9, color: 0x000000 });
          sc.drawRect({ x1: 100 + half - 3, y1: 0, x2: 100 + half, y2: 9, color: 0x000000 });
          this.scene.push(sc);
        } catch (e) {}
      }

      // 縮放按鈕（備援）
      this.scene.push(createWidget(widget.BUTTON, {
        x: 120, y: 360, w: 80, h: 80, text: '－', text_size: 40,
        normal_color: 0x333333, press_color: 0x555555, radius: 40,
        click_func: () => { this.zoomBy(-1); },
      }));
      this.scene.push(createWidget(widget.BUTTON, {
        x: 280, y: 360, w: 80, h: 80, text: '＋', text_size: 40,
        normal_color: 0x333333, press_color: 0x555555, radius: 40,
        click_func: () => { this.zoomBy(1); },
      }));
    },

    onDestroy() {
      if (this.geo) this.geo.stop();
    },
  })
);
