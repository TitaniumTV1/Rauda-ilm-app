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

        const userRaw = params.get("user");

        if (!userRaw) {
            return {
                ok: false,
                error: "Telegram user data is missing"
            };
        }

        // Удаляем hash перед созданием data-check-string
        params.delete("hash");

        // Telegram требует сортировку параметров по ключу
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
         *     data = botToken
         * )
         */

        const secretKeyBase = await crypto.subtle.importKey(
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
            secretKeyBase,
            encoder.encode(botToken)
        );

        /*
         * calculated_hash =
         * HMAC-SHA256(
         *     key = secretKey,
         *     data = dataCheckString
         * )
         */

        const checkKey = await crypto.subtle.importKey(
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
            checkKey,
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
         * Сравниваем hash Telegram
         */

        if (
            calculatedHex.toLowerCase() !==
            receivedHash.toLowerCase()
        ) {
            console.error("Telegram hash mismatch");

            return {
                ok: false,
                error: "Invalid Telegram authentication"
            };
        }

        /*
         * Разбираем пользователя
         */

        let user;

        try {
            user = JSON.parse(userRaw);
        } catch (error) {
            console.error(
                "Telegram user JSON error:",
                error
            );

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

        console.error(
            "Telegram verification error:",
            error
        );

        return {
            ok: false,
            error: "Telegram authentication failed"
        };
    }
}