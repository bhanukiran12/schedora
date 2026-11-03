// Validates host-uploaded form images from their bytes alone (never the file name or the browser's
// type) and removes metadata without re-encoding. Only still JPEG, PNG and WebP images are
// accepted; SVG, HTML, animations and anything that does not parse cleanly are refused.
import { crc32 } from 'node:zlib';

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,        // per image, after metadata is removed
  maxSide: 4000,                    // pixels, either side
  maxPixels: 16_000_000,
  workspaceBytes: 10 * 1024 * 1024, // image bytes per workspace
  // Database space (base64 text, about 4/3 of the image bytes) across the whole service. Images
  // share the free 500 MB PostgreSQL database and every backup with all other data, so the default
  // is about 12% of it; FORM_IMAGE_STORAGE_MB changes it (docs/FORMS.md, "Media").
  instanceStoredBytes: 60 * 1024 * 1024
});

/** Database space an image of this many bytes takes as base64 text. */
export const storedBytes = bytes => Math.ceil(bytes / 3) * 4;

export class ImageError extends Error {}
const refuse = message => { throw new ImageError(message); };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Ancillary PNG chunks that carry text, camera or time metadata rather than pixels or colour.
const PNG_METADATA = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function png(buffer) {
  const kept = [PNG_SIGNATURE];
  let offset = 8, width = 0, height = 0, sawEnd = false, sawData = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) refuse('The PNG file is truncated.');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || offset + 12 + length > buffer.length) refuse('The PNG file is damaged.');
    const chunk = buffer.subarray(offset, offset + 12 + length);
    if (crc32(chunk.subarray(4, 8 + length)) !== chunk.readUInt32BE(8 + length)) refuse('The PNG file is damaged.');
    if (offset === 8 && type !== 'IHDR') refuse('The PNG file is damaged.');
    if (type === 'IHDR') { width = chunk.readUInt32BE(8); height = chunk.readUInt32BE(12); }
    if (type === 'acTL') refuse('Animated images are not supported. Use a still image.');
    if (type === 'IDAT') sawData = true;
    if (!PNG_METADATA.has(type)) kept.push(chunk);
    offset += 12 + length;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd || !sawData) refuse('The PNG file is incomplete.');
  return { mime: 'image/png', width, height, data: Buffer.concat(kept) };
}

// JPEG segments that hold camera, location, editing or comment metadata. JFIF (APP0), colour
// profiles (APP2) and Adobe colour information (APP14) are kept so colours render correctly.
const JPEG_METADATA = new Set([0xe1, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe]);
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(buffer) {
  const kept = [buffer.subarray(0, 2)];
  let offset = 2, width = 0, height = 0;
  while (true) {
    if (offset + 4 > buffer.length || buffer[offset] !== 0xff) refuse('The JPEG file is damaged.');
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) refuse('The JPEG file is damaged.');
    if (marker === 0xff) { offset++; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) refuse('The JPEG file is truncated.');
    const segment = buffer.subarray(offset, offset + 2 + length);
    if (JPEG_FRAMES.has(marker)) { if (length < 8) refuse('The JPEG file is damaged.'); height = segment.readUInt16BE(5); width = segment.readUInt16BE(7); }
    if (marker === 0xda) {
      // Entropy-coded data follows the scan header and runs to the end-of-image marker.
      if (!width || !height) refuse('The JPEG file has no image size.');
      if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) refuse('The JPEG file is truncated.');
      kept.push(buffer.subarray(offset));
      break;
    }
    if (!JPEG_METADATA.has(marker)) kept.push(segment);
    offset += 2 + length;
  }
  return { mime: 'image/jpeg', width, height, data: Buffer.concat(kept) };
}

function webp(buffer) {
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) refuse('The WebP file is truncated or has extra data.');
  const kept = [];
  let offset = 12, width = 0, height = 0, vp8x = null, image = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) refuse('The WebP file is damaged.');
    const type = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length) refuse('The WebP file is damaged.');
    const chunk = Buffer.from(buffer.subarray(offset, end));
    if (type === 'ANIM' || type === 'ANMF') refuse('Animated images are not supported. Use a still image.');
    if (type === 'VP8X') {
      if (size < 10) refuse('The WebP file is damaged.');
      if (chunk[8] & 0x02) refuse('Animated images are not supported. Use a still image.');
      chunk[8] &= ~0x0c; // no EXIF or XMP once those chunks are removed
      width = chunk.readUIntLE(12, 3) + 1; height = chunk.readUIntLE(15, 3) + 1;
      vp8x = chunk;
    } else if (type === 'VP8 ') {
      if (size < 10 || chunk[11] !== 0x9d || chunk[12] !== 0x01 || chunk[13] !== 0x2a) refuse('The WebP file is damaged.');
      if (!vp8x) { width = chunk.readUInt16LE(14) & 0x3fff; height = chunk.readUInt16LE(16) & 0x3fff; }
      image = true;
    } else if (type === 'VP8L') {
      if (size < 5 || chunk[8] !== 0x2f) refuse('The WebP file is damaged.');
      if (!vp8x) { const bits = chunk.readUInt32LE(9); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
      image = true;
    }
    if (type !== 'EXIF' && type !== 'XMP ') kept.push(chunk);
    offset = end;
  }
  if (!image) refuse('The WebP file has no image data.');
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return { mime: 'image/webp', width, height, data: Buffer.concat([header, body]) };
}

/** Returns { mime, width, height, data } with metadata removed, or throws ImageError. */
export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) refuse('That file is not a supported image.');
  if (buffer.length > IMAGE_LIMITS.maxBytes * 2) refuse(`Images must be under ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`);
  let image;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) image = png(buffer);
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) image = jpeg(buffer);
  else if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') image = webp(buffer);
  else refuse('Only JPEG, PNG and WebP images are supported. SVG, HTML and other files are not accepted.');
  if (!image.width || !image.height) refuse('The image has no size.');
  if (image.width > IMAGE_LIMITS.maxSide || image.height > IMAGE_LIMITS.maxSide || image.width * image.height > IMAGE_LIMITS.maxPixels) refuse(`Images can be at most ${IMAGE_LIMITS.maxSide} × ${IMAGE_LIMITS.maxSide} pixels.`);
  if (image.data.length > IMAGE_LIMITS.maxBytes) refuse(`Images must be under ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`);
  return image;
}
