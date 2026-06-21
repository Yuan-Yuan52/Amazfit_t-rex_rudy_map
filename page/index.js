// =============================================================
//  T-Rex Map 主畫面（data:// 版）
//  圖磚不再打包進 App，而是從手錶 data://download/ 讀；缺的就請手機端下載傳來。
//  保留：GPS 紅點、拖曳平移、實體按鍵縮放/回中、時鐘、比例尺
// =============================================================
import { createWidget, deleteWidget, widget, align, prop, event, text_style } from '@zos/ui';
import { Geolocation, Time } from '@zos/sensor';
import { queryPermission, requestPermission } from '@zos/app';
import {
  onKey, KEY_SELECT, KEY_SHORTCUT, KEY_UP, KEY_DOWN, KEY_BACK, KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS, onGesture,
} from '@zos/interaction';
import { statSync, readdirSync, rmSync, readFileSync, writeFileSync } from '@zos/fs';
import { setScrollLock, scrollTo } from '@zos/page';
import {
  setPageBrightTime, resetPageBrightTime,
  pauseDropWristScreenOff, resetDropWristScreenOff,
  pausePalmScreenOff, resetPalmScreenOff,
} from '@zos/display';
import { localStorage } from '@zos/storage';
import { BasePage } from '@zeppos/zml/base-page';
import {
  lonToTileX, latToTileY, tileXToLon, tileYToLat, TILE_SIZE,
} from '../utils/tile';
import { TRACK, TRACK_BOUNDS, TRACK_NAME } from '../utils/track-data';

const SCREEN = 480;
const CENTER = 240;
const MIN_Z = 15; // 不提供 z14（太廣、沒沿線下載，鎖死最小到 15）
const MAX_Z = 18;

// 沒 GPS 時的預設中心（你給的公館點）
const DEFAULT = { lat: 25.01728, lon: 121.54033 };

// 航跡顏色（黃）與沿線預先下載要涵蓋的縮放層級
const TRACK_COLOR = 0xffe600;
const TRACK_DL_ZOOMS = [15, 16, 17, 18];
// 每層往外帶幾圈鄰磚：z17 最常用→帶 2 圈（涵蓋更廣）、z18 量大→不帶、其餘 1 圈
const TRACK_DL_RING = { 15: 0, 16: 1, 17: 2, 18: 0 };

// 設定疊層：更新頻率選項
const FREQ_OPTS = [
  { label: '高', sub: '即時', value: 1000 },
  { label: '中', sub: '3 秒', value: 3000 },
  { label: '低', sub: '6 秒', value: 6000 },
];
const hasTrack = TRACK && TRACK.length >= 2; // 是否有打包的內建航跡（金面山）

// 步驟1 測試：先固定一個雲端 GPX 來抓（第3步再改成使用者自己填）
const TEST_TRACK_URL = 'https://drive.google.com/file/d/1SyDmQov0SckuOGfCPH_a25_MKInx7Zf-/view?usp=sharing';

// 圖磚在手錶上的路徑
const tileKey = (z, x, y) => `${z}_${x}_${y}`;
const tilePath = (z, x, y) => `data://download/t_${z}_${x}_${y}.png`;

Page(
  BasePage({
    build() {
      this._t0 = Date.now();        // 量「進 build → 第一個畫面建好」花多久（診斷開檔慢用）
      this._firstPaintMs = null;
      this._scanMs = null;
      // 鎖住頁面自由捲動，否則上下拖曳時整個畫面(含 UI)會跟著被頁面推走
      try { setScrollLock({ lock: true }); } catch (e) {}

      // 更新頻率設定（畫面多久跟著 GPS 重畫一次；省電用）
      this.gpsInterval = this.loadGpsInterval();
      this._lastGpsRender = 0;
      this._grLat = 0; this._grLon = 0; this._rendered = false;

      // 航跡：是否顯示 + 沿線批次下載狀態
      this.showTrack = this.loadShowTrack();
      this.dlActive = false; this.dlQueue = []; this.dlTotal = 0; this.dlDone = 0;
      this.dlInflight = 0; this.dlWaiting = {};
      this._dlPreparing = false; // 按下下載後、還在算航跡涵蓋圖磚時，先顯示「計算中」

      // 'map' 地圖 / 'settings' 設定 / 'downloading' 下載進度 / 'tiles' 管理圖磚 / 'tracks' 管理航跡
      this.ui = 'map';
      this._impStatus = '';   // 匯入狀態/診斷文字
      this._pendingDelete = null; // 待確認的刪除動作（圖磚）
      this._tileCat = null; this._tileDetail = null; // 管理圖磚：點進去的類別 + 其詳細掃描
      this._pendingTrackDel = null; // 待確認刪除的航跡 id
      this._tileScan = null;   // 已下載圖磚掃描結果快取

      // 航跡清單：內建(打包) + 匯入(存 localStorage)；選定的那條驅動「畫線/移到航跡/下沿線圖磚」
      this.tracks = [];
      if (hasTrack) this.tracks.push({ id: 'builtin', name: TRACK_NAME, pts: TRACK, bounds: TRACK_BOUNDS, builtin: true });
      const _imp = this.loadImportedTracks();
      for (let i = 0; i < _imp.length; i++) this.tracks.push(_imp[i]);
      this.activeId = this.loadActiveId();
      if (!this.activeTrack() && this.tracks[0]) this.activeId = this.tracks[0].id;
      this._keySetsVer = 1; // 航跡涵蓋圖磚集合的版本（匯入/刪航跡時 ++，每條航跡各自快取自己的版本）

      const _at = this.activeTrack();
      const _c = this.centerOf(_at);
      this.z = _at ? 16 : 17; // 有航跡時用 z16 先框住整條
      this.gpsLat = null;
      this.gpsLon = null;
      this.hasFix = false;
      this.viewLat = _c.lat;
      this.viewLon = _c.lon;
      this.follow = true;

      this.scene = [];
      this.mapLayer = [];
      this._trackCv = null; // 航跡線 CANVAS 的參考（拖曳時暫時藏起來）
      this._dragging = false;
      this._dx0 = 0; this._dy0 = 0; this._lastDx = 0; this._lastDy = 0;

      this.synced = {};    // 已在 data:// 的圖磚 key -> true
      this.requested = {}; // 已請求過的 key（避免重複請求）
      this.pending = 0;    // 還在等的張數
      this._tilesScanned = false; // 開檔還沒掃已下載圖磚清單前先全灰、不查不請求（避免開檔卡）

      // 螢幕上診斷用計數器（因為 log 看不到）
      this._sent = 0;      // 送出的請求數
      this._okResp = 0;    // 手機回「下載傳輸成功」數
      this._failResp = 0;  // 手機回失敗數
      this._recv = 0;      // 實際收到檔案數
      this._lastErr = '';  // 最後一個錯誤訊息

      try {
        this.time = new Time();
        this.time.onPerMinute(() => { if (!this._dragging && this.ui === 'map') this.render(); });
      } catch (e) { this.time = null; }

      this.render();      // 先把畫面（航跡中心）畫出來
      this.setupKeys();
      // 抓 GPS、掃已下載圖磚都延後到第一個畫面出來之後，避免拖慢開檔（這兩件都可能要幾百 ms）
      try {
        setTimeout(() => {
          try { this.ensureGps(); } catch (e) {}     // 開始抓 GPS（抓到會自動跳過去）
          const s0 = Date.now();
          this._loadSyncedFromDisk();                // 讀已下載圖磚清單
          this._scanMs = Date.now() - s0;            // 量掃圖花多久
          this._tilesScanned = true;
          if (this.ui === 'map' && !this._dragging) this.render();
        }, 50);
      } catch (e) { try { this.ensureGps(); } catch (e2) {} this._loadSyncedFromDisk(); this._tilesScanned = true; }
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
      if (this._dragging || this.ui !== 'map') return;
      const now = Date.now();
      if (now - (this._lastRenderTs || 0) < 400) return;
      this.render();
    },

    // ZML：手機端傳檔過來時觸發
    onReceivedFile(fileHandler) {
      try {
        fileHandler.on('change', (e) => {
          if (e.data && e.data.readyState === 'transferred') {
            // 檔名 t_z_x_y.png -> 真的進手錶了，標記已同步
            const name = fileHandler.fileName || '';
            const m = name.match(/t_(\d+)_(\d+)_(\d+)\.png/);
            this._recv++;
            if (m) {
              const k = `${m[1]}_${m[2]}_${m[3]}`;
              this.synced[k] = true;
              this.pending = Math.max(0, this.pending - 1);
              // 批次下載：這張「確實傳進手錶」才計入進度
              if (this.dlWaiting && this.dlWaiting[k]) { this._dlSettle(k, true); return; }
            }
            this._maybeRender();
          }
        });
      } catch (err) {}
    },

    // ---------- 航跡清單 / 選定 ----------
    activeTrack() {
      if (!this.tracks || !this.tracks.length) return null;
      for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].id === this.activeId) return this.tracks[i];
      return this.tracks[0];
    },
    centerOf(t) {
      if (t && t.bounds) return { lat: (t.bounds.minLat + t.bounds.maxLat) / 2, lon: (t.bounds.minLon + t.bounds.maxLon) / 2 };
      return { lat: DEFAULT.lat, lon: DEFAULT.lon };
    },
    // 取得航跡座標陣列；匯入航跡是延後解析（第一次真的要用時才把字串轉陣列、之後快取在 t.pts）
    _ptsOf(t) {
      if (!t) return [];
      if (t.pts && t.pts.length) return t.pts;
      if (t.ptsRaw) { t.pts = this._parsePts(t.ptsRaw); return t.pts; }
      return [];
    },
    // 一條航跡涵蓋的圖磚 key 集合（含鄰磚圈）；快取在 t._keys、用版本號失效
    _keysFor(t) {
      if (!t) return {};
      if (t._keys && t._keysVer === this._keySetsVer) return t._keys;
      const arr = this.buildTileSetFor(this._ptsOf(t));
      const keys = {};
      for (let j = 0; j < arr.length; j++) keys[`${arr[j].z}_${arr[j].x}_${arr[j].y}`] = true;
      t._keys = keys; t._keysVer = this._keySetsVer;
      return keys;
    },
    setActive(id) {
      this.activeId = id;
      this.saveActiveId();
      this.render();
    },
    // 選定的航跡存成檔案（data:// 檔案實測會留著，比 localStorage 可靠；localStorage 重裝/有時會被清掉）
    saveActiveId() {
      const id = this.activeId || '';
      try { writeFileSync({ path: 'active.txt', data: id, options: { encoding: 'utf8' } }); } catch (e) {}
      try { localStorage.setItem('activeTrack', id); } catch (e) {} // 雙保險
    },
    loadActiveId() {
      try {
        let s = null;
        try { s = readFileSync({ path: 'active.txt', options: { encoding: 'utf8' } }); } catch (e) {}
        if (!s) { try { s = readFileSync({ path: 'data://active.txt', options: { encoding: 'utf8' } }); } catch (e) {} }
        if (s && typeof s === 'string' && s.trim()) return s.trim();
      } catch (e) {}
      try { return localStorage.getItem('activeTrack', '') || ''; } catch (e) { return ''; }
    },
    // 匯入航跡存/讀（localStorage，pts 以精簡字串保存）
    _ptsToStr(pts) { let s = ''; for (let i = 0; i < pts.length; i++) s += (i ? ';' : '') + pts[i][0] + ',' + pts[i][1]; return s; },
    // 匯入航跡存成檔案（localStorage 單值有大小上限，航跡座標會超過 → 存不進、重開就不見）
    loadImportedTracks() {
      try {
        let s = null;
        try { s = readFileSync({ path: 'tracks.json', options: { encoding: 'utf8' } }); } catch (e) {}
        if (!s) { try { s = readFileSync({ path: 'data://tracks.json', options: { encoding: 'utf8' } }); } catch (e) {} }
        if (!s || typeof s !== 'string') return [];
        const arr = JSON.parse(s);
        const out = [];
        for (let i = 0; i < arr.length; i++) {
          const t = arr[i];
          // 開檔不解析座標（大航跡會卡幾秒）→ 先留字串，真的要畫線/算圖磚時才 _ptsOf() 解析
          if (typeof t.pts === 'string' && t.pts.indexOf(';') >= 0) {
            out.push({ id: t.id, name: t.name, ptsRaw: t.pts, pts: null, bounds: t.bounds });
          }
        }
        return out;
      } catch (e) { return []; }
    },
    saveImportedTracks() {
      try {
        const arr = [];
        for (let i = 0; i < this.tracks.length; i++) {
          const t = this.tracks[i];
          if (t.builtin) continue;
          // 已解析的用陣列序列化；還沒解析過的直接沿用原字串（不必為了存檔去解析）
          const ptsStr = (t.pts && t.pts.length) ? this._ptsToStr(t.pts) : (t.ptsRaw || '');
          arr.push({ id: t.id, name: t.name, pts: ptsStr, bounds: t.bounds });
        }
        writeFileSync({ path: 'tracks.json', data: JSON.stringify(arr), options: { encoding: 'utf8' } });
      } catch (e) {}
    },
    deleteTrack(id) {
      const nt = [];
      for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].id !== id) nt.push(this.tracks[i]);
      this.tracks = nt;
      this._keySetsVer++;
      if (this.activeId === id) { this.activeId = this.tracks[0] ? this.tracks[0].id : ''; this.saveActiveId(); }
      this.saveImportedTracks();
      this._pendingTrackDel = null;
      this.render();
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

    loadGpsInterval() {
      try {
        const v = parseInt(localStorage.getItem('gpsInterval', '1000'), 10);
        return v && v > 0 ? v : 1000;
      } catch (e) { return 1000; }
    },

    loadShowTrack() {
      try { return localStorage.getItem('showTrack', '1') !== '0'; } catch (e) { return true; }
    },

    // ---------- 疊層導覽（直接改狀態，立即生效，不靠換頁）----------
    openSettings() { this.ui = 'settings'; this._pendingDelete = null; this.render(); this._enterOverlay(); },
    closeSettings() { this.ui = 'map'; this._leaveOverlay(); this.render(); },
    // 實體返回鍵：一層一層退（詳細→清單→設定→地圖；確認框先取消）
    _backOneLevel() {
      if (this._pendingTrackDel) { this._pendingTrackDel = null; this.render(); return; }
      if (this._pendingDelete) { this.cancelDelete(); return; }
      if (this.ui === 'tiles' && this._tileCat) { this._tileCat = null; this._tileDetail = null; this.render(); return; }
      if (this.ui === 'tiles' || this.ui === 'tracks') { this.openSettings(); return; }
      if (this.ui === 'downloading') { this.exitDownloadView(); return; }
      this.closeSettings(); // settings → 地圖
    },
    openTiles() { this.ui = 'tiles'; this._tileCat = null; this._tileDetail = null; this._pendingDelete = null; this.render(); this._enterOverlay(); },
    openTracks() { this.ui = 'tracks'; this.render(); this._enterOverlay(); },
    // 疊層用系統原生捲動：解鎖頁面捲動 + 回到頂端；離開時鎖回（地圖要鎖住才不會被拖走）
    _enterOverlay() { try { scrollTo({ y: 0 }); } catch (e) {} try { setScrollLock({ lock: false }); } catch (e) {} },
    _leaveOverlay() { try { setScrollLock({ lock: true }); } catch (e) {} try { scrollTo({ y: 0 }); } catch (e) {} },

    // ---------- 已下載圖磚：掃描 / 分類 / 刪除 ----------
    scanTiles() {
      let names = null;
      try { names = readdirSync({ path: 'data://download' }); } catch (e) {}
      if (!names) { try { names = readdirSync({ path: 'download' }); } catch (e) {} }
      return names || [];
    },
    // 開檔時把「已下載的圖磚 key」一次讀進 synced，之後 tileReady 直接記憶體查、不用逐張 statSync
    // （圖磚一多時，每次畫面都逐張 statSync 會越來越慢 → 這就是「越開越慢」的主因）
    _loadSyncedFromDisk() {
      try {
        const names = this.scanTiles();
        for (let i = 0; i < names.length; i++) {
          const m = names[i].match(/^t_(\d+)_(\d+)_(\d+)\.png$/);
          if (m) this.synced[`${m[1]}_${m[2]}_${m[3]}`] = true;
        }
      } catch (e) {}
    },
    // 詳細頁用：張數從記憶體的 synced 算（開檔已掃過），大小用抽樣估（最多 statSync 40 張）
    // 重點：絕不逐張 statSync 整個圖庫——大航跡有上千張，會把手錶卡到自動重啟。
    scanCategory(catId) {
      const sets = this._getKeySets();
      let label = 'GPS·瀏覽';
      if (catId !== 'gps') { for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].id === catId) label = this.tracks[i].name; }
      let count = 0; const sample = [];
      for (const key in this.synced) {
        if (!this.synced[key]) continue;
        let cat = 'gps';
        for (let s = 0; s < sets.length; s++) { if (sets[s].keys[key]) { cat = sets[s].id; break; } }
        if (cat !== catId) continue;
        count++;
        if (sample.length < 40) sample.push(key);
      }
      let sb = 0, sn = 0;
      for (let i = 0; i < sample.length; i++) {
        const p = sample[i].split('_');
        try { const st = statSync({ path: tilePath(p[0], p[1], p[2]) }); if (st && st.size) { sb += st.size; sn++; } } catch (e) {}
      }
      const bytes = sn ? Math.round((sb / sn) * count) : 0;
      return { id: catId, name: label, count, bytes, est: count > sn };
    },
    openTileDetail(catId) { this._tileCat = catId; this._tileDetail = this.scanCategory(catId); this._pendingDelete = null; this.render(); try { scrollTo({ y: 0 }); } catch (e) {} },
    mb(bytes) { return ((bytes || 0) / 1048576).toFixed(1); },
    // kind：'all' | 'gps' | 航跡 id。刪某條航跡只建「那一條」的集合；'all' 不需任何集合（省記憶體、避免重啟）
    deleteTiles(kind) {
      const names = this.scanTiles();
      let single = null, allSets = null;
      if (kind !== 'all') {
        if (kind === 'gps') allSets = this._getKeySets();      // gps=不屬於任何航跡 → 需要全部集合
        else single = this._keysFor(this._trackById(kind));    // 某條航跡 → 只建那一條
      }
      let n = 0;
      for (let i = 0; i < names.length; i++) {
        const m = names[i].match(/^t_(\d+)_(\d+)_(\d+)\.png$/);
        if (!m) continue;
        const key = `${m[1]}_${m[2]}_${m[3]}`;
        let del;
        if (kind === 'all') del = true;
        else if (single) del = !!single[key];
        else { let inAny = false; for (let s = 0; s < allSets.length; s++) { if (allSets[s].keys[key]) { inAny = true; break; } } del = !inAny; }
        if (del) {
          try { rmSync({ path: `data://download/${names[i]}` }); n++; } catch (e) {}
          this.synced[key] = false; this.requested[key] = false;
        }
      }
      return n;
    },
    confirmDelete() {
      if (this._pendingDelete) this.deleteTiles(this._pendingDelete.kind);
      this._pendingDelete = null;
      this._tileCat = null; this._tileDetail = null; // 刪完回到類別清單
      this.render();
    },
    cancelDelete() { this._pendingDelete = null; this.render(); },

    setFreq(v) {
      this.gpsInterval = v;
      try { localStorage.setItem('gpsInterval', String(v)); } catch (e) {}
      this.render();
    },
    toggleTrackVis() {
      this.showTrack = !this.showTrack;
      try { localStorage.setItem('showTrack', this.showTrack ? '1' : '0'); } catch (e) {}
      this.render();
    },
    doDownload() {
      if (!hasTrack) { this.ui = 'map'; this._leaveOverlay(); this.render(); return; }
      this.ui = 'downloading'; // 顯示進度疊層（單頁，鎖捲動）
      this._leaveOverlay();
      // 先把第二層畫面畫出來（顯示「計算中」），再延後做重工作：算航跡涵蓋哪些圖磚 + 過濾已有
      this._dlPreparing = true;
      this.render();
      try { setTimeout(() => { this._dlPreparing = false; this.startTrackDownload(); }, 30); }
      catch (e) { this._dlPreparing = false; this.startTrackDownload(); }
    },
    exitDownloadView() { this.ui = 'map'; this._leaveOverlay(); this.render(); },
    stopDownload() {
      this.dlActive = false;
      this._keepAwake(false);
      // 等待中的：清計時器、還原 requested
      for (const k in this.dlWaiting) {
        try { if (this.dlWaiting[k].timer) clearTimeout(this.dlWaiting[k].timer); } catch (e) {}
        this.requested[k] = false;
      }
      this.dlWaiting = {};
      this.dlInflight = 0;
      // 還沒送出的也還原，之後正常瀏覽到才會重新請求
      for (let i = 0; i < this.dlQueue.length; i++) {
        const t = this.dlQueue[i];
        this.requested[`${t.z}_${t.x}_${t.y}`] = false;
      }
      this.dlQueue = [];
      this.ui = 'map';
      this._leaveOverlay();
      this.render();
    },
    doView() {
      this.ui = 'map';
      const at = this.activeTrack();
      if (at && at.bounds) {
        const c = this.centerOf(at);
        this.follow = false;
        this.viewLat = c.lat; this.viewLon = c.lon;
        this.z = 16;
      }
      this._leaveOverlay();
      this.render();
    },

    beginGeo() {
      this.geo = new Geolocation();
      this.geo.start();
      this.geo.onChange(() => {
        if (this.geo.getStatus() !== 'A') return;
        const lat = this.geo.getLatitude();
        const lon = this.geo.getLongitude();
        this.gpsLat = lat; this.gpsLon = lon; this.hasFix = true;
        // 拖曳中或在設定疊層時：只更新座標，不重畫地圖
        if (this._dragging || this.ui !== 'map') return;

        // 時間節流：依「更新頻率」設定，太頻繁就不重畫
        const now = Date.now();
        if (now - this._lastGpsRender < this.gpsInterval) return;
        // 移動節流：移動 < 約2公尺 不重畫（站著不動就不耗電重畫）
        const moved = Math.abs(lat - this._grLat) + Math.abs(lon - this._grLon);
        if (moved < 0.00002 && this._rendered) return;

        this._lastGpsRender = now;
        this._grLat = lat; this._grLon = lon; this._rendered = true;
        if (this.follow) { this.viewLat = lat; this.viewLon = lon; }
        this.render();
      });
    },

    // ---------- 實體按鍵：上=放大 / 下=縮小 / SELECT=回中 ----------
    setupKeys() {
      try {
        onKey({
          callback: (key, keyEvent) => {
            // 長按 SELECT/捷徑鍵：地圖→開設定；其他疊層→返回上一層
            if (keyEvent === KEY_EVENT_LONG_PRESS && (key === KEY_SELECT || key === KEY_SHORTCUT)) {
              if (this.ui === 'downloading') return true; // 下載中不打斷
              if (this.ui === 'map') this.openSettings(); else this.closeSettings();
              return true;
            }
            if (keyEvent !== KEY_EVENT_CLICK) return false;
            // 實體返回鍵：在疊層裡 = 回上一層；在地圖 = 交給系統（離開 App）
            if (key === KEY_BACK) {
              if (this.ui === 'map') return false;
              this._backOneLevel();
              return true;
            }
            if (this.ui !== 'map') return true; // 疊層（設定/管理/下載）：其他實體鍵點擊吃掉，用觸控捲動/操作
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
      else { const c = this.centerOf(this.activeTrack()); this.viewLat = c.lat; this.viewLon = c.lon; }
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
          // 真的開始拖（移動 > 3px）→ 把航跡線整層「刪掉」（CANVAS 不吃 setAlpha/平移，只能刪；放開後重畫）
          if (this._trackCv && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            try { deleteWidget(this._trackCv); } catch (err) {}
            this._trackCv = null;
          }
          for (let i = 0; i < this.mapLayer.length; i++) {
            const it = this.mapLayer[i];
            try { it.w.setProperty(prop.MORE, { x: it.bx + dx, y: it.by + dy }); } catch (err) {}
          }
        });
        w.addEventListener(event.CLICK_UP, () => {
          if (!this._dragging) return;
          this._dragging = false;
          const dx = this._lastDx, dy = this._lastDy;
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // 只是點一下：沒刪線，不用處理
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

    // ---------- 沿航跡預先下載圖磚（離線用）----------
    // 算出一條航跡(pts)經過的所有圖磚（每層往外帶 TRACK_DL_RING 圈鄰磚）
    buildTileSetFor(pts) {
      const set = {}; const out = [];
      if (!pts || pts.length < 2) return out;
      const CAP = 20000; // 安全上限：超長航跡別把記憶體吃爆（會害手錶重啟）
      for (let zi = 0; zi < TRACK_DL_ZOOMS.length; zi++) {
        const z = TRACK_DL_ZOOMS[zi];
        const ring = TRACK_DL_RING[z] != null ? TRACK_DL_RING[z] : 1;
        for (let i = 0; i < pts.length; i++) {
          const cx = Math.floor(lonToTileX(pts[i][1], z));
          const cy = Math.floor(latToTileY(pts[i][0], z));
          for (let ax = cx - ring; ax <= cx + ring; ax++) {
            for (let ay = cy - ring; ay <= cy + ring; ay++) {
              const k = `${z}_${ax}_${ay}`;
              if (!set[k]) { set[k] = 1; out.push({ z, x: ax, y: ay }); if (out.length >= CAP) return out; }
            }
          }
        }
      }
      return out;
    },
    buildTrackTileSet() { return this.buildTileSetFor(this._ptsOf(this.activeTrack())); },
    // 每條航跡的圖磚 key 集合（分類用；一塊磚算進「清單裡第一個涵蓋它」的航跡）；各條自己快取
    _getKeySets() {
      const out = [];
      for (let i = 0; i < this.tracks.length; i++) out.push({ id: this.tracks[i].id, name: this.tracks[i].name, keys: this._keysFor(this.tracks[i]) });
      return out;
    },

    startTrackDownload() {
      const all = this.buildTrackTileSet();
      // 過濾掉手錶已有的；其餘標記 requested，避免一般渲染重複請求
      // ⚠️ 只查記憶體 this.synced（開檔已 readdir 灌好），不要用 tileReady——它會對每張缺的圖磚 statSync，
      //    大航跡幾千張 → 幾千次同步磁碟呼叫塞爆 → 手錶 watchdog 重啟（就是「下載偶爾當機」的原因）
      this.dlQueue = all.filter((t) => {
        const k = `${t.z}_${t.x}_${t.y}`;
        if (this.synced[k]) return false;
        this.requested[k] = true;
        return true;
      });
      this.dlSetTotal = all.length;      // 整條航跡的總磚數（含已快取）
      this.dlTotal = this.dlQueue.length; // 這次實際要下載的張數
      this.dlDone = 0;
      this.dlInflight = 0;
      this.dlWaiting = {};
      this.dlSent = 0; this.dlPhoneOk = 0; this.dlArrived = 0; this.dlFail = 0; this.dlErr = '';
      this.dlStart = Date.now();
      this.dlActive = this.dlTotal > 0;
      this.render();
      if (this.dlActive) { this._keepAwake(true); this._dlPump(); }
    },

    // 下載期間讓螢幕保持亮著（手錶睡著會暫停 App→下載中斷），結束再還原
    _keepAwake(on) {
      if (on) {
        try { setPageBrightTime({ brightTime: 600000 }); } catch (e) {}
        try { pauseDropWristScreenOff({ duration: 0 }); } catch (e) {}
        try { pausePalmScreenOff({ duration: 0 }); } catch (e) {}
      } else {
        try { resetPageBrightTime(); } catch (e) {}
        try { resetDropWristScreenOff(); } catch (e) {}
        try { resetPalmScreenOff(); } catch (e) {}
      }
    },

    // 並發補槽：以「真的傳進手錶」為節奏，管線上最多 2 張
    _dlPump() {
      if (!this.dlActive) return;
      while (this.dlInflight < 2 && this.dlQueue.length > 0) {
        const t = this.dlQueue.shift();
        const k = `${t.z}_${t.x}_${t.y}`;
        this.dlInflight++;
        this.dlSent = (this.dlSent || 0) + 1; // 診斷：送出的請求數
        let timer = null;
        try { timer = setTimeout(() => { this._dlSettle(k, false); }, 60000); } catch (e) {}
        this.dlWaiting[k] = { timer };
        try {
          this.request({ method: 'tile', params: { z: t.z, x: t.x, y: t.y } })
            // 手機端回 ok = 手機下載+轉檔+丟藍牙佇列完成（還沒確定到錶）
            .then((r) => {
              if (r && r.ok) { this.dlPhoneOk = (this.dlPhoneOk || 0) + 1; }
              else { this.dlErr = (r && r.error) ? String(r.error).slice(0, 26) : 'no-ok'; this._dlSettle(k, false); }
            })
            .catch((e) => { this.dlErr = String(e).slice(0, 26); this._dlSettle(k, false); });
          // 成功不在這裡算進度：等檔案真的傳到手錶（onReceivedFile）才算
        } catch (e) { this.dlErr = 'throw'; this._dlSettle(k, false); }
      }
    },

    // 一張結束：arrived=true 確實進手錶；false=失敗/逾時
    _dlSettle(k, arrived) {
      const w = this.dlWaiting[k];
      if (!w) return; // 已結算過（避免重複計）
      try { if (w.timer) clearTimeout(w.timer); } catch (e) {}
      delete this.dlWaiting[k];
      this.dlInflight = Math.max(0, this.dlInflight - 1);
      this.dlDone++;
      if (arrived) { this.dlArrived = (this.dlArrived || 0) + 1; this.synced[k] = true; }
      else { this.dlFail = (this.dlFail || 0) + 1; this.requested[k] = false; } // 沒進來→放行，之後瀏覽到再自動補抓
      if (this.dlDone >= this.dlTotal) this.dlActive = false;
      // 還在下載就持續延長亮屏；下載完才放掉
      if (this.dlActive) { try { setPageBrightTime({ brightTime: 600000 }); } catch (e) {} }
      else { this._keepAwake(false); }
      if ((this.ui === 'downloading' || !this.dlActive) && !this._dragging) this.render();
      this._dlPump();
    },

    // ---------- 航跡線（打包的=黃、匯入的=橘）----------
    drawTrack(z, fx, fy) {
      if (!this.showTrack) return;
      const at = this.activeTrack(); // 只畫「選定的」那條
      const pts = this._ptsOf(at);   // 匯入航跡在這裡才解析座標（已快取）
      if (!pts || pts.length < 2) return;
      let cv;
      try { cv = createWidget(widget.CANVAS, { x: 0, y: 0, w: SCREEN, h: SCREEN }); } catch (e) { return; }
      this._drawPolyline(cv, pts, z, fx, fy, TRACK_COLOR);
      this.scene.push(cv);
      this._trackCv = cv;          // 存參考；拖曳第一次移動就刪掉這層、放開重畫
      this.attachDrag(cv, 0, 0);   // 接住手勢（不放 mapLayer、不被平移）；拖動時整層被刪、改由圖磚接續
    },

    // 把一條 [[lat,lon]...] 投影並畫成 ~3px 粗線
    _drawPolyline(cv, src, z, fx, fy, color) {
      const pts = [];
      for (let i = 0; i < src.length; i++) {
        const px = lonToTileX(src[i][1], z);
        const py = latToTileY(src[i][0], z);
        pts.push([Math.round(CENTER - (fx - px) * TILE_SIZE), Math.round(CENTER - (fy - py) * TILE_SIZE)]);
      }
      try {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          if ((a[0] < -40 && b[0] < -40) || (a[0] > SCREEN + 40 && b[0] > SCREEN + 40) ||
              (a[1] < -40 && b[1] < -40) || (a[1] > SCREEN + 40 && b[1] > SCREEN + 40)) continue;
          let dx = b[0] - a[0], dy = b[1] - a[1];
          const len = Math.sqrt(dx * dx + dy * dy);
          let nx = 0, ny = 0;
          if (len > 0.001) { nx = -dy / len; ny = dx / len; }
          for (let o = -1; o <= 1; o++) {
            cv.drawLine({
              x1: Math.round(a[0] + nx * o), y1: Math.round(a[1] + ny * o),
              x2: Math.round(b[0] + nx * o), y2: Math.round(b[1] + ny * o), color,
            });
          }
        }
      } catch (e) {}
    },

    // ---------- 匯入航跡（步驟1：從雲端抓 GPX → 手機解析 → 畫橘線）----------
    // url 空字串 = 用手機設定頁填的網址（side service 會去讀）
    importTrack(url, attempt) {
      attempt = attempt || 1;
      this._impStatus = attempt > 1 ? `連線中…重試 ${attempt}/5` : '匯入中…';
      this.render();
      // shake timeout = side service 還沒連上 → 隔 1.5 秒重試（最多 5 次）
      const retry = (why) => {
        if (attempt < 5) { try { setTimeout(() => this.importTrack(url, attempt + 1), 1500); } catch (e) { this._impStatus = why; this.render(); } }
        else { this._impStatus = why + '（連不上，請先在地圖等圖磚載入再試）'; this.render(); }
      };
      const isConn = (m) => m.indexOf('shake') >= 0 || m.indexOf('timeout') >= 0 || m.indexOf('connect') >= 0;
      try {
        this.request({ method: 'track', params: { url: url || '' } })
          .then((r) => {
            if (r && r.ok && r.pts) {
              const pts = this._parsePts(r.pts);
              if (pts.length >= 2) {
                const id = 'imp_' + Date.now();
                this.tracks.push({ id, name: r.name || '匯入航跡', pts, ptsRaw: r.pts, bounds: r.bounds });
                this.activeId = id; // 匯入後自動選定它
                this._keySetsVer++;
                this.saveImportedTracks();
                this.saveActiveId();
                this._impStatus = `成功：${pts.length} 點，已選定`;
              } else {
                this._impStatus = '解析到 0 點';
              }
            } else {
              this._impStatus = '失敗：' + ((r && r.error) ? String(r.error) : 'no-ok');
            }
            this.render();
          })
          .catch((e) => { const m = String(e); if (isConn(m)) retry('catch:' + m.slice(0, 40)); else { this._impStatus = 'catch:' + m.slice(0, 50); this.render(); } });
      } catch (e) {
        const m = String(e); if (isConn(m)) retry('throw:' + m.slice(0, 40)); else { this._impStatus = 'throw:' + m.slice(0, 50); this.render(); }
      }
    },
    _parsePts(s) {
      const out = [];
      if (!s) return out;
      const parts = s.split(';');
      for (let i = 0; i < parts.length; i++) {
        const c = parts[i].split(',');
        if (c.length === 2) {
          const la = parseFloat(c[0]), lo = parseFloat(c[1]);
          if (isFinite(la) && isFinite(lo)) out.push([la, lo]);
        }
      }
      return out;
    },

    // ---------- 下載進度疊層 ----------
    fmtDur(ms) {
      if (!ms || ms < 0 || !isFinite(ms)) ms = 0;
      const s = Math.round(ms / 1000);
      if (s < 60) return `約 ${s} 秒`;
      const m = Math.floor(s / 60), ss = s % 60;
      return `約 ${m} 分 ${ss < 10 ? '0' + ss : ss} 秒`;
    },

    dlBackButton(y) {
      this.scene.push(createWidget(widget.BUTTON, {
        x: 90, y, w: 300, h: 50, text: '回地圖', text_size: 24,
        normal_color: 0x7a3a1a, press_color: 0xaa5522, radius: 12,
        click_func: () => { this.exitDownloadView(); },
      }));
    },

    renderDownloading() {
      this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: SCREEN, color: 0x000000 }));
      const total = this.dlTotal || 0;
      const done = this.dlArrived || 0;    // 進度＝「真的進手錶」的張數（失敗不算）
      const processed = this.dlDone || 0;  // 已處理(含失敗)，用來判斷是否全部跑完
      const finished = !this.dlActive;
      const frac = total > 0 ? Math.min(1, done / total) : 1;

      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 54, w: SCREEN, h: 32, text: '下載沿線圖磚', text_size: 26, color: 0xffffff,
        align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));
      const cached = (this.dlSetTotal || total) - total;
      const _atn = this.activeTrack();
      const _tname = _atn ? _atn.name : '';
      this.scene.push(createWidget(widget.TEXT, {
        x: 30, y: 90, w: 420, h: 24,
        text: cached > 0 ? `${_tname}（已有 ${cached} 張）` : _tname,
        text_size: 19, color: 0x999999, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE,
      }));

      // 還在算航跡涵蓋哪些圖磚（大航跡要一兩秒）→ 先顯示，不要卡在上一頁
      if (this._dlPreparing) {
        this.scene.push(createWidget(widget.TEXT, {
          x: 20, y: 200, w: 440, h: 40, text: '計算沿線圖磚中…', text_size: 26, color: 0xffffff,
          align_h: align.CENTER_H, align_v: align.CENTER_V,
        }));
        return;
      }

      // 沒有要下載的（整條都已在手錶）
      if (total === 0) {
        this.scene.push(createWidget(widget.TEXT, {
          x: 20, y: 210, w: 440, h: 40, text: '圖磚都已在手錶', text_size: 26, color: 0x66dd99,
          align_h: align.CENTER_H, align_v: align.CENTER_V,
        }));
        this.dlBackButton(330);
        return;
      }

      // 百分比
      const pct = Math.round(frac * 100);
      const okAll = finished && done >= total;
      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 126, w: SCREEN, h: 56, text: `${pct}%`, text_size: 50,
        color: finished ? (okAll ? 0x66dd99 : 0xffaa55) : 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));

      // 進度條
      const BX = 70, BY = 206, BW = 340, BH = 26;
      this.scene.push(createWidget(widget.FILL_RECT, { x: BX, y: BY, w: BW, h: BH, radius: 13, color: 0x333333 }));
      const fw = Math.round(BW * frac);
      if (fw >= 4) {
        this.scene.push(createWidget(widget.FILL_RECT, {
          x: BX, y: BY, w: fw, h: BH, radius: Math.min(13, Math.floor(fw / 2)),
          color: finished ? (okAll ? 0x1a9a4a : 0x8a5a22) : 0x1166cc,
        }));
      }

      // 張數（已進手錶 / 需下載）
      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 244, w: SCREEN, h: 26, text: `已同步 ${done} / ${total} 張`, text_size: 22, color: 0xdddddd,
        align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));

      // ETA / 狀態
      let line2 = '';
      if (finished) {
        if (okAll) line2 = '完成！已存入手錶';
        else if (processed >= total) line2 = `結束：${done} 進手錶 · ${this.dlFail || 0} 失敗`;
        else line2 = `已停止（${done} 進手錶）`;
      } else if (done <= 0) {
        line2 = '同步中…（等圖磚進手錶）';
      } else {
        const elapsed = Date.now() - (this.dlStart || Date.now());
        line2 = `預估剩餘 ${this.fmtDur((total - done) * (elapsed / done))}`;
      }
      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 278, w: SCREEN, h: 26, text: line2, text_size: 20, color: 0xbbbbbb,
        align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));

      // 診斷：送=發出請求 / 機=手機下載好 / 錶=真的進手錶 / 敗=失敗
      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 300, w: SCREEN, h: 22, text: `送${this.dlSent || 0} 機${this.dlPhoneOk || 0} 錶${this.dlArrived || 0} 敗${this.dlFail || 0}`,
        text_size: 16, color: 0x888888, align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));
      if (this.dlErr) {
        this.scene.push(createWidget(widget.TEXT, {
          x: 16, y: 322, w: 448, h: 20, text: 'err:' + this.dlErr, text_size: 14, color: 0x886666,
          align_h: align.CENTER_H, align_v: align.CENTER_V,
        }));
      }

      // 按鈕（下移避開診斷列）
      if (finished) {
        this.dlBackButton(352);
      } else {
        this.scene.push(createWidget(widget.BUTTON, {
          x: 40, y: 334, w: 400, h: 62, text: '回地圖（繼續下載）', text_size: 24,
          normal_color: 0x1166cc, press_color: 0x1188ff, radius: 16,
          click_func: () => { this.exitDownloadView(); },
        }));
        this.scene.push(createWidget(widget.BUTTON, {
          x: 70, y: 404, w: 340, h: 62, text: '停止下載', text_size: 24,
          normal_color: 0x7a2a2a, press_color: 0xaa3333, radius: 16,
          click_func: () => { this.stopDownload(); },
        }));
      }
    },

    // ---------- 設定疊層繪製（原生觸控捲動）----------
    renderSettings() {
      const BTM = 828; // 黑底高度＝可捲動高度（多留空間讓底部按鈕能捲到圓形螢幕中段）
      this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: BTM, color: 0x000000 }));
      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 18, w: SCREEN, h: 34, text: '設定', text_size: 30, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V }));

      // 更新頻率
      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 58, w: SCREEN, h: 24, text: '更新頻率（越低越省電）', text_size: 19, color: 0xbbbbbb, align_h: align.CENTER_H, align_v: align.CENTER_V }));
      const xs = [56, 192, 328];
      for (let i = 0; i < FREQ_OPTS.length; i++) {
        const o = FREQ_OPTS[i];
        const sel = this.gpsInterval === o.value;
        this.scene.push(createWidget(widget.BUTTON, { x: xs[i], y: 86, w: 100, h: 78, text: o.label, text_size: 34, normal_color: sel ? 0x1166cc : 0x333333, press_color: 0x1188ff, radius: 16, click_func: () => { this.setFreq(o.value); } }));
        this.scene.push(createWidget(widget.TEXT, { x: xs[i], y: 166, w: 100, h: 20, text: o.sub, text_size: 15, color: sel ? 0x66bbff : 0x999999, align_h: align.CENTER_H, align_v: align.CENTER_V }));
      }

      // 航跡（顯示目前選定的那條）
      const _atn = this.activeTrack();
      this.scene.push(createWidget(widget.TEXT, { x: 30, y: 196, w: 420, h: 24, text: _atn ? `航跡：${_atn.name}` : '航跡（無）', text_size: 19, color: 0xbbbbbb, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE }));
      if (_atn) {
        this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 224, w: 380, h: 72, text: this.showTrack ? '顯示航跡：開' : '顯示航跡：關', text_size: 26, normal_color: this.showTrack ? 0x1a7a3a : 0x333333, press_color: 0x1188ff, radius: 16, click_func: () => { this.toggleTrackVis(); } }));
        this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 304, w: 380, h: 72, text: '下載沿線圖磚', text_size: 26, normal_color: 0x1166cc, press_color: 0x1188ff, radius: 16, click_func: () => { this.doDownload(); } }));
        this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 384, w: 380, h: 72, text: '移到航跡', text_size: 26, normal_color: 0x444444, press_color: 0x666666, radius: 16, click_func: () => { this.doView(); } }));
      }

      // 管理
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 464, w: 380, h: 72, text: '管理已下載圖磚', text_size: 25, normal_color: 0x3a5a7a, press_color: 0x4a7aaa, radius: 16, click_func: () => { this.openTiles(); } }));
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 544, w: 380, h: 72, text: '管理已下載航跡', text_size: 25, normal_color: 0x3a5a7a, press_color: 0x4a7aaa, radius: 16, click_func: () => { this.openTracks(); } }));

      // 返回地圖
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 624, w: 380, h: 70, text: '返回地圖', text_size: 25, normal_color: 0x7a3a1a, press_color: 0xaa5522, radius: 16, click_func: () => { this.closeSettings(); } }));
    },

    // ---------- 管理已下載航跡（佔位，功能之後再做）----------
    _trackById(id) { for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].id === id) return this.tracks[i]; return null; },

    renderTracks() {
      // 刪除航跡確認
      if (this._pendingTrackDel) {
        const t = this._trackById(this._pendingTrackDel);
        this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: SCREEN, color: 0x000000 }));
        this.scene.push(createWidget(widget.TEXT, { x: 0, y: 88, w: SCREEN, h: 34, text: '刪除這條航跡？', text_size: 27, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V }));
        this.scene.push(createWidget(widget.TEXT, { x: 30, y: 142, w: 420, h: 32, text: t ? t.name : '', text_size: 23, color: 0xffcc66, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE }));
        this.scene.push(createWidget(widget.TEXT, { x: 26, y: 180, w: 428, h: 40, text: '（它下載的圖磚可到「管理已下載圖磚」另外刪）', text_size: 15, color: 0x999999, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.WRAP }));
        this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 240, w: 380, h: 66, text: '確定刪除', text_size: 25, normal_color: 0x9a2a2a, press_color: 0xcc4444, radius: 16, click_func: () => { this.deleteTrack(this._pendingTrackDel); } }));
        this.scene.push(createWidget(widget.BUTTON, { x: 110, y: 318, w: 260, h: 60, text: '取消', text_size: 24, normal_color: 0x444444, press_color: 0x666666, radius: 16, click_func: () => { this._pendingTrackDel = null; this.render(); } }));
        return;
      }

      const list = this.tracks || [];
      const ROW = 64, GAP = 14, TOP = 130;
      const afterList = TOP + list.length * (ROW + GAP) + 8;
      const btm = Math.max(SCREEN, afterList + 80 + 72 + 60 + 150);
      this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: btm, color: 0x000000 }));
      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 34, w: SCREEN, h: 32, text: '航跡（點一下選定）', text_size: 25, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V }));
      this.scene.push(createWidget(widget.TEXT, { x: 20, y: 74, w: 440, h: 44, text: this._impStatus || '黃線＝目前選定的航跡', text_size: 16, color: this._impStatus ? 0x88bbff : 0x777777, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.WRAP }));

      let y = TOP;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const sel = t.id === this.activeId;
        this.scene.push(createWidget(widget.BUTTON, {
          x: 40, y, w: t.builtin ? 400 : 300, h: ROW, text: (sel ? '● ' : '') + t.name, text_size: 22,
          normal_color: sel ? 0x1a7a3a : 0x333333, press_color: 0x1188ff, radius: 14, click_func: () => { this.setActive(t.id); },
        }));
        if (!t.builtin) {
          this.scene.push(createWidget(widget.BUTTON, {
            x: 350, y, w: 90, h: ROW, text: '刪', text_size: 24, normal_color: 0x7a2a2a, press_color: 0xaa3333, radius: 14,
            click_func: () => { this._pendingTrackDel = t.id; this.render(); },
          }));
        }
        y += ROW + GAP;
      }

      y += 8;
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y, w: 380, h: 68, text: '匯入手機設定的網址', text_size: 23, normal_color: 0x1166cc, press_color: 0x1188ff, radius: 16, click_func: () => { this.importTrack(''); } }));
      y += 80;
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y, w: 380, h: 56, text: '匯入測試航跡（內建連結）', text_size: 20, normal_color: 0x335577, press_color: 0x4477aa, radius: 16, click_func: () => { this.importTrack(TEST_TRACK_URL); } }));
      y += 72;
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y, w: 380, h: 60, text: '返回', text_size: 24, normal_color: 0x444444, press_color: 0x666666, radius: 16, click_func: () => { this.openSettings(); } }));
    },

    // ---------- 管理已下載圖磚（原生觸控捲動）----------
    renderTiles() {
      // 刪除確認（單頁）
      if (this._pendingDelete) {
        const pd = this._pendingDelete;
        this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: SCREEN, color: 0x000000 }));
        this.scene.push(createWidget(widget.TEXT, { x: 0, y: 84, w: SCREEN, h: 34, text: '確定刪除？', text_size: 28, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V }));
        this.scene.push(createWidget(widget.TEXT, { x: 30, y: 138, w: 420, h: 32, text: `${pd.label}　${pd.count} 張`, text_size: 24, color: 0xffcc66, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE }));
        this.scene.push(createWidget(widget.TEXT, { x: 20, y: 176, w: 440, h: 26, text: `${this.mb(pd.bytes)} MB · 刪了可重新下載`, text_size: 18, color: 0x999999, align_h: align.CENTER_H, align_v: align.CENTER_V }));
        this.scene.push(createWidget(widget.BUTTON, { x: 50, y: 226, w: 380, h: 72, text: '確定刪除', text_size: 27, normal_color: 0x9a2a2a, press_color: 0xcc4444, radius: 16, click_func: () => { this.confirmDelete(); } }));
        this.scene.push(createWidget(widget.BUTTON, { x: 100, y: 312, w: 280, h: 64, text: '取消', text_size: 25, normal_color: 0x444444, press_color: 0x666666, radius: 16, click_func: () => { this.cancelDelete(); } }));
        return;
      }

      // ---- 類別詳細頁（點某類別才進來；這裡才掃實際大小）----
      if (this._tileCat) { this.renderTileDetail(); return; }

      // ---- 入口：列出航跡 + GPS 當選項（不掃描、不顯示張數 → 秒開）----
      const list = this.tracks || [];
      const ROW = 76;
      const retY = 118 + (list.length + 1) * ROW + 10;
      const btm = Math.max(SCREEN, retY + 64 + 150);
      this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: btm, color: 0x000000 }));

      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 30, w: SCREEN, h: 32, text: '管理已下載圖磚', text_size: 26, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V }));
      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 70, w: SCREEN, h: 24, text: '點類別看大小 / 刪除', text_size: 16, color: 0x888888, align_h: align.CENTER_H, align_v: align.CENTER_V }));

      let y = 118;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        this.scene.push(createWidget(widget.BUTTON, { x: 40, y, w: 400, h: 64, text: t.name, text_size: 23, normal_color: 0x333333, press_color: 0x1166cc, radius: 14, click_func: () => { this.openTileDetail(t.id); } }));
        y += ROW;
      }
      this.scene.push(createWidget(widget.BUTTON, { x: 40, y, w: 400, h: 64, text: 'GPS·瀏覽', text_size: 23, normal_color: 0x333333, press_color: 0x1166cc, radius: 14, click_func: () => { this.openTileDetail('gps'); } }));
      y += ROW + 4;
      this.scene.push(createWidget(widget.BUTTON, { x: 50, y, w: 380, h: 64, text: '返回', text_size: 24, normal_color: 0x444444, press_color: 0x666666, radius: 16, click_func: () => { this.openSettings(); } }));
    },

    // 類別詳細頁：實際張數+大小（進來時才 statSync）＋ 刪除 ＋ 返回（回類別清單）
    renderTileDetail() {
      const d = this._tileDetail || { name: '', count: 0, bytes: 0 };
      this.scene.push(createWidget(widget.FILL_RECT, { x: 0, y: 0, w: SCREEN, h: SCREEN, color: 0x000000 }));
      this.scene.push(createWidget(widget.TEXT, { x: 30, y: 70, w: 420, h: 36, text: d.name, text_size: 26, color: 0xffe600, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE }));
      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 134, w: SCREEN, h: 42, text: `${d.count} 張`, text_size: 36, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V }));
      this.scene.push(createWidget(widget.TEXT, { x: 0, y: 184, w: SCREEN, h: 30, text: `${this.mb(d.bytes)} MB`, text_size: 22, color: 0xbbbbbb, align_h: align.CENTER_H, align_v: align.CENTER_V }));

      this.scene.push(createWidget(widget.BUTTON, {
        x: 50, y: 246, w: 380, h: 70, text: '刪除這些圖磚', text_size: 25,
        normal_color: d.count > 0 ? 0x9a2a2a : 0x2a2a2a, press_color: 0xcc4444, radius: 16,
        click_func: () => { if (d.count > 0) { this._pendingDelete = { kind: this._tileCat, count: d.count, label: d.name, bytes: d.bytes }; this.render(); } },
      }));
      this.scene.push(createWidget(widget.BUTTON, {
        x: 50, y: 328, w: 380, h: 62, text: '返回', text_size: 24, normal_color: 0x444444, press_color: 0x666666, radius: 16,
        click_func: () => { this._tileCat = null; this._tileDetail = null; this.render(); },
      }));
    },

    // ---------- 繪製 ----------
    clearScene() {
      this.scene.forEach((w) => { try { deleteWidget(w); } catch (e) {} });
      this.scene = [];
      this.mapLayer = [];
      this._trackCv = null;
    },

    render() {
      this._lastRenderTs = Date.now();
      if (this._firstPaintMs == null && this._t0) this._firstPaintMs = Date.now() - this._t0; // 第一次重畫＝畫面建好
      this.clearScene();
      if (this.ui === 'settings') { this.renderSettings(); return; }
      if (this.ui === 'downloading') { this.renderDownloading(); return; }
      if (this.ui === 'tiles') { this.renderTiles(); return; }
      if (this.ui === 'tracks') { this.renderTracks(); return; }
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
          // 開檔還沒掃完已下載清單：先全灰，不查檔案、不請求（避免卡，也避免誤判沒下載而重抓）
          if (!this._tilesScanned) {
            try {
              const ph0 = createWidget(widget.FILL_RECT, { x: sx, y: sy, w: TILE_SIZE, h: TILE_SIZE, color: 0x666666 });
              this.scene.push(ph0);
              this.mapLayer.push({ w: ph0, bx: sx, by: sy });
              this.attachDrag(ph0, sx, sy);
            } catch (e) {}
            continue;
          }
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

      // 航跡黃線（在圖磚之上、紅點之下）；第一張畫面（還沒掃圖）先不畫，避免解析大航跡卡開檔
      if (this._tilesScanned) this.drawTrack(z, fx, fy);

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
      const status = this.dlActive
        ? `z${z}  航跡下載 ${this.dlDone}/${this.dlTotal}…`
        : this.pending > 0
        ? `z${z}  同步中 ${this.pending} 張…`
        : !this.hasFix
        ? `z${z}  定位中…`
        : `z${z}  ${this.gpsLat.toFixed(5)}, ${this.gpsLon.toFixed(5)}`;
      this.scene.push(createWidget(widget.TEXT, {
        x: 0, y: 44, w: SCREEN, h: 26, text: status, text_size: 20, color: 0x333333,
        align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));

      // ── 暫時診斷：開檔耗時（確認 5 秒卡在哪）。量到數字後我再移除這行 ──
      try {
        this.scene.push(createWidget(widget.TEXT, {
          x: 0, y: 70, w: SCREEN, h: 22,
          text: `啟動 ${this._firstPaintMs == null ? '…' : this._firstPaintMs + 'ms'} · 掃圖 ${this._scanMs == null ? '…' : this._scanMs + 'ms'}`,
          text_size: 18, color: 0x0088dd, align_h: align.CENTER_H, align_v: align.CENTER_V,
        }));
      } catch (e) {}


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

      // 下載進行中才出現：在地圖上直接停止（山上誤觸下載時可立刻關掉）
      if (this.dlActive) {
        this.scene.push(createWidget(widget.BUTTON, {
          x: 60, y: 100, w: 360, h: 58, text: '■ 停止下載圖磚', text_size: 24,
          normal_color: 0xaa2222, press_color: 0xdd4444, radius: 16,
          click_func: () => { this.stopDownload(); this.render(); },
        }));
      }
    },

    onDestroy() {
      if (this.geo) this.geo.stop();
      this._keepAwake(false); // 還原亮屏設定（保險）
    },
  })
);
