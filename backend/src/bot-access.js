import {hasPermission as sharedPermission} from './school-core.js';
// null courseIds means all courses; otherwise the administrator is scoped.
export async function getBotCourseScope(env, telegramId) {
    const user = await getTelegramUser(env, telegramId);
    if (!user || !await sharedPermission(env.DB, user, 'courses')) return { allowed: false, courseIds: [], user };
    if (user.role === 'owner' || user.role === 'superadmin') return { allowed: true, courseIds: null, user };
    const result = await env.DB.prepare('SELECT course_id FROM admin_courses WHERE admin_id=?').bind(user.id).all();
    const ids = (result.results || []).map(row => Number(row.course_id));
    return { allowed: true, courseIds: ids.length ? ids : null, user };
}
export async function hasBotCourseAccess(env, telegramId, courseId) {
    const scope = await getBotCourseScope(env, telegramId);
    return scope.allowed && (scope.courseIds === null || scope.courseIds.includes(Number(courseId)));
}
export async function canCreateBotCourse(env, telegramId) {
    const scope = await getBotCourseScope(env, telegramId);
    return scope.allowed && scope.courseIds === null;
}
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
    const user = await getTelegramUser(env,telegramId);
    if(!user || user.status!=='active') return {allowed:false,isOwner:false,isAdmin:false,role:'student',user};
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

    /*
     * Если права администратора сняты,
     * удаляем его старые разрешения.
     */
    if (role === "student") {
        const user = await getTelegramUser(
            env,
            telegramId
        );

        if (user?.id) {
            await env.DB
                .prepare(`
                    DELETE FROM admin_permissions
                    WHERE admin_id = ?
                `)
                .bind(user.id)
                .run();
        }
    }

    return result;
}


/*
 * Список разрешений администратора.
 *
 * Владелец не зависит от этой таблицы:
 * OWNER_TELEGRAM_ID всегда имеет полный доступ.
 */
export async function getAdminPermissions(
    env,
    telegramId
) {
    const access = await getBotAccess(
        env,
        telegramId
    );

    if (access.isOwner) {
        return ["*"];
    }

    if (!access.isAdmin || !access.user?.id) {
        return [];
    }

    const result = await env.DB
        .prepare(`
            SELECT permission
            FROM admin_permissions
            WHERE admin_id = ?
            ORDER BY permission ASC
        `)
        .bind(access.user.id)
        .all();

    return (result.results || []).map(
        row => row.permission
    );
}


/*
 * Проверка конкретного разрешения.
 *
 * ВАЖНО:
 * если у администратора нет записей в
 * admin_permissions, доступа у него НЕТ.
 */
export async function hasPermission(
    env,
    telegramId,
    permission
) {
    const user=await getTelegramUser(env,telegramId);
    return sharedPermission(env.DB,user,permission);
}


/*
 * Включить / выключить одно разрешение.
 *
 * Возвращает true, если право после операции
 * включено, и false, если выключено.
 */
export async function togglePermission(
    env,
    telegramId,
    permission
) {
    if (!env.DB) {
        throw new Error(
            "База данных недоступна"
        );
    }

    const access = await getBotAccess(
        env,
        telegramId
    );

    if (access.isOwner) {
        throw new Error(
            "Права владельца изменять нельзя"
        );
    }

    if (!access.isAdmin || !access.user?.id) {
        throw new Error(
            "Администратор не найден"
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
            access.user.id,
            permission
        )
        .first();

    if (existing) {
        await env.DB
            .prepare(`
                DELETE FROM admin_permissions
                WHERE admin_id = ?
                  AND permission = ?
            `)
            .bind(
                access.user.id,
                permission
            )
            .run();

        return false;
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
            access.user.id,
            permission
        )
        .run();

    return true;
}


/*
 * Выдать администратору все разрешения.
 *
 * Список разрешений берём здесь, чтобы
 * функция не зависела от интерфейса бота.
 */
export async function grantAllPermissions(
    env,
    telegramId
) {
    if (!env.DB) {
        throw new Error(
            "База данных недоступна"
        );
    }

    const access = await getBotAccess(
        env,
        telegramId
    );

    if (access.isOwner) {
        return true;
    }

    if (!access.isAdmin || !access.user?.id) {
        throw new Error(
            "Администратор не найден"
        );
    }

    const permissions = [
        "programs",
        "courses",
        "lessons",
        "students",
        "groups",
        "exams",
        "payments",
        "certificates",
        "competitions",
        "schedule"
    ];

    for (const permission of permissions) {
        await env.DB
            .prepare(`
                INSERT OR IGNORE INTO admin_permissions (
                    admin_id,
                    permission
                )
                VALUES (?, ?)
            `)
            .bind(
                access.user.id,
                permission
            )
            .run();
    }

    return true;
}


/*
 * Удалить все разрешения администратора.
 */
export async function revokeAllPermissions(
    env,
    telegramId
) {
    if (!env.DB) {
        throw new Error(
            "База данных недоступна"
        );
    }

    const access = await getBotAccess(
        env,
        telegramId
    );

    if (access.isOwner) {
        throw new Error(
            "Права владельца изменять нельзя"
        );
    }

    if (!access.user?.id) {
        throw new Error(
            "Администратор не найден"
        );
    }

    await env.DB
        .prepare(`
            DELETE FROM admin_permissions
            WHERE admin_id = ?
        `)
        .bind(access.user.id)
        .run();

    return true;
}
