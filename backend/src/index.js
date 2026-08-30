import { verifyTelegramInitData } from "./telegram.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

if (url.pathname === "/api/debug-config") {
    return json({
        ok: true,
        telegram_bot_token: !!env.TELEGRAM_BOT_TOKEN,
        database: !!env.DB,
        assets: !!env.ASSETS,
        app: env.APP_NAME || null
    });
}
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      // Проверка Worker + D1
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          app: env.APP_NAME || "RAUDA ILM",
          database: !!env.DB
        });
      }

      // Telegram authentication
      if (
        url.pathname === "/api/auth/telegram" &&
        request.method === "POST"
      ) {
        return await telegramAuth(request, env);
      }

      // Все остальные запросы отдаём frontend
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json(
        {
          ok: false,
          error: "Frontend assets are not configured"
        },
        500
      );

    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error: "Internal server error"
        },
        500
      );
    }
  }
};


async function telegramAuth(request, env) {
  if (!env.DB) {
    return json(
      {
        ok: false,
        error: "D1 database is not configured"
      },
      500
    );
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return json(
      {
        ok: false,
        error: "Telegram bot token is not configured"
      },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid JSON"
      },
      400
    );
  }

  const initData = body?.initData;

console.log("Telegram initData received:", !!initData);
console.log("Telegram initData length:", initData?.length || 0);

  if (!initData) {
    return json(
      {
        ok: false,
        error: "Telegram initData is required"
      },
      400
    );
  }

console.log("Bot token available:", !!env.TELEGRAM_BOT_TOKEN);
console.log("Bot token length:", env.TELEGRAM_BOT_TOKEN?.length || 0);

  const verification = await verifyTelegramInitData(
    initData,
    env.TELEGRAM_BOT_TOKEN
  );

  if (!verification.ok) {
    return json(
      {
        ok: false,
        error: verification.error
      },
      401
    );
  }

  const telegramUser = verification.user;
  const telegramId = Number(telegramUser.id);

  if (!Number.isSafeInteger(telegramId)) {
    return json(
      {
        ok: false,
        error: "Invalid Telegram user ID"
      },
      400
    );
  }

  const username = telegramUser.username || null;
  const firstName = telegramUser.first_name || null;
  const lastName = telegramUser.last_name || null;

  let user = await env.DB
    .prepare(`
      SELECT
        id,
        telegram_id,
        username,
        first_name,
        last_name,
        phone,
        role,
        status,
        blocked_reason,
        blocked_at,
        created_at,
        updated_at
      FROM users
      WHERE telegram_id = ?
    `)
    .bind(telegramId)
    .first();

  if (!user) {
    const result = await env.DB
      .prepare(`
        INSERT INTO users (
          telegram_id,
          username,
          first_name,
          last_name,
          role,
          status
        )
        VALUES (?, ?, ?, ?, 'student', 'active')
      `)
      .bind(
        telegramId,
        username,
        firstName,
        lastName
      )
      .run();

    user = await env.DB
      .prepare(`
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          phone,
          role,
          status,
          blocked_reason,
          blocked_at,
          created_at,
          updated_at
        FROM users
        WHERE id = ?
      `)
      .bind(result.meta.last_row_id)
      .first();

  } else {

    await env.DB
      .prepare(`
        UPDATE users
        SET
          username = ?,
          first_name = ?,
          last_name = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        username,
        firstName,
        lastName,
        user.id
      )
      .run();

    user = await env.DB
      .prepare(`
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          phone,
          role,
          status,
          blocked_reason,
          blocked_at,
          created_at,
          updated_at
        FROM users
        WHERE id = ?
      `)
      .bind(user.id)
      .first();
  }

  if (!user) {
    return json(
      {
        ok: false,
        error: "User could not be created"
      },
      500
    );
  }

  if (user.status === "blocked") {
    return json(
      {
        ok: false,
        error: "USER_BLOCKED",
        message: "Доступ к аккаунту заблокирован.",
        user: safeUser(user)
      },
      403
    );
  }

  if (user.status === "restricted") {
    return json({
      ok: true,
      restricted: true,
      user: safeUser(user)
    });
  }

  return json({
    ok: true,
    restricted: false,
    user: safeUser(user)
  });
}


function safeUser(user) {
  return {
    id: user.id,
    telegram_id: user.telegram_id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    phone: user.phone,
    role: user.role,
    status: user.status,
    blocked_reason: user.blocked_reason,
    blocked_at: user.blocked_at,
    created_at: user.created_at
  };
}


function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders()
      }
    }
  );
}