export async function syncTelegramUser(env, telegramUser) {
    if (!env.DB || !telegramUser?.id) {
        return null;
    }

    const telegramId = String(telegramUser.id);

    const isOwner =
        telegramId === String(env.OWNER_TELEGRAM_ID);

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
        const role =
            isOwner ? "owner" : "student";

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
                VALUES (?, ?, ?, ?, ?, 'active',
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP)
            `)
            .bind(
                telegramId,
                telegramUser.username || null,
                telegramUser.first_name || null,
                telegramUser.last_name || null,
                role
            )
            .run();
    } else {
        const role =
            isOwner
                ? "owner"
                : existing.role;

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
                role,
                telegramId
            )
            .run();
    }

    return getTelegramUser(
        env,
        telegramId
    );
}


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


export async function getBotAccess(
    env,
    telegramId
) {
    const isOwner =
        String(telegramId) ===
        String(env.OWNER_TELEGRAM_ID);

    if (isOwner) {
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
            role: "student"
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

    const result = await env.DB
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

    return result;
}


export async function hasPermission(
    env,
    telegramId,
    permission
) {
    const access = await getBotAccess(
        env,
        telegramId
    );

    if (access.isOwner) {
        return true;
    }

    if (!access.isAdmin || !access.user?.id) {
        return false;
    }

    // Если обычному администратору пока
    // не назначены отдельные ограничения,
    // считаем его полным администратором.
    const permissions = await env.DB
        .prepare(`
            SELECT permission
            FROM admin_permissions
            WHERE admin_id = ?
        `)
        .bind(access.user.id)
        .all();

    const rows = permissions.results || [];

    if (rows.length === 0) {
        return true;
    }

    return rows.some(
        row => row.permission === permission
    );
}