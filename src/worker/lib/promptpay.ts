export type PromptPayIdType = "phone" | "citizen-id";

const payloadFormatTag = "00";
const payloadFormatIndicator = "01";
const pointOfInitiationTag = "01";
const pointOfInitiationDynamic = "12";
const merchantAccountTag = "29";
const merchantGuidTag = "00";
const merchantGuid = "A000000677010111";
const phoneTag = "01";
const citizenIdTag = "02";
const transactionCurrencyTag = "53";
const transactionCurrencyThb = "764";
const transactionAmountTag = "54";
const countryCodeTag = "58";
const countryCodeTh = "TH";
const crcTag = "63";
const crcLength = 4;

const merchantTargetLength = 13;
const phoneCountryCode = "66";

const crcPolynomial = 0x1021;
const crcInitial = 0xffff;

export function crc16CcittFalse(input: string): number {
  let crc = crcInitial;

  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index) << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) === 0 ? (crc << 1) & 0xffff : ((crc << 1) ^ crcPolynomial) & 0xffff;
    }
  }

  return crc & 0xffff;
}

export function crc16CcittFalseHex(input: string): string {
  return crc16CcittFalse(input).toString(16).toUpperCase().padStart(crcLength, "0");
}

function field(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

/**
 * เบอร์ 9 หลัก (ไม่นำด้วย 0) และ 10 หลัก (นำด้วย 0) คือหมายเลขเดียวกัน
 * ต้องได้ 0066XXXXXXXXX เหมือนกันทั้งคู่ ไม่งั้น QR จะจ่ายไม่ได้
 */
function phoneMerchantTarget(digits: string): string {
  return `${phoneCountryCode}${digits.replace(/^0/, "")}`.padStart(merchantTargetLength, "0");
}

export function promptPayMerchantTarget(type: PromptPayIdType, id: string): string {
  const digits = id.replace(/\D/g, "");
  return type === "citizen-id" ? digits : phoneMerchantTarget(digits);
}

export function promptPayMerchantTag(type: PromptPayIdType): string {
  return type === "citizen-id" ? citizenIdTag : phoneTag;
}

export function buildPromptPayPayload(type: PromptPayIdType, id: string, amount: number): string {
  const merchant = field(merchantGuidTag, merchantGuid) + field(promptPayMerchantTag(type), promptPayMerchantTarget(type, id));
  const body = [
    field(payloadFormatTag, payloadFormatIndicator),
    field(pointOfInitiationTag, pointOfInitiationDynamic),
    field(merchantAccountTag, merchant),
    field(countryCodeTag, countryCodeTh),
    field(transactionCurrencyTag, transactionCurrencyThb),
    field(transactionAmountTag, amount.toFixed(2)),
  ].join("");
  const checksumInput = `${body}${crcTag}${String(crcLength).padStart(2, "0")}`;

  return `${checksumInput}${crc16CcittFalseHex(checksumInput)}`;
}

export function promptPayPayloadChecksum(payload: string): string {
  return crc16CcittFalseHex(payload.slice(0, -crcLength));
}

export function isValidPromptPayPayload(payload: string): boolean {
  return payload.length > crcLength + 2 && payload.slice(-crcLength) === promptPayPayloadChecksum(payload);
}
