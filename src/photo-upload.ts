const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 1200;
const MAX_SOURCE_EDGE = 10_000;
const MAX_SOURCE_PIXELS = 50_000_000;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

function dimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") {
    if (bytes.length < 24 || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, i) => bytes[i] === value)) return null;
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === "image/webp") {
    if (bytes.length < 25 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return null;
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30) return {
      width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
      height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
    };
    if (chunk === "VP8L" && bytes[20] === 0x2f) return {
      width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
    };
    if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
    return null;
  }
  if (type === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let index = 2;
    while (index + 3 < bytes.length) {
      if (bytes[index++] !== 0xff) return null;
      while (bytes[index] === 0xff) index++;
      const marker = bytes[index++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (index + 2 > bytes.length) return null;
      const length = view.getUint16(index);
      if (length < 2 || index + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) return null;
        return { width: view.getUint16(index + 5), height: view.getUint16(index + 3) };
      }
      index += length;
    }
  }
  return null;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || !blob.size || !TYPES.includes(blob.type)) reject(new Error("写真を変換できませんでした。別の画像を選んでください。"));
    else resolve(blob);
  }, type, quality));
}

export async function preparePhoto(file: File): Promise<Blob> {
  if (!TYPES.includes(file.type)) throw new Error("JPEG・PNG・WebP形式の写真を選んでください。");
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error("元の写真は20MiB以下のファイルを選んでください。");

  let size: { width: number; height: number } | null;
  try { size = dimensions(new Uint8Array(await file.arrayBuffer()), file.type); }
  catch { throw new Error("写真のサイズを確認できませんでした。別の画像を選んでください。"); }
  if (!size || !size.width || !size.height) throw new Error("写真のサイズを確認できませんでした。別の画像を選んでください。");
  if (Math.max(size.width, size.height) > MAX_SOURCE_EDGE || size.width * size.height > MAX_SOURCE_PIXELS) {
    throw new Error("写真の縦横サイズが大きすぎます。別の画像を選んでください。");
  }
  const keepOriginal = Math.max(size.width, size.height) <= MAX_EDGE && file.size <= MAX_UPLOAD_BYTES;

  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("写真を読み込めませんでした。別の画像を選んでください。"); }
  try {
    if (!bitmap.width || !bitmap.height || Math.max(bitmap.width, bitmap.height) > MAX_SOURCE_EDGE || bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
      throw new Error("写真の縦横サイズが大きすぎます。別の画像を選んでください。");
    }
    if (keepOriginal) return file;
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("写真を変換できませんでした。別の画像を選んでください。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // PNGの透過を保ちつつ、容量が大きい場合だけWebPを試す。
    let png: Blob | null = null;
    if (file.type === "image/png") {
      png = await encode(canvas, "image/png");
      if (png.size <= 2 * 1024 * 1024) return png;
    }
    for (const quality of [0.82, 0.72, 0.6]) {
      const output = await encode(canvas, file.type === "image/jpeg" ? "image/jpeg" : "image/webp", quality);
      if (output.size <= MAX_UPLOAD_BYTES && (!png || output.size < png.size)) return output;
    }
    if (png && png.size > 0 && png.size <= MAX_UPLOAD_BYTES) return png;
    throw new Error("圧縮後も写真が5MiBを超えます。別の画像を選んでください。");
  } catch (error) {
    if (error instanceof Error && /^(写真|圧縮後)/.test(error.message)) throw error;
    throw new Error("写真を変換できませんでした。別の画像を選んでください。");
  } finally {
    bitmap.close();
  }
}
