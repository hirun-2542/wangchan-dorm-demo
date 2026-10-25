const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ (crcTable[(crc ^ bytes[index]!) & 0xff] ?? 0);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  return merged;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
}

function chunk(type: string, data: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(8);
  const body = new Uint8Array(4);

  writeUint32(header, 0, data.length);

  for (let index = 0; index < 4; index += 1) {
    header[index + 4] = type.charCodeAt(index);
  }

  writeUint32(body, 0, crc32(concat([header.subarray(4), data])));

  return concat([header, data, body]);
}

async function deflate(bytes: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeGrayscalePng(width: number, height: number, pixels: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBuffer>> {
  const stride = width;
  const raw = new Uint8Array((stride + 1) * height);

  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return concat([signature, chunk("IHDR", header), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0))]);
}
