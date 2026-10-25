const digitWords = [
  "",
  "หนึ่ง",
  "สอง",
  "สาม",
  "สี่",
  "ห้า",
  "หก",
  "เจ็ด",
  "แปด",
  "เก้า",
];
const placeWords = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/** หลักไม่เกิน 6 หลัก — กฎ เอ็ด / ยี่สิบ / สิบ อยู่ที่นี่ */
function sixDigits(value: number): string {
  const digits = String(value);
  const length = digits.length;
  let out = "";

  for (let index = 0; index < length; index += 1) {
    const digit = Number(digits[index]);
    const place = length - 1 - index;

    if (digit === 0) {
      continue;
    }

    if (place === 1) {
      if (digit === 1) {
        out += "สิบ";
        continue;
      }

      if (digit === 2) {
        out += "ยี่สิบ";
        continue;
      }
    }

    if (place === 0 && digit === 1 && length > 1) {
      out += "เอ็ด";
      continue;
    }

    out += `${digitWords[digit] ?? ""}${placeWords[place] ?? ""}`;
  }

  return out;
}

function thaiWords(value: number): string {
  if (value === 0) {
    return "ศูนย์";
  }

  const millions = Math.floor(value / 1000000);
  const rest = value % 1000000;
  let out = "";

  if (millions > 0) {
    out += `${thaiWords(millions)}ล้าน`;
  }

  if (rest > 0) {
    out += sixDigits(rest);
  }

  return out;
}

/** จำนวนเงินเป็นตัวอักษรไทย — ธรรมเนียมของเอกสารการเงินไทย ปิดท้ายด้วย "ถ้วน" */
export function bahtWords(value: number): string {
  const rounded = Math.round(value);

  return rounded < 0
    ? `ลบ${thaiWords(-rounded)}บาทถ้วน`
    : `${thaiWords(rounded)}บาทถ้วน`;
}
