export async function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) {
    return {
      ok: false,
      error: "Telegram authentication data is missing"
    };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) {
      return {
        ok: false,
        error: "Telegram hash is missing"
      };
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("WebAppData"),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

    const secret = await crypto.subtle.sign(
      "HMAC",
      secretKey,
      new TextEncoder().encode(botToken)
    );

    const botSecretKey = await crypto.subtle.importKey(
      "raw",
      secret,
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

    const calculated = await crypto.subtle.sign(
      "HMAC",
      botSecretKey,
      new TextEncoder().encode(dataCheckString)
    );

    const calculatedHex = [...new Uint8Array(calculated)]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedHex !== hash) {
      return {
        ok: false,
        error: "Invalid Telegram authentication"
      };
    }

    const userRaw = params.get("user");

    if (!userRaw) {
      return {
        ok: false,
        error: "Telegram user data is missing"
      };
    }

    const user = JSON.parse(userRaw);

    return {
      ok: true,
      user
    };
  } catch (error) {
    return {
      ok: false,
      error: "Telegram authentication failed"
    };
  }
}
