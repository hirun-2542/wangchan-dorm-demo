import { encode } from "uqr";
import { encodeGrayscalePng } from "./png";

const modulePixels = 10;
/** ISO/IEC 18004 กำหนดพื้นที่ว่างรอบโค้ด 4 โมดูล — น้อยกว่านี้สแกนเนอร์บางตัวอ่านไม่ได้ */
const quietZoneModules = 4;

export async function encodeQrPng(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const qr = encode(text, { ecc: "M", border: quietZoneModules });
  const size = qr.size * modulePixels;
  const pixels = new Uint8Array(size * size).fill(0xff);

  for (let row = 0; row < qr.size; row += 1) {
    const modules = qr.data[row];

    if (modules === undefined) {
      continue;
    }

    for (let column = 0; column < qr.size; column += 1) {
      if (modules[column] !== true) {
        continue;
      }

      for (let offset = 0; offset < modulePixels; offset += 1) {
        const start = (row * modulePixels + offset) * size + column * modulePixels;
        pixels.fill(0, start, start + modulePixels);
      }
    }
  }

  return encodeGrayscalePng(size, size, pixels);
}
