// =============================================================
//  Web Mercator 圖磚數學（跟下載器、跟 happyman 的 XYZ 一致）
//  經緯度 <-> 圖磚座標(含小數，方便算螢幕偏移)
// =============================================================
export const TILE_SIZE = 256;

// 經度 -> 圖磚 X（含小數）
export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

// 緯度 -> 圖磚 Y（含小數）
export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}

// 反向：圖磚 X（含小數）-> 經度
export function tileXToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

// 反向：圖磚 Y（含小數）-> 緯度
export function tileYToLat(y, z) {
  const n = Math.PI * (1 - (2 * y) / Math.pow(2, z));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}
