// 生成 1024x1024 应用图标：深色圆角底 + 绿/橙/红三根递增柱条（用量状态语义）。
// 纯 Node 实现（zlib + 手写 PNG 编码），2x 超采样抗锯齿。
import zlib from 'node:zlib';
import fs from 'node:fs';

const S = 2048; // 超采样画布
const OUT = 1024;

// 设计 tokens（与前端主题色系一致）
const BG_TOP = [30, 41, 59];    // slate-800
const BG_BOTTOM = [15, 23, 42]; // slate-900
const BARS = [
  { color: [16, 185, 129], h: 0.38 }, // emerald-500
  { color: [245, 158, 11], h: 0.58 }, // amber-500
  { color: [239, 68, 68], h: 0.82 },  // red-500
];

const R = S * 0.185; // 圆角半径
const pad = S * 0.26;
const barW = S * 0.13;
const gap = S * 0.055;
const baseY = S - pad;
const topY = pad + S * 0.02;

const buf = Buffer.alloc(S * S * 4);

const blend = (x, y, c, a) => {
  const i = (y * S + x) * 4;
  const ia = 1 - a;
  buf[i] = Math.round(c[0] * a + buf[i] * ia);
  buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * ia);
  buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * ia);
  buf[i + 3] = Math.min(255, buf[i + 3] + Math.round(a * 255));
};

// 圆角矩形内判定
const insideRounded = (x, y) => {
  const min = 0, max = S - 1;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.min(Math.max(x, R), S - 1 - R);
  const cy = Math.min(Math.max(y, R), S - 1 - R);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (insideRounded(x, y)) {
      const t = y / S;
      buf[i] = Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t);
      buf[i + 1] = Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t);
      buf[i + 2] = Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t);
      buf[i + 3] = 255;
    }
  }
}

// 三根圆角柱条
BARS.forEach((bar, idx) => {
  const x0 = pad + idx * (barW + gap);
  const x1 = x0 + barW;
  const hPx = (baseY - topY) * bar.h;
  const y0 = baseY - hPx;
  const r = Math.min(barW / 2, S * 0.03);
  for (let y = Math.floor(y0); y <= Math.ceil(baseY); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), baseY - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) blend(x, y, bar.color, 1);
    }
  }
});

// 2x 下采样到 1024
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    const sy = y * 2, sx = x * 2;
    const i = (y * OUT + x) * 4;
    for (let c = 0; c < 4; c++) {
      out[i + c] = Math.round(
        (buf[(sy * S + sx) * 4 + c] + buf[(sy * S + sx + 1) * 4 + c] +
         buf[((sy + 1) * S + sx) * 4 + c] + buf[((sy + 1) * S + sx + 1) * 4 + c]) / 4
      );
    }
  }
}

// PNG 编码
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('app-icon.png', png);
console.log('app-icon.png written:', png.length, 'bytes');
