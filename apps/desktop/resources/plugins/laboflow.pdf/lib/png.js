/**
 * Minimal PNG encoding for decoded PDF page bitmaps.
 *
 * The PDF engine must re-encode images pdf.js has already decoded (RGB/RGBA
 * sample buffers) without any third-party image dependency: Node's `zlib`
 * covers deflate, and scanline filter 0 keeps the encoder trivial while the
 * source (photographic page scans) is handed to the model as-is. Only what
 * the PDFRead tool needs is implemented — no interlacing, no ancillary
 * chunks beyond the required ones.
 */
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes) {
  // Standard PNG CRC-32 (IEEE 802.3), table-free variant.
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Encode an RGB/RGBA bitmap as a PNG buffer. Rows use filter type 0. */
export function encodePng(bitmap) {
  const { width, height, channels, data } = bitmap;
  if (width <= 0 || height <= 0) throw new Error("encodePng: empty bitmap");
  if (data.length !== width * height * channels) {
    throw new Error(
      `encodePng: expected ${width * height * channels} samples, got ${data.length}`,
    );
  }
  const stride = width * channels;
  // One filter byte per row, all zero (None).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type: truecolor / truecolor+alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Integer box-average downscale so a page bitmap stays inside a bounded long
 * edge before it enters the model context. Upscaling never happens; a bitmap
 * already within `maxLongEdge` is returned unchanged.
 */
export function downscale(bitmap, maxLongEdge) {
  const { width, height, channels, data } = bitmap;
  const longEdge = Math.max(width, height);
  if (maxLongEdge <= 0 || longEdge <= maxLongEdge) return bitmap;
  const scale = maxLongEdge / longEdge;
  const targetWidth = Math.max(1, Math.floor(width * scale));
  const targetHeight = Math.max(1, Math.floor(height * scale));
  const out = new Uint8Array(targetWidth * targetHeight * channels);
  const stride = width * channels;
  const outStride = targetWidth * channels;
  for (let ty = 0; ty < targetHeight; ty++) {
    const sy0 = Math.floor((ty * height) / targetHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx++) {
      const sx0 = Math.floor((tx * width) / targetWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / targetWidth));
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        let count = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          const row = sy * stride;
          for (let sx = sx0; sx < sx1; sx++) {
            sum += data[row + sx * channels + c];
            count++;
          }
        }
        out[ty * outStride + tx * channels + c] = Math.round(sum / count);
      }
    }
  }
  return { width: targetWidth, height: targetHeight, channels, data: out };
}
