import { first, all, hasPermission, HttpError } from "./school-core.js";
import {
  getSchoolSettings,
  listOffers,
  createOrder,
  ensureCommerceSchema,
} from "./commerce.js";
import {
  ensureLearningSchema,
  listLearningGroups,
  listLearningExams,
  listLearningCertificates,
} from "./learning.js";
import {
  getSubscriptionOffers,
  createSubscriptionCheckout,
} from "./tribute-subscriptions.js";
import { handleLearningBot } from "./telegram-learning.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c],
  );
const sections = {
  admin_groups: ["groups", "Группы", "groups"],
  admin_exams: ["exams", "Экзамены", "exams"],
  admin_certificates: ["certificates", "Сертификаты", "certificates"],
  admin_stats: ["stats", "Статистика", "overview"],
  admin_payments: ["payments", "Платежи", "payments"],
  admin_settings: ["settings", "Настройки школы", "settings"],
};
const textMap = {
  "👨‍👩‍👧‍👦 Группы": "admin_groups",
  "📝 Экзамены": "admin_exams",
  "📜 Сертификаты": "admin_certificates",
  "📊 Статистика": "admin_stats",
  "💳 Оплата": "admin_payments",
  "⚙️ Настройки школы": "admin_settings",
};
const money = (row) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: row.currency,
  }).format(row.amount_minor / 100);
const requestKey = (update) =>
  "tg_" +
  String(update.callback_query?.id || "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .padStart(16, "0")
    .slice(0, 60);
function appUrl(env, settings, path = "/") {
  try {
    const url = new URL(
      settings.public_app_url || env.PUBLIC_APP_URL || env.CORS_ORIGIN,
    );
    if (url.protocol !== "https:") return null;
    return new URL(path, url.origin).href;
  } catch {
    return null;
  }
}

export async function handleSchoolBot(env, update, user, send) {
  const chatId = user.telegram_id;
  const text = String(update.message?.text || "").trim();
  const data = String(update.callback_query?.data || textMap[text] || "");
  if (
    text === "/learn" ||
    text === "📖 Мои уроки" ||
    text === "📚 Программа курса" ||
    data === "program"
  ) {
    return handleLearningBot(
      env,
      {
        ...update,
        message: {
          ...update.message,
          chat: { id: chatId, type: "private" },
          from: { id: chatId },
          text: "/learn",
        },
      },
      user,
      send,
    );
  }
  if (await handleLearningBot(env, update, user, send)) return true;
  if (text === "/terms") {
    const settings = await getSchoolSettings(env.DB);
    const url = text === "/terms" ? settings.terms_url : settings.support_url;
    await send(
      env,
      chatId,
      url ? escape(url) : "Обратитесь в раздел «Поддержка» главного меню.",
    );
    return true;
  }
  if (text === "🌐 Мой кабинет") {
    const url = appUrl(env, await getSchoolSettings(env.DB));
    if (!url)
      throw new HttpError(503, "Владелец ещё не настроил адрес кабинета.");
    await send(
      env,
      chatId,
      "Уроки и прогресс в вашем кабинете. Для общего аккаунта войдите через Telegram или привяжите Telegram в профиле сайта.",
      { inline_keyboard: [[{ text: "Открыть кабинет", url }]] },
    );
    return true;
  }
  const buy = data.match(/^school:(buy|sub):([a-f0-9-]{36})$/);
  if (buy) {
    // The provider's external browser checkout, not a Telegram invoice.
    const input = { channel: "web", request_key: requestKey(update) };
    const checkout =
      buy[1] === "sub"
        ? await createSubscriptionCheckout(env, user, { ...input, id: buy[2] })
        : await createOrder(env, user, {
            ...input,
            offer_id: buy[2],
            provider: "tribute",
          });
    await send(
      env,
      chatId,
      "Оплата картой проходит на веб-странице Tribute. Откройте её в браузере и используйте тот же Telegram-аккаунт. После подтверждения платежа доступ появится в «Мои уроки».",
      {
        inline_keyboard: [
          [
            {
              text: "Открыть оплату картой в браузере",
              url: checkout.confirmation_url,
            },
          ],
          [
            { text: "Мои уроки", callback_data: "learn:home" },
            { text: "Мои группы", callback_data: "learn:groups" },
          ],
          [{ text: "Назад к тарифам", callback_data: "order" }],
        ],
      },
    );
    return true;
  }
  if (
    text === "🛒 Оформить заказ" ||
    data === "order" ||
    data.startsWith("order_pay") ||
    data.startsWith("school:offers:")
  ) {
    const settings = await getSchoolSettings(env.DB);
    const [offers, subscriptions] = await Promise.all([
      listOffers(env, user, "web"),
      getSubscriptionOffers(env, user, "web"),
    ]);
    const oneTime = offers.filter((o) => o.providers.includes("tribute"));
    const kind =
      data === "school:offers:groups"
        ? "groups"
        : data === "school:offers:once"
          ? "once"
          : null;
    const keyboard = [];
    if (!kind) {
      if (oneTime.length)
        keyboard.push([
          {
            text: "Разовая оплата обучения",
            callback_data: "school:offers:once",
          },
        ]);
      if (subscriptions.length)
        keyboard.push([
          {
            text: "Подписка на группу / канал",
            callback_data: "school:offers:groups",
          },
        ]);
    } else {
      const rows = kind === "groups" ? subscriptions : oneTime;
      for (const row of rows.slice(0, 40))
        keyboard.push([
          {
            text: row.name.slice(0, 45) + " · " + money(row),
            callback_data:
              "school:" + (kind === "groups" ? "sub" : "buy") + ":" + row.id,
          },
        ]);
      keyboard.push([{ text: "Все способы обучения", callback_data: "order" }]);
    }
    const cabinet = appUrl(env, settings, "/#payments");
    if (cabinet)
      keyboard.push([{ text: "Все тарифы и история на сайте", url: cabinet }]);
    if (settings.terms_url)
      keyboard.push([{ text: "Условия обучения", url: settings.terms_url }]);
    const available =
      kind === "groups"
        ? subscriptions.length
        : kind === "once"
          ? oneTime.length
          : oneTime.length + subscriptions.length;
    await send(
      env,
      chatId,
      available
        ? (kind === "groups"
            ? "Подписка на группу / канал"
            : kind === "once"
              ? "Разовая оплата обучения"
              : "Оплата и доступ") +
            "\nВыберите тариф. Сумма указана в валюте оплаты картой. Условия и срок доступа — на странице выбранного тарифа."
        : "Сейчас нет опубликованных тарифов этого вида. Владелец может подключить их в разделе «Платежи» админки. Обратитесь в поддержку.",
      { inline_keyboard: keyboard },
    );
    return true;
  }
  // Preserve native student search, course editing and staff management.
  const section =
    sections[data] ||
    (/^admin_(?:payment|price|tribute)/.test(data)
      ? sections.admin_payments
      : null);
  if (!section) return false;
  if (!(await hasPermission(env.DB, user, section[0])))
    throw new HttpError(403, "Нет разрешения на этот раздел");
  await ensureCommerceSchema(env.DB);
  await ensureLearningSchema(env.DB);
  const settings = await getSchoolSettings(env.DB);
  const lines = ["<b>" + section[1] + "</b>", ""];
  const scopes =
    user.role === "admin"
      ? await all(
          env.DB,
          "SELECT course_id FROM admin_courses WHERE admin_id=?",
          [user.id],
        )
      : [];
  const scoped = (rows) =>
    scopes.length
      ? rows.filter((r) =>
          scopes.some((s) => Number(s.course_id) === Number(r.course_id)),
        )
      : rows;
  let rows = [];
  if (section[0] === "groups")
    rows = await listLearningGroups(env.DB, user, true);
  if (section[0] === "exams")
    rows = await listLearningExams(env.DB, user, true);
  if (section[0] === "certificates")
    rows = await listLearningCertificates(env.DB, user, true);
  if (section[0] === "payments") {
    const orders = await all(
      env.DB,
      "SELECT id,status,amount_minor,currency,snapshot_json FROM school_orders ORDER BY created_at DESC",
    );
    rows = scoped(
      orders.map((r) => ({
        ...r,
        course_id: JSON.parse(r.snapshot_json).course_id,
      })),
    );
    lines.push(
      "Разовые платежи и подписки на группы настраиваются отдельно.",
      "",
    );
  }
  for (const row of rows.slice(0, 10))
    lines.push(
      escape(
        (row.name || row.title || row.certificate_name || row.id) +
          (row.amount_minor ? " · " + money(row) : "") +
          (row.status ? " · " + row.status : "") +
          (row.member_count !== undefined
            ? " · участников: " + row.member_count
            : ""),
      ),
    );
  if (section[0] === "settings") {
    lines.push(
      "Название: " + escape(settings.school_name || "RAUDA ILM"),
      "Приём платежей: " + (settings.payments_enabled ? "включён" : "выключен"),
      "Цены, тарифы, ссылки, тексты и способы оплаты меняются в панели школы.",
    );
  } else if (section[0] === "stats") {
    const courses = scoped(
      await all(env.DB, "SELECT id AS course_id FROM courses"),
    );
    lines.push("Доступных курсов: " + courses.length);
    if (!scopes.length)
      lines.push(
        "Учеников: " +
          (
            await first(
              env.DB,
              "SELECT COUNT(*) AS n FROM users WHERE role='student'",
            )
          ).n,
      );
  } else if (!rows.length) lines.push("Записей пока нет.");
  const url = appUrl(env, settings, "/admin/#" + section[2]);
  const keyboard = [[{ text: "Назад в управление", callback_data: "admin" }]];
  if (url) {
    keyboard.unshift([{ text: "Открыть: " + section[1], url }]);
    lines.push(
      "",
      "Поиск, создание, редактирование и подробная история — в этом разделе панели школы.",
    );
  } else
    lines.push(
      "",
      "Для открытия редактора владелец должен настроить адрес сайта.",
    );
  await send(env, chatId, lines.join("\n"), { inline_keyboard: keyboard });
  return true;
}
