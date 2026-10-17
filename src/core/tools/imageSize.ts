import { fetchHead, fetchRange } from "./http";

export interface ImageSize {
  width: number;
  height: number;
}

/** Ukuran gambar dari potongan awal berkasnya (JPEG, PNG, GIF, WebP). Null bila tidak dikenali. */
export function parseImageSize(head: Buffer): ImageSize | null {
  if (head.length < 30) return null;

  // PNG: ukuran ada di chunk IHDR, selalu di posisi yang sama
  if (head.readUInt32BE(0) === 0x89504e47) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };

  if (head.toString("ascii", 0, 3) === "GIF") return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };

  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    const kind = head.toString("ascii", 12, 16);
    if (kind === "VP8 ") return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
    return null;
  }

  if (isJpeg(head)) {
    const found = walkJpeg(head, 0, 2);
    return found && "width" in found ? found : null;
  }
  return null;
}

const isJpeg = (head: Buffer) => head[0] === 0xff && head[1] === 0xd8;

/**
 * Telusuri segmen JPEG sampai bertemu SOF (penanda C0-CF selain C4, C8, CC), yang memuat ukuran gambar.
 * `buf` adalah potongan berkas yang dimulai di posisi `base`; `pos` posisi mulai menelusuri (dihitung dari awal berkas).
 * Bila segmen berikutnya berada di luar potongan, dikembalikan posisinya (`resume`) agar bisa diambil lanjutannya.
 */
function walkJpeg(buf: Buffer, base: number, pos: number): ImageSize | { resume: number } | null {
  while (pos - base + 9 < buf.length) {
    const at = pos - base;
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    }
    pos += 2 + buf.readUInt16BE(at + 2);
  }
  return { resume: pos };
}

const PROBE_CHUNK = 64 * 1024;
/** JPEG bisa membawa metadata (EXIF, XMP, Photoshop) ratusan KB sebelum ukurannya; lebih jauh dari ini dianggap tidak dikenali. */
const PROBE_MAX_OFFSET = 4 * 1024 * 1024;

/**
 * Ukuran gambar di sebuah URL tanpa mengunduh seluruh berkasnya: hanya 64 KB pertama yang diambil.
 * Pada JPEG yang metadatanya besar, metadata itu dilompati dan hanya potongan 64 KB di posisi
 * segmen berikutnya yang diambil. Null bila gagal diambil atau formatnya tidak dikenali.
 */
export async function probeImageSize(url: string): Promise<ImageSize | null> {
  const valid = (size: ImageSize | null) => (size && size.width > 0 && size.height > 0 ? size : null);
  try {
    const head = await fetchHead(url, PROBE_CHUNK);
    if (!isJpeg(head)) return valid(parseImageSize(head));

    let found = walkJpeg(head, 0, 2);
    // Tiap putaran melompat setidaknya satu segmen, jadi jumlahnya dibatasi agar berkas rusak tidak berputar terus
    for (let hop = 0; hop < 16 && found && "resume" in found; hop++) {
      if (found.resume > PROBE_MAX_OFFSET) return null;
      const chunk = await fetchRange(url, found.resume, PROBE_CHUNK);
      if (chunk.length < 10) return null;
      found = walkJpeg(chunk, found.resume, found.resume);
    }
    return found && "width" in found ? valid(found) : null;
  } catch {
    return null;
  }
}

/** Di atas rasio tinggi:lebar ini, Telegram mengecilkan gambar sampai teksnya tidak terbaca. */
const TALL_RATIO = 2;
/** Rasio potongan yang dituju: kira-kira satu layar ponsel. */
const SLICE_RATIO = 1.5;

/**
 * Gambar memanjang (halaman webtoon/manhwa) dipecah menjadi beberapa URL potongan sama tinggi.
 * Pemotongan dikerjakan CDN gambar publik wsrv.nl saat potongan itu dibuka, jadi server bot
 * tidak mengunduh atau mengolah gambarnya. Gambar berukuran wajar dikembalikan apa adanya.
 */
export function sliceTallImage(url: string, size: ImageSize | null): string[] {
  if (!size || size.height <= size.width * TALL_RATIO) return [url];

  const count = Math.ceil(size.height / (size.width * SLICE_RATIO));
  const step = Math.ceil(size.height / count);
  const source = encodeURIComponent(url);
  return Array.from({ length: count }, (_, i) => {
    const top = i * step;
    const height = Math.min(step, size.height - top);
    return `https://wsrv.nl/?url=${source}&cx=0&cy=${top}&cw=${size.width}&ch=${height}&output=jpg&q=85`;
  });
}
