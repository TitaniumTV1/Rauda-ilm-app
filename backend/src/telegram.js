export async function verifyTelegramInitData(
    initData,
    botToken
) {
    if (
        typeof initData !== "string" ||
        !initData ||
        initData.length > 16384 ||
        !botToken
    ) {
        return {
            ok: false,
            error:
                "Telegram authentication data is missing"
        };
    }

    try {
        const params =
            new URLSearchParams(initData);

        const receivedHash =
            String(
                params.get("hash") || ""
            )
                .trim()
                .toLowerCase();

        if (
            !/^[a-f0-9]{64}$/.test(
                receivedHash
            )
        ) {
            return {
                ok: false,
                error:
                    "Invalid Telegram authentication hash"
            };
        }

        const authDate =
            Number(
                params.get("auth_date")
            );

        if (
            !Number.isSafeInteger(
                authDate
            )
        ) {
            return {
                ok: false,
                error:
                    "Invalid Telegram authentication date"
            };
        }

        const now =
            Math.floor(
                Date.now() / 1000
            );

        /*
         * Telegram initData принимаем
         * только в течение 2 часов.
         */
        if (
            authDate > now + 60 ||
            now - authDate > 7200
        ) {
            return {
                ok: false,
                error:
                    "Telegram authentication has expired"
            };
        }

        params.delete("hash");

        const dataCheckString =
            [...params.entries()]
                .sort(
                    ([a], [b]) =>
                        a.localeCompare(b)
                )
                .map(
                    ([key, value]) =>
                        `${key}=${value}`
                )
                .join("\n");

        const encoder =
            new TextEncoder();

        const secretKeyBase =
            await crypto.subtle.importKey(
                "raw",
                encoder.encode(
                    "WebAppData"
                ),
                {
                    name: "HMAC",
                    hash: "SHA-256"
                },
                false,
                ["sign"]
            );

        const secretKey =
            await crypto.subtle.sign(
                "HMAC",
                secretKeyBase,
                encoder.encode(
                    String(botToken)
                )
            );

        const checkKey =
            await crypto.subtle.importKey(
                "raw",
                secretKey,
                {
                    name: "HMAC",
                    hash: "SHA-256"
                },
                false,
                ["sign"]
            );

        const calculatedHash =
            await crypto.subtle.sign(
                "HMAC",
                checkKey,
                encoder.encode(
                    dataCheckString
                )
            );

        const calculatedHex =
            Array.from(
                new Uint8Array(
                    calculatedHash
                )
            )
                .map(
                    byte =>
                        byte
                            .toString(16)
                            .padStart(2, "0")
                )
                .join("");

        if (
            !constantTimeEqual(
                calculatedHex,
                receivedHash
            )
        ) {
            return {
                ok: false,
                error:
                    "Invalid Telegram authentication"
            };
        }

        const userRaw =
            params.get("user");

        if (!userRaw) {
            return {
                ok: false,
                error:
                    "Telegram user data is missing"
            };
        }

        let user;

        try {
            user =
                JSON.parse(userRaw);
        } catch {
            return {
                ok: false,
                error:
                    "Invalid Telegram user data"
            };
        }

        const telegramId =
            Number(user?.id);

        if (
            !Number.isSafeInteger(
                telegramId
            ) ||
            telegramId <= 0
        ) {
            return {
                ok: false,
                error:
                    "Invalid Telegram user"
            };
        }

        user.id =
            telegramId;

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
            error:
                "Telegram authentication failed"
        };
    }
}


function constantTimeEqual(
    first,
    second
) {
    const a =
        new TextEncoder().encode(
            String(first)
        );

    const b =
        new TextEncoder().encode(
            String(second)
        );

    if (a.length !== b.length) {
        return false;
    }

    let difference = 0;

    for (
        let index = 0;
        index < a.length;
        index++
    ) {
        difference |=
            a[index] ^ b[index];
    }

    return difference === 0;
}
