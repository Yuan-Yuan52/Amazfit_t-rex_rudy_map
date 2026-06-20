// =============================================================
//  設定頁（長按回中鍵進入）
//  目前：畫面更新頻率（省電用）。之後可加：航跡匯入、預先下載、圖層…
// =============================================================
import { createWidget, deleteWidget, widget, align } from '@zos/ui';
import { localStorage } from '@zos/storage';

const OPTIONS = [
  { label: '高', sub: '即時', value: 1000 },
  { label: '中', sub: '3 秒', value: 3000 },
  { label: '低', sub: '6 秒·省電', value: 6000 },
];

Page({
  build() {
    this.scene = [];
    this.current = this.load();
    this.render();
  },

  load() {
    try {
      const v = parseInt(localStorage.getItem('gpsInterval', '1000'), 10);
      return v && v > 0 ? v : 1000;
    } catch (e) { return 1000; }
  },

  clear() {
    this.scene.forEach((w) => { try { deleteWidget(w); } catch (e) {} });
    this.scene = [];
  },

  render() {
    this.clear();
    this.scene.push(createWidget(widget.TEXT, {
      x: 0, y: 34, w: 480, h: 40, text: '設定', text_size: 34, color: 0xffffff,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    }));
    this.scene.push(createWidget(widget.TEXT, {
      x: 0, y: 92, w: 480, h: 30, text: '畫面更新頻率', text_size: 24, color: 0xcccccc,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    }));
    this.scene.push(createWidget(widget.TEXT, {
      x: 30, y: 126, w: 420, h: 26, text: '越低越省電（定位仍即時）', text_size: 18, color: 0x999999,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    }));

    const xs = [50, 190, 330];
    for (let i = 0; i < OPTIONS.length; i++) {
      const o = OPTIONS[i];
      const sel = this.current === o.value;
      this.scene.push(createWidget(widget.BUTTON, {
        x: xs[i], y: 186, w: 100, h: 100, text: o.label, text_size: 36,
        normal_color: sel ? 0x1166cc : 0x333333, press_color: 0x1188ff, radius: 16,
        click_func: () => { this.select(o.value); },
      }));
      this.scene.push(createWidget(widget.TEXT, {
        x: xs[i], y: 292, w: 100, h: 24, text: o.sub, text_size: 18,
        color: sel ? 0x66bbff : 0x999999, align_h: align.CENTER_H, align_v: align.CENTER_V,
      }));
    }

    this.scene.push(createWidget(widget.TEXT, {
      x: 0, y: 404, w: 480, h: 30, text: '按返回鍵離開', text_size: 20, color: 0x888888,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    }));
  },

  select(v) {
    try { localStorage.setItem('gpsInterval', String(v)); } catch (e) {}
    this.current = v;
    this.render();
  },
});
