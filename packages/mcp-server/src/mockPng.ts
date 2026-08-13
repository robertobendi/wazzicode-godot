import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";

/**
 * Generates a small, valid PNG so mock screenshots are real images Claude can view.
 * Renders a labeled solid-color rectangle with a simple checkerboard so the image isn't blank.
 */
export function makeMockPng(
  width: number,
  height: number,
  rgb: [number, number, number],
  label: string
): { pngBase64: string; width: number; height: number } {
  const w = Math.max(8, Math.floor(width));
  const h = Math.max(8, Math.floor(height));
  // Raw RGB rows, each row prefixed with a filter-type byte (0 = None).
  const rowSize = w * 3 + 1;
  const raw = Buffer.alloc(rowSize * h);
  const tile = 8;
  for (let y = 0; y < h; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < w; x++) {
      const dim = ((Math.floor(x / tile) + Math.floor(y / tile)) & 1) === 1;
      const r = rgb[0] * (dim ? 0.78 : 1);
      const g = rgb[1] * (dim ? 0.78 : 1);
      const b = rgb[2] * (dim ? 0.78 : 1);
      const o = y * rowSize + 1 + x * 3;
      raw[o] = clamp(r);
      raw[o + 1] = clamp(g);
      raw[o + 2] = clamp(b);
    }
  }
  // Crude pixel "label" so mock output has identifying glyphs at top-left.
  drawText(raw, rowSize, w, h, label, 4, 4);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk(
    "IHDR",
    Buffer.concat([
      u32(w),
      u32(h),
      Buffer.from([8, 2, 0, 0, 0]), // bitDepth=8, color=RGB, compression=0, filter=0, interlace=0
    ])
  );
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));
  const png = Buffer.concat([sig, ihdr, idat, iend]);
  return { pngBase64: png.toString("base64"), width: w, height: h };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = u32(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = u32(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n >>> 0;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Tiny 5x7 ASCII font for mock labels — enough to render "MOCK GAME" etc. */
const FONT5x7: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00000", "00000", "00000", "00100", "00000"],
};

function drawText(
  raw: Buffer,
  rowSize: number,
  w: number,
  h: number,
  text: string,
  startX: number,
  startY: number
): void {
  let x = startX;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT5x7[ch] ?? FONT5x7[" "];
    for (let gy = 0; gy < 7; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] !== "1") continue;
        const px = x + gx;
        const py = startY + gy;
        if (px >= w || py >= h) continue;
        const o = py * rowSize + 1 + px * 3;
        raw[o] = 240;
        raw[o + 1] = 240;
        raw[o + 2] = 240;
      }
    }
    x += 6;
    if (x + 5 >= w) break;
  }
}
