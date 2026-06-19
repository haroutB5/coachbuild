import zlib from "zlib";
import fs from "fs";

// CRC32 table
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const cx = size / 2, cy = size / 2;
  const r = size * 0.34;            // diamond "radius"
  const ring = size * 0.40;
  // colors
  const bg = [10, 14, 20];          // #0a0e14
  const teal = [45, 212, 191];      // #2dd4bf
  const tealDim = [29, 156, 140];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy); // diamond metric
      let col;
      if (d < r * 0.62) col = teal;
      else if (d < r) col = tealDim;
      else if (d < ring) col = [16, 28, 38];
      else col = bg;
      raw[p++] = col[0]; raw[p++] = col[1]; raw[p++] = col[2]; raw[p++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync("public/icon-192.png", png(192));
fs.writeFileSync("public/icon-512.png", png(512));
console.log("wrote icon-192.png", fs.statSync("public/icon-192.png").size, "bytes");
console.log("wrote icon-512.png", fs.statSync("public/icon-512.png").size, "bytes");
