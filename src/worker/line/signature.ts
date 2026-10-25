const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(value: string): Uint8Array | null {
  if (!base64Pattern.test(value)) {
    return null;
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

export async function verifyLineSignature(channelSecret: string | undefined, rawBody: string, headerSignature: string): Promise<boolean> {
  const secret = typeof channelSecret === "string" ? channelSecret.trim() : "";

  // ไม่มี secret แปลว่ายืนยันไม่ได้ ไม่ใช่ "ไม่มีอะไรต้องตรวจ" จึงต้องปฏิเสธ
  if (secret === "") {
    console.error(JSON.stringify({ message: "line signature rejected", reason: "LINE_CHANNEL_SECRET is not configured" }));
    return false;
  }

  if (headerSignature === "") {
    return false;
  }

  const signature = decodeBase64(headerSignature);

  if (signature === null) {
    console.error(JSON.stringify({ message: "line signature is not valid base64" }));
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(rawBody));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "verify line signature failed", error: detail }));
    return false;
  }
}
