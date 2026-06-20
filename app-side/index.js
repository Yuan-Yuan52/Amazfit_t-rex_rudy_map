// =============================================================
//  手機端 Side Service：下載圖磚 → 轉檔 → 傳到手錶 data://
//  手錶 device app 透過 this.request({method:'tile', params:{z,x,y}}) 觸發
//  傳完的檔會落在手錶的 data://download/t_{z}_{x}_{y}.png
// =============================================================
import { BaseSideService } from '@zeppos/zml/base-side';
import { convertLib } from '@zeppos/zml/base-side';

const LAYER = 'moi_osm'; // happyman 圖層
const URL = (z, x, y) => `https://tile.happyman.idv.tw/map/${LAYER}/${z}/${x}/${y}.png`;

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
      res(null, { ok: false, error: 'unknown method' });
    },
  })
);
