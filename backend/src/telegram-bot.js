// =========================================================
// RAUDA ILM — ОБЩАЯ СИСТЕМА ДОСТУПА
// Telegram + сайт используют таблицу users
// =========================================================

export const ADMIN_PERMISSIONS = [
    "courses",
    "students",
    "groups",
    "exams",
    "payments",
    "certificates",
    "stats"
];


// =========================================================
// СИНХРОНИЗАЦИЯ TELEGRAM-ПОЛЬЗОВАТЕЛЯ
// =========================================================

export async function syncTelegramUser(
    env,
    telegramUser
) {
    if (!env.DB || !telegramUser?.id) {
        return null;
    }

    const telegramId =
        String(telegramUser.id);

    const isOwner =
        telegramId ===
        String(env.OWNER_TELEGRAM_ID);

    const existing = await env.DB
        .prepare(`
            SELECT
                id,
                telegram_id,
                username,
                first_name,
                last_name,
                role,
                status
            FROM users
            WHERE telegram_id = ?
            LIMIT 1
        `)
        .bind(telegramId)
        .first();

    if (!existing) {
        await env.DB
            .prepare(`
                INSERT INTO users (
                    telegram_id,
                    username,
                    first_name,
                    last_name,
                    role,
                    status,
                    created_at,
                    updated_at
                )
                VALUES (
                    ?, ?, ?, ?, ?,
                    'active',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
            `)
            .bind(
                telegramId,
                telegramUser.username || null,
                telegramUser.first_name || null,
                telegramUser.last_name || null,
                isOwner ? "owner" : "student"
            )
            .run();
    } else {
        await env.DB
            .prepare(`
                UPDATE users
                SET
                    username = ?,
                    first_name = ?,
                    last_name = ?,
                    role = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE telegram_id = ?
            `)
            .bind(
                telegramUser.username || null,
                telegramUser.first_name || null,
                telegramUser.last_name || null,
                isOwner
                    ? "owner"
                    : existing.role,
                telegramId
            )
            .run();
    }

    return getTelegramUser(
        env,
        telegramId
    );
}


// =========================================================
// ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ
// =========================================================

export async function getTelegramUser(
    env,
    telegramId
) {
    if (!env.DB || !telegramId) {
        return null;
    }

    return env.DB
        .prepare(`
            SELECT
                id,
                account_id,
                telegram_id,
                username,
                first_name,
                last_name,
                role,
                status
            FROM users
            WHERE telegram_id = ?
            LIMIT 1
        `)
        .bind(String(telegramId))
        .first();
}


// =========================================================
// ДОСТУП К АДМИН-ПАНЕЛИ
// =========================================================

export async function getBotAccess(
    env,
    telegramId
) {
    const owner =
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID);

    if (owner) {
        return {
            allowed: true,
            isOwner: true,
            isAdmin: true,
            role: "owner"
        };
    }

    const user = await getTelegramUser(
        env,
        telegramId
    );

    if (!user) {
        return {
            allowed: false,
            isOwner: false,
            isAdmin: false,
            role: "student",
            user: null
        };
    }

    const isAdmin =
        user.role === "admin" ||
        user.role === "superadmin" ||
        user.role === "owner";

    return {
        allowed: isAdmin,
        isOwner: user.role === "owner",
        isAdmin,
        role: user.role,
        user
    };
}


// =========================================================
// СПИСОК АДМИНИСТРАТОРОВ
// =========================================================

export async function getAdmins(env) {
    if (!env.DB) {
        return [];
    }

    const result = await env.DB
        .prepare(`
            SELECT
                id,
                telegram_id,
                username,
                first_name,
                last_name,
                role,
                status
            FROM users
            WHERE role IN (
                'admin',
                'superadmin',
                'owner'
            )
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 1
                    WHEN 'superadmin' THEN 2
                    WHEN 'admin' THEN 3
                    ELSE 4
                END,
                id ASC
        `)
        .all();

    return result.results || [];
}


// =========================================================
// ИЗМЕНЕНИЕ РОЛИ
// =========================================================

export async function setUserRole(
    env,
    telegramId,
    role
) {
    const allowedRoles = [
        "student",
        "admin",
        "superadmin"
    ];

    if (!allowedRoles.includes(role)) {
        throw new Error(
            "Недопустимая роль пользователя"
        );
    }

    if (
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID)
    ) {
        throw new Error(
            "Нельзя изменить роль владельца"
        );
    }

    const user = await getTelegramUser(
        env,
        telegramId
    );

    if (!user) {
        throw new Error(
            "Пользователь не найден"
        );
    }

    await env.DB
        .prepare(`
            UPDATE users
            SET
                role = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE telegram_id = ?
        `)
        .bind(
            role,
            String(telegramId)
        )
        .run();

    /*
     * Если администратора сделали учеником,
     * удаляем все его административные права.
     */

    if (role === "student") {
        await env.DB
            .prepare(`
                DELETE FROM admin_permissions
                WHERE admin_id = ?
            `)
            .bind(user.id)
            .run();
    }

    return getTelegramUser(
        env,
        telegramId
    );
}


// =========================================================
// ПРОВЕРКА КОНКРЕТНОГО ПРАВА
// =========================================================

export async function hasPermission(
    env,
    telegramId,
    permission
) {
    if (
        !ADMIN_PERMISSIONS.includes(permission)
    ) {
        return false;
    }

    const access = await getBotAccess(
        env,
        telegramId
    );

    // Владелец имеет все права всегда.
    if (access.isOwner) {
        return true;
    }

    if (
        !access.isAdmin ||
        !access.user?.id
    ) {
        return false;
    }

    const row = await env.DB
        .prepare(`
            SELECT id
            FROM admin_permissions
            WHERE admin_id = ?
              AND permission = ?
            LIMIT 1
        `)
        .bind(
            access.user.id,
            permission
        )
        .first();

    return Boolean(row);
}


// =========================================================
// ПОЛУЧИТЬ ПРАВА АДМИНИСТРАТОРА
// =========================================================

export async function getAdminPermissions(
    env,
    telegramId
) {
    const access = await getBotAccess(
        env,
        telegramId
    );

    if (access.isOwner) {
        return [...ADMIN_PERMISSIONS];
    }

    if (
        !access.isAdmin ||
        !access.user?.id
    ) {
        return [];
    }

    const result = await env.DB
        .prepare(`
            SELECT permission
            FROM admin_permissions
            WHERE admin_id = ?
            ORDER BY permission
        `)
        .bind(access.user.id)
        .all();

    return (result.results || [])
        .map(row => row.permission)
        .filter(permission =>
            ADMIN_PERMISSIONS.includes(
                permission
            )
        );
}


// =========================================================
// ВЫДАТЬ ПРАВО
// =========================================================

export async function grantPermission(
    env,
    telegramId,
    permission
) {
    validatePermission(permission);

    const user = await getTelegramUser(
        env,
        telegramId
    );

    if (!user) {
        throw new Error(
            "Пользователь не найден"
        );
    }

    if (user.role === "owner") {
        return true;
    }

    if (
        user.role !== "admin" &&
        user.role !== "superadmin"
    ) {
        throw new Error(
            "Пользователь не является администратором"
        );
    }

    await env.DB
        .prepare(`
            INSERT OR IGNORE INTO admin_permissions (
                admin_id,
                permission
            )
            VALUES (?, ?)
        `)
        .bind(
            user.id,
            permission
        )
        .run();

    return true;
}


// =========================================================
// ЗАБРАТЬ ПРАВО
// =========================================================

export async function revokePermission(
    env,
    telegramId,
    permission
) {
    validatePermission(permission);

    if (
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID)
    ) {
        throw new Error(
            "Нельзя ограничить владельца"
        );
    }

    const user = await getTelegramUser(
        env,
        telegramId
    );

    if (!user) {
        throw new Error(
            "Пользователь не найден"
        );
    }

    await env.DB
        .prepare(`
            DELETE FROM admin_permissions
            WHERE admin_id = ?
              AND permission = ?
        `)
        .bind(
            user.id,
            permission
        )
        .run();

    return true;
}


// =========================================================
// ПЕРЕКЛЮЧИТЬ ПРАВО
// =========================================================

export async function togglePermission(
    env,
    telegramId,
    permission
) {
    validatePermission(permission);

    if (
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID)
    ) {
        throw new Error(
            "Права владельца нельзя изменить"
        );
    }

    const user = await getTelegramUser(
        env,
        telegramId
    );

    if (!user) {
        throw new Error(
            "Пользователь не найден"
        );
    }

    if (
        user.role !== "admin" &&
        user.role !== "superadmin"
    ) {
        throw new Error(
            "Пользователь не является администратором"
        );
    }

    const existing = await env.DB
        .prepare(`
            SELECT id
            FROM admin_permissions
            WHERE admin_id = ?
              AND permission = ?
            LIMIT 1
        `)
        .bind(
            user.id,
            permission
        )
        .first();

    if (existing) {
        await revokePermission(
            env,
            telegramId,
            permission
        );

        return {
            enabled: false,
            permission
        };
    }

    await grantPermission(
        env,
        telegramId,
        permission
    );

    return {
        enabled: true,
        permission
    };
}


// =========================================================
// ВЫДАТЬ ВСЕ ПРАВА
// =========================================================

export async function grantAllPermissions(
    env,
    telegramId
) {
    for (
        const permission
        of ADMIN_PERMISSIONS
    ) {
        await grantPermission(
            env,
            telegramId,
            permission
        );
    }

    return true;
}


// =========================================================
// УБРАТЬ ВСЕ ПРАВА
// =========================================================

export async function revokeAllPermissions(
    env,
    telegramId
) {
    if (
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID)
    ) {
        throw new Error(
            "Нельзя ограничить владельца"
        );
    }

    const user = await getTelegramUser(
        env,
        telegramId
    );

    if (!user) {
        throw new Error(
            "Пользователь не найден"
        );
    }

    await env.DB
        .prepare(`
            DELETE FROM admin_permissions
            WHERE admin_id = ?
        `)
        .bind(user.id)
        .run();

    return true;
}


// =========================================================
// ВСПОМОГАТЕЛЬНОЕ
// =========================================================

function validatePermission(permission) {
    if (
        !ADMIN_PERMISSIONS.includes(permission)
    ) {
        throw new Error(
            "Неизвестное право администратора"
        );
    }
}