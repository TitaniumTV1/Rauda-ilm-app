export async function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) {
    return {
      ok: false,
      error: "Telegram authentication data is missing"
    };
  }

  try {
    const params = new URLSearchParams(initData);

    const receivedHash = params.get("hash");

    if (!receivedHash) {
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

    /*
     * Telegram Web Apps:
     *
     * secret_key = HMAC-SHA256(
     *     key = "WebAppData",
     *     message = bot_token
     * )
     */

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

    const secretKey = await crypto.subtle.sign(
      "HMAC",
      webAppDataKey,
      encoder.encode(botToken)
    );

    /*
     * calculated_hash =
     * HMAC-SHA256(
     *     key = secret_key,
     *     message = data_check_string
     * )
     */

    const secretHmacKey = await crypto.subtle.importKey(
      "raw",
      secretKey,
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

    const calculatedHash = await crypto.subtle.sign(
      "HMAC",
      secretHmacKey,
      encoder.encode(dataCheckString)
    );

    const calculatedHex = Array.from(
      new Uint8Array(calculatedHash)
    )
      .map(byte =>
        byte.toString(16).padStart(2, "0")
      )
      .join("");

    /*
     * Constant-time comparison
     */

    if (
      calculatedHex.length !== receivedHash.length
    ) {
      return {
        ok: false,
        error: "Invalid Telegram authentication"
      };
    }

    let difference = 0;

    for (let i = 0; i < calculatedHex.length; i++) {
      difference |=
        calculatedHex.charCodeAt(i) ^
        receivedHash.charCodeAt(i);
    }

    if (difference !== 0) {
      return {
        ok: false,
        error: "Invalid Telegram authentication"
      };
    }

    /*
     * Получаем Telegram user
     */

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

    if (!user || !user.id) {
      return {
        ok: false,
        error: "Invalid Telegram user"
      };
    }

    return {
      ok: true,
      user
    };

  } catch (error) {
    console.error("Telegram authentication error:", error);

    return {
      ok: false,
      error: "Telegram authentication failed"
    };
  }
}