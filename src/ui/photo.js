// 写真の縮小・サムネイル生成。iPhone の 12MP 写真（数MB）を長辺1600px・JPEG に縮小して保存容量と表示速度を確保する。

const MAX_MAIN = 1600;
const MAX_THUMB = 320;

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* フォールバック */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の変換に失敗しました'))), 'image/jpeg', quality));
}

async function render(src, w0, h0, max, quality, square = false) {
  let sx = 0,
    sy = 0,
    sw = w0,
    sh = h0;
  if (square) {
    const s = Math.min(w0, h0);
    sx = (w0 - s) / 2;
    sy = (h0 - s) / 2;
    sw = sh = s;
  }
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const blob = await canvasToBlob(c, quality);
  c.width = c.height = 0; // iOS のキャンバスメモリ解放
  return { blob, w, h };
}

/** File → 保存用 {data, thumb, type, width, height} */
export async function processImageFile(file) {
  if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) throw new Error('画像ファイルを選択してください');
  let bmp;
  try {
    bmp = await loadBitmap(file);
  } catch {
    throw new Error('画像を読み込めませんでした（この形式に未対応の可能性があります）');
  }
  const w0 = bmp.width;
  const h0 = bmp.height;
  const main = await render(bmp, w0, h0, MAX_MAIN, 0.84);
  const thumb = await render(bmp, w0, h0, MAX_THUMB, 0.78, true);
  bmp.close?.();
  return { data: await main.blob.arrayBuffer(), thumb: await thumb.blob.arrayBuffer(), type: 'image/jpeg', width: main.w, height: main.h };
}

/** サンプル用の写真をキャンバスで生成（絵文字＋柔らかい背景） */
export async function makeSamplePhoto(emoji, hue, variant = 0) {
  const W = 960,
    H = 720;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  const l1 = [92, 88, 85][variant % 3];
  g.addColorStop(0, `hsl(${hue} 55% ${l1}%)`);
  g.addColorStop(1, `hsl(${(hue + 25) % 360} 45% ${l1 - 12}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 台の影
  ctx.fillStyle = `hsla(${hue} 30% 20% / 0.10)`;
  ctx.beginPath();
  ctx.ellipse(W / 2, H * 0.78, W * 0.26, H * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(W / 2, H / 2 - 10);
  ctx.rotate([0, -0.12, 0.1][variant % 3]);
  ctx.font = `${[330, 300, 280][variant % 3]}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 0, 0);
  ctx.restore();
  const main = await canvasToBlob(c, 0.82);
  const t = document.createElement('canvas');
  t.width = t.height = MAX_THUMB;
  t.getContext('2d').drawImage(c, (W - H) / 2, 0, H, H, 0, 0, MAX_THUMB, MAX_THUMB);
  const thumb = await canvasToBlob(t, 0.8);
  return { data: await main.arrayBuffer(), thumb: await thumb.arrayBuffer(), type: 'image/jpeg', width: W, height: H };
}
