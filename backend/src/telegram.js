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

    const encoder = new TextEncoder();

    // Telegram Web Apps:
    // secret_key = HMAC-SHA256(bot_token, "WebAppData")
    const webAppDataKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

    const secretKeyBytes = await crypto.subtle.sign(
      "HMAC",
      webAppDataKey,
      encoder.encode(botToken)
    );

    const secretKey = await crypto.subtle.importKey(
      "raw",
      secretKeyBytes,
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

    const calculatedHashBytes = await crypto.subtle.sign(
      "HMAC",
      secretKey,
      encoder.encode(dataCheckString)
    );

    const calculatedHash = [...new Uint8Array(calculatedHashBytes)]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedHash !== hash) {
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

    let user;

    try {
      user = JSON.parse(userRaw);
    } catch {
      return {
        ok: false,
        error: "Invalid Telegram user data"
      };
    }

    if (!user.id) {
      return {
        ok: false,
        error: "Telegram user ID is missing"
      };
    }

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
