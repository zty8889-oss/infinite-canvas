const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// 已提供设计好的图标（desktop/icon.ico）时直接复用，不再用代码临时绘制
const packagedIcon = path.join(__dirname, "icon.ico");
try {
  if (fs.existsSync(packagedIcon) && fs.statSync(packagedIcon).size > 2048) {
    process.exit(0);
  }
} catch {}

const size = 256;
const pixels = Buffer.alloc(size * size * 4);

function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  const a = alpha / 255;
  pixels[i] = Math.round(color[0] * a + pixels[i] * (1 - a));
  pixels[i + 1] = Math.round(color[1] * a + pixels[i + 1] * (1 - a));
  pixels[i + 2] = Math.round(color[2] * a + pixels[i + 2] * (1 - a));
  pixels[i + 3] = 255;
}

function roundRect(x, y, w, h, radius, color) {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
    const cx = Math.max(x + radius - px, 0, px - (x + w - radius - 1));
    const cy = Math.max(y + radius - py, 0, py - (y + h - radius - 1));
    if (cx * cx + cy * cy <= radius * radius) blend(px, py, color, 255);
  }
}

function line(x1, y1, x2, y2, width, color) {
  const left = Math.floor(Math.min(x1, x2) - width);
  const right = Math.ceil(Math.max(x1, x2) + width);
  const top = Math.floor(Math.min(y1, y2) - width);
  const bottom = Math.ceil(Math.max(y1, y2) + width);
  const dx = x2 - x1, dy = y2 - y1, length = dx * dx + dy * dy;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length));
    const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
    if (d <= width / 2) blend(x, y, color, 255);
  }
}

function circle(cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) blend(x, y, color, 255);
  }
}

roundRect(12, 12, 232, 232, 58, [8, 17, 26]);
roundRect(21, 21, 214, 214, 50, [14, 31, 43]);

const cyan = [72, 226, 255];
const blue = [100, 173, 255];
const nodes = [[79, 78], [177, 78], [128, 177]];
line(nodes[0][0], nodes[0][1], nodes[1][0], nodes[1][1], 9, cyan);
line(nodes[0][0], nodes[0][1], nodes[2][0], nodes[2][1], 9, blue);
line(nodes[1][0], nodes[1][1], nodes[2][0], nodes[2][1], 9, cyan);
for (const [x, y] of nodes) {
  circle(x, y, 28, [91, 215, 245]);
  circle(x, y, 20, [14, 31, 43]);
  circle(x, y, 8, [240, 252, 255]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
header[8] = 8; header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", header),
  pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  pngChunk("IEND", Buffer.alloc(0))
]);

const iconHeader = Buffer.alloc(6);
iconHeader.writeUInt16LE(0, 0); iconHeader.writeUInt16LE(1, 2); iconHeader.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0;
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
fs.mkdirSync(__dirname, { recursive: true });
fs.writeFileSync(path.join(__dirname, "icon.ico"), Buffer.concat([iconHeader, entry, png]));
