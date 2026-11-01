// Just enough PNG to read a size and strip alpha, with no dependencies: both stores reject an
// alpha channel, even a fully opaque one, and this runs on macOS and Linux alike.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

const readChunks = (file: Buffer): Chunk[] => {
  if (file.length < 8 || !file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const chunks: Chunk[] = [];
  for (let at = 8; at + 8 <= file.length; ) {
    const length = file.readUInt32BE(at);
    chunks.push({ type: file.toString("latin1", at + 4, at + 8), data: file.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
};

const encodeChunk = ({ type, data }: Chunk): Buffer => {
  const name = Buffer.from(type, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
};

export interface PngInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
}

export const pngInfo = (file: Buffer): PngInfo => {
  const chunks = readChunks(file);
  const ihdr = chunks[0];
  if (ihdr?.type !== "IHDR") throw new Error("PNG has no header");
  const colorType = ihdr.data[9];
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4), hasAlpha: colorType === 4 || colorType === 6 || chunks.some((c) => c.type === "tRNS") };
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const unfilter = (raw: Buffer, stride: number, height: number, bytes: number): Buffer => {
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    const at = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytes ? out[at + x - bytes] : 0;
      const up = y > 0 ? out[at + x - stride] : 0;
      const upLeft = y > 0 && x >= bytes ? out[at + x - stride - bytes] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      out[at + x] = raw[row + x] + predictor;
    }
  }
  return out;
};

// Returns the file unchanged when it has no alpha; otherwise flattens it onto white as 8-bit RGB.
export const stripAlpha = (file: Buffer): Buffer => {
  const chunks = readChunks(file);
  const { width, height, hasAlpha } = pngInfo(file);
  if (!hasAlpha) return file;
  const header = chunks[0].data;
  const [depth, colorType, interlace] = [header[8], header[9], header[12]];
  if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2 && colorType !== 3)) {
    throw new Error(`cannot strip alpha from a PNG with bit depth ${depth}, color type ${colorType}, interlace ${interlace}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const compressed = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const pixels = unfilter(inflateSync(compressed), width * channels, height, channels);
  const palette = chunks.find((c) => c.type === "PLTE")?.data;
  const transparency = chunks.find((c) => c.type === "tRNS")?.data;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * channels;
      const to = y * (width * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        let value: number;
        let alpha = 255;
        if (colorType === 6) {
          value = pixels[from + c];
          alpha = pixels[from + 3];
        } else if (colorType === 3) {
          const index = pixels[from];
          value = (palette as Buffer)[index * 3 + c];
          alpha = transparency?.[index] ?? 255;
        } else {
          value = pixels[from + c];
          // A tRNS on RGB marks one exact color; screenshots do not use it, so treat it as opaque.
        }
        raw[to + c] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
      }
    }
  }
  const newHeader = Buffer.from(header);
  newHeader[9] = 2;
  const kept = chunks.filter((c) => ["sRGB", "iCCP", "gAMA", "cHRM"].includes(c.type));
  return Buffer.concat([SIGNATURE, encodeChunk({ type: "IHDR", data: newHeader }), ...kept.map(encodeChunk), encodeChunk({ type: "IDAT", data: deflateSync(raw) }), encodeChunk({ type: "IEND", data: Buffer.alloc(0) })]);
};

// A solid 8-bit image, for tests and fixtures.
export const solidPng = (width: number, height: number, rgba: [number, number, number, number]): Buffer => {
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([SIGNATURE, encodeChunk({ type: "IHDR", data: header }), encodeChunk({ type: "IDAT", data: deflateSync(raw) }), encodeChunk({ type: "IEND", data: Buffer.alloc(0) })]);
};
