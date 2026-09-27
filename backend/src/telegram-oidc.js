const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const TELEGRAM_JWKS_URL =
    "https://oauth.telegram.org/.well-known/jwks.json";

function base64UrlToBytes(value) {
    const normalized =
        String(value)
            .replace(/-/g, "+")
            .replace(/_/g, "/");

    const padded =
        normalized +
        "=".repeat(
            (4 - normalized.length % 4) % 4
        );

    const binary = atob(padded);

    return Uint8Array.from(
        binary,
        char => char.charCodeAt(0)
    );
}

function decodeJsonPart(value) {
    const bytes =
        base64UrlToBytes(value);

    const text =
        new TextDecoder()
            .decode(bytes);

    return JSON.parse(text);
}

function audienceMatches(aud, clientId) {
    const expected =
        String(clientId || "");

    if (!expected) {
        return false;
    }

    if (Array.isArray(aud)) {
        return aud
            .map(String)
            .includes(expected);
    }

    return String(aud) === expected;
}

async function loadTelegramKey(kid) {
    const response =
        await fetch(
            TELEGRAM_JWKS_URL,
            {
                headers: {
                    Accept: "application/json"
                },
                cf: {
                    cacheTtl: 3600,
                    cacheEverything: true
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            "Не удалось загрузить Telegram JWKS"
        );
    }

    const data =
        await response.json();

    const keys =
        Array.isArray(data?.keys)
            ? data.keys
            : [];

    const key =
        keys.find(
            item =>
                item.kid === kid &&
                item.kty === "RSA"
        );

    if (!key) {
        throw new Error(
            "Ключ Telegram не найден"
        );
    }

    return key;
}

export async function verifyTelegramIdToken(
    idToken,
    clientId
) {
    if (
        typeof idToken !== "string" ||
        !idToken
    ) {
        throw new Error(
            "Telegram id_token отсутствует"
        );
    }

    const parts =
        idToken.split(".");

    if (parts.length !== 3) {
        throw new Error(
            "Некорректный Telegram id_token"
        );
    }

    const [
        headerPart,
        payloadPart,
        signaturePart
    ] = parts;

    const header =
        decodeJsonPart(
            headerPart
        );

    const payload =
        decodeJsonPart(
            payloadPart
        );

    if (
        header.alg !== "RS256" ||
        !header.kid
    ) {
        throw new Error(
            "Неподдерживаемая подпись Telegram"
        );
    }

    const jwk =
        await loadTelegramKey(
            header.kid
        );

    const publicKey =
        await crypto.subtle.importKey(
            "jwk",
            jwk,
            {
                name:
                    "RSASSA-PKCS1-v1_5",
                hash:
                    "SHA-256"
            },
            false,
            ["verify"]
        );

    const validSignature =
        await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            publicKey,
            base64UrlToBytes(
                signaturePart
            ),
            new TextEncoder()
                .encode(
                    headerPart +
                    "." +
                    payloadPart
                )
        );

    if (!validSignature) {
        throw new Error(
            "Telegram подпись не совпадает"
        );
    }

    const now =
        Math.floor(
            Date.now() / 1000
        );

    if (
        payload.iss !==
        TELEGRAM_ISSUER
    ) {
        throw new Error(
            "Некорректный Telegram issuer"
        );
    }

    if (
        !audienceMatches(
            payload.aud,
            clientId
        )
    ) {
        throw new Error(
            "Некорректный Telegram audience"
        );
    }

    if (
        !Number.isFinite(
            Number(payload.exp)
        ) ||
        Number(payload.exp) <= now
    ) {
        throw new Error(
            "Telegram авторизация устарела"
        );
    }

    if (
        payload.iat &&
        Number(payload.iat) >
            now + 60
    ) {
        throw new Error(
            "Некорректное время Telegram авторизации"
        );
    }

    const telegramId =
        Number(
            payload.id
        );

    if (
        !Number.isSafeInteger(
            telegramId
        ) ||
        telegramId <= 0
    ) {
        throw new Error(
            "Telegram ID отсутствует"
        );
    }

    return {
        claims: payload,

        user: {
            id:
                telegramId,

            first_name:
                payload.given_name ||
                payload.name ||
                null,

            last_name:
                payload.family_name ||
                null,

            username:
                payload.preferred_username ||
                null,

            photo_url:
                payload.picture ||
                null
        }
    };
}
