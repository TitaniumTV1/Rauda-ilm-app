(() => {
  "use strict";

  const providerNames = { tribute: "Tribute", yoomoney: "ЮMoney" };
  let adminUser = null;
  let adminRequest = null;
  let adminLoading = false;
  let catalogueRequest = 0;
  let studentIdentity = null;
  const orders = new Map();

  function element(tag, text = "", className = "") {
    const item = document.createElement(tag);
    if (text !== "") item.textContent = String(text);
    if (className) item.className = className;
    return item;
  }

  function status(parent) {
    const result = element("div", "", "rauda-payment-status");
    result.setAttribute("role", "status");
    result.setAttribute("aria-live", "polite");
    parent.append(result);
    return result;
  }

  function message(target, text, kind = "") {
    target.textContent = text;
    target.className = `rauda-payment-status ${kind}`;
  }

  function button(label, handler, secondary = false) {
    const result = element("button", label, `rauda-payment-button${secondary ? " secondary" : ""}`);
    result.type = "button";
    result.addEventListener("click", handler);
    return result;
  }

  function field(parent, label, value, options = {}) {
    const wrapper = element("label", "", "rauda-payment-field");
    wrapper.append(element("span", label));
    const input = element("input");
    input.type = options.type || "text";
    input.value = value == null ? "" : String(value);
    for (const key of ["min", "max", "step", "maxLength", "readOnly", "placeholder", "inputMode"]) {
      if (options[key] != null) input[key] = options[key];
    }
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function check(parent, label, value) {
    const wrapper = element("label", "", "rauda-payment-check");
    const input = element("input");
    input.type = "checkbox";
    input.checked = value === true || Number(value) === 1;
    wrapper.append(input, element("span", label));
    parent.append(wrapper);
    return input;
  }

  function price(value, currency = "RUB") {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency }).format(Number(value) || 0);
  }

  function validAmount(value, { whole = false, allowZero = false, maximum = 1000000 } = {}) {
    const normalized = String(value).trim().replace(",", ".");
    const pattern = whole ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;
    if (!pattern.test(normalized)) throw new Error(whole ? "Укажите цену целым числом рублей." : "Укажите сумму с точностью до двух знаков после запятой.");
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0) || amount > maximum) {
      throw new Error(`Сумма должна быть ${allowZero ? "от 0" : "больше 0"} и не больше ${maximum.toLocaleString("ru-RU")}.`);
    }
    return whole ? amount : Math.round(amount * 100);
  }

  function safeUrl(value, allowPaymentPath = false) {
    try {
      const url = new URL(String(value), location.origin);
      if (allowPaymentPath && url.origin === location.origin && /^\/api\/payments\/pay\/[A-Za-z0-9_-]+$/.test(url.pathname)) return url.href;
      if (url.protocol !== "https:" || url.username || url.password) return "";
      return url.href;
    } catch { return ""; }
  }

  function externalLink(text, url, className = "") {
    const link = element("a", text, className);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  async function request(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      credentials: "same-origin",
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Не удалось выполнить запрос. Попробуйте ещё раз.");
    return result;
  }

  function setupInstructions(parent, provider, integration = {}) {
    const ready = integration.secret_configured === true;
    parent.append(element("div", ready ? "Ключ для проверки оплаты настроен" : "Нужен ключ для проверки оплаты", `rauda-payment-readiness${ready ? " ready" : ""}`));
    const details = element("details", "", "rauda-payment-details");
    details.append(element("summary", `Как настроить ${providerNames[provider]}`));
    const steps = element("ol");
    const descriptions = provider === "tribute" ? [
      "Создайте отдельный товар Tribute для каждого семестра. Скопируйте готовую ссылку на товар и его числовой ID из данных товара Tribute (поле id в API) в настройки ниже. Короткий код в ссылке может отличаться от ID товара.",
      "Укажите валюту и точную сумму товара в Tribute. При изменении цены обновите её и в Tribute, и здесь.",
      "Подключите уведомления об оплате по адресу ниже. Ключ Tribute хранится в секретной настройке Worker TRIBUTE_API_KEY в Cloudflare.",
      "Включите Tribute и приём оплаты нужного семестра, затем сохраните настройки."
    ] : [
      "Укажите номер кошелька ЮMoney, на который школа принимает оплату.",
      "В настройках кошелька включите HTTP-уведомления и укажите адрес ниже.",
      `Секрет уведомлений сохраните в Cloudflare как секретную настройку Worker ${integration.env_name || "YOOMONEY_NOTIFICATION_SECRET"}.`,
      "Включите ЮMoney и приём оплаты нужного семестра. Стоимость берётся из цены семестра в рублях."
    ];
    for (const text of descriptions) steps.append(element("li", text));
    details.append(steps);
    if (typeof integration.webhook_path === "string" && integration.webhook_path.startsWith("/api/")) {
      field(details, "Адрес для уведомлений об оплате", `${location.origin}${integration.webhook_path}`, { readOnly: true });
    }
    const docs = safeUrl(integration.docs_url);
    if (docs) details.append(externalLink("Инструкция платёжного сервиса", docs));
    details.append(element("p", "Доступ к семестру открывается после подтверждения оплаты платёжным сервисом. Ключи и секреты не отображаются в приложении.", "rauda-payment-note"));
    parent.append(details);
  }

  async function saveAdmin(payload, target, control, successText) {
    if (adminUser?.role !== "owner") return;
    control.disabled = true;
    message(target, "Сохраняем…");
    try {
      await adminRequest("/api/admin/payment-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      message(target, successText, "success");
    } catch (error) {
      message(target, error.message || "Не удалось сохранить настройки.", "error");
    } finally { control.disabled = false; }
  }

  function renderAdmin(container, data) {
    container.replaceChildren();
    const settings = data.settings || {};
    const config = element("section", "", "rauda-payment-card");
    config.append(element("h3", "Способы оплаты"));
    const paymentsEnabled = check(config, "Принимать оплату в школе", settings.payments_enabled);
    config.append(element("p", "Общий переключатель действует для всех курсов и способов оплаты. Настройки ниже сохраняются, даже если приём оплаты выключен.", "rauda-payment-note"));
    const grid = element("div", "", "rauda-payment-grid");
    const tribute = element("div");
    tribute.append(element("h4", "Tribute"));
    const tributeEnabled = check(tribute, "Предлагать оплату через Tribute", settings.tribute_enabled);
    setupInstructions(tribute, "tribute", data.integration?.tribute);
    const yoomoney = element("div");
    yoomoney.append(element("h4", "ЮMoney"));
    const yoomoneyEnabled = check(yoomoney, "Предлагать оплату через ЮMoney", settings.yoomoney_enabled);
    const wallet = field(yoomoney, "Номер кошелька ЮMoney", settings.yoomoney_wallet, { placeholder: "4100…", maxLength: 20, inputMode: "numeric" });
    setupInstructions(yoomoney, "yoomoney", data.integration?.yoomoney);
    grid.append(tribute, yoomoney);
    config.append(grid);
    const configStatus = status(config);
    const saveConfig = button("Сохранить способы оплаты", async () => {
      const walletValue = wallet.value.trim();
      if ((walletValue && !/^4100\d{7,16}$/.test(walletValue)) || (yoomoneyEnabled.checked && !walletValue)) {
        message(configStatus, "Укажите номер кошелька ЮMoney: от 11 до 20 цифр, начинается с 4100.", "error");
        wallet.focus();
        return;
      }
      await saveAdmin({ settings: { payments_enabled: paymentsEnabled.checked, tribute_enabled: tributeEnabled.checked, yoomoney_enabled: yoomoneyEnabled.checked, yoomoney_wallet: walletValue } }, configStatus, saveConfig, "Способы оплаты сохранены.");
    });
    config.append(saveConfig);
    container.append(config);
    const heading = element("div");
    heading.append(element("h3", "Оплата конкретного семестра"), element("p", "Ученику открывается оплаченный семестр. Для каждого семестра настройте цену и товар Tribute.", "rauda-payment-note"));
    container.append(heading);
    const semesters = Array.isArray(data.semesters) ? data.semesters : [];
    if (!semesters.length) container.append(element("p", "Семестров пока нет. Создайте семестр в разделе «Курсы» в Telegram-боте.", "rauda-payment-note"));
    for (const semester of semesters) renderAdminSemester(container, semester);
  }

  function renderAdminSemester(container, semester) {
    const id = Number(semester.id);
    if (!Number.isSafeInteger(id) || id < 1) return;
    const card = element("section", "", "rauda-payment-card");
    card.append(element("div", semester.course_name || "Курс", "rauda-payment-note"), element("h4", semester.name || `Семестр ${id}`));
    const enabled = check(card, "Принимать оплату этого семестра", semester.payment_enabled);
    const tributeEnabled = check(card, "Разрешить Tribute для этого семестра", semester.tribute_enabled);
    const yoomoneyEnabled = check(card, "Разрешить ЮMoney для этого семестра", semester.yoomoney_enabled);
    const fields = element("div", "", "rauda-payment-grid");
    const rubPrice = field(fields, "Цена семестра, ₽", semester.price_rub ?? 0, { type: "number", min: "0", max: "1000000", step: "1" });
    const productId = field(fields, "ID товара Tribute (число)", semester.tribute_product_id, { inputMode: "numeric", maxLength: 30, placeholder: "Например: 2548" });
    const productUrl = field(fields, "Ссылка на оплату Tribute", semester.tribute_payment_url, { type: "url", maxLength: 500, placeholder: "https://t.me/tribute_bot/app?startapp=pf6" });
    const currencyLabel = element("label", "", "rauda-payment-field");
    currencyLabel.append(element("span", "Валюта товара в Tribute"));
    const currency = element("select");
    currency.setAttribute("aria-label", "Валюта товара в Tribute");
    for (const [code, label] of [["RUB", "Рубли (RUB)"], ["EUR", "Евро (EUR)"], ["USD", "Доллары (USD)"]]) {
      const option = element("option", label);
      option.value = code;
      currency.append(option);
    }
    currency.value = ["RUB", "EUR", "USD"].includes(semester.tribute_currency) ? semester.tribute_currency : "RUB";
    currencyLabel.append(currency);
    fields.append(currencyLabel);
    const tributeAmount = field(fields, "Сумма товара в Tribute", semester.tribute_amount_minor ? (Number(semester.tribute_amount_minor) / 100).toFixed(2) : "", { type: "number", min: "0.01", max: "1000000", step: "0.01", placeholder: "Точная сумма из Tribute" });
    card.append(fields, element("p", "Ссылка, ID, сумма и валюта должны относиться к одному товару Tribute. Например, у товара с ID 2548 может быть ссылка https://t.me/tribute_bot/app?startapp=pf6 или https://web.tribute.tg/p/f6. Используйте готовую ссылку своего товара. Для оплаты только через ЮMoney поля Tribute можно оставить пустыми. Нулевая цена отключает онлайн-оплату семестра.", "rauda-payment-note"));
    const result = status(card);
    const save = button("Сохранить семестр", async () => {
      try {
        const priceRub = validAmount(rubPrice.value, { whole: true, allowZero: true });
        const tributeId = productId.value.trim();
        const tributeUrl = productUrl.value.trim();
        const hasTribute = Boolean(tributeId || tributeUrl || tributeAmount.value.trim());
        if (hasTribute && (!/^\d+$/.test(tributeId) || Number(tributeId) <= 0 || !safeUrl(tributeUrl))) throw new Error("Для Tribute укажите числовой ID товара, готовую ссылку и точную сумму.");
        const minor = hasTribute ? validAmount(tributeAmount.value) : 0;
        await saveAdmin({ semesters: [{ id, price_rub: priceRub, payment_enabled: enabled.checked, tribute_enabled: tributeEnabled.checked, yoomoney_enabled: yoomoneyEnabled.checked, tribute_product_id: tributeId, tribute_payment_url: tributeUrl, tribute_currency: currency.value, tribute_amount_minor: minor }] }, result, save, "Настройки семестра сохранены.");
      } catch (error) { message(result, error.message, "error"); }
    });
    card.append(save);
    container.append(card);
  }

  async function loadAdmin() {
    const container = document.getElementById("ownerPaymentSettings");
    if (!container || adminUser?.role !== "owner" || !adminRequest || adminLoading) return;
    adminLoading = true;
    container.replaceChildren(element("p", "Загружаем настройки оплаты…"));
    try {
      const data = await adminRequest("/api/admin/payment-settings");
      if (adminUser?.role === "owner") renderAdmin(container, data);
    } catch (error) {
      container.replaceChildren(element("p", error.message, "rauda-payment-status error"), button("Повторить загрузку", loadAdmin, true));
    } finally { adminLoading = false; }
  }

  function initAdmin(user, apiFunction) {
    adminUser = user;
    adminRequest = apiFunction;
    const tab = document.getElementById("ownerPaymentsTab");
    if (tab) tab.hidden = user?.role !== "owner";
    if (user?.role !== "owner") document.getElementById("ownerPaymentSettings")?.replaceChildren();
    else if (location.hash === "#payments" && typeof window.switchAdminTab === "function") window.switchAdminTab("payments");
  }

  async function renderOptions(card, semester) {
    const methods = element("div");
    const output = status(methods);
    card.append(methods);
    message(output, "Загружаем способы оплаты…");
    try {
      const data = await request(`/payments/options?semester_id=${encodeURIComponent(semester.id)}`);
      if (!card.isConnected) return;
      methods.replaceChildren();
      if (data.access_granted) {
        methods.append(element("p", "Доступ к семестру открыт. Учебные материалы доступны в Telegram-боте.", "rauda-payment-status success"));
        return;
      }
      if (!data.telegram_linked) {
        methods.append(element("p", "Чтобы получать ссылку и подтверждение в чате, привяжите Telegram в профиле и откройте бота кнопкой «Начать».", "rauda-payment-note"));
        methods.append(button("Открыть профиль", () => { if (typeof window.openProfile === "function") window.openProfile(); }, true));
      } else {
        methods.append(element("p", "Ссылка на оплату придёт в Telegram. После подтверждения оплаты бот сообщит об открытии семестра.", "rauda-payment-note"));
      }
      const actions = element("div", "", "rauda-payment-actions");
      const orderArea = element("div", "", "rauda-payment-order");
      orderArea.hidden = true;
      const methodsData = Array.isArray(data.options) ? data.options : [];
      const controls = [];
      for (const provider of ["tribute", "yoomoney"]) {
        const option = methodsData.find(item => item.provider === provider);
        const pay = button(providerNames[provider], async () => {
          controls.forEach(control => { control.disabled = true; });
          orderArea.hidden = false;
          orderArea.replaceChildren(element("p", "Готовим ссылку на оплату…"));
          try {
            const checkout = await request("/payments/checkout", { method: "POST", body: JSON.stringify({ semester_id: Number(semester.id), provider }) });
            orders.set(Number(semester.id), checkout.order);
            renderOrder(orderArea, checkout.order, () => renderOptionsAfterPayment(methods, semester));
          } catch (error) {
            orderArea.replaceChildren(element("p", error.message, "rauda-payment-status error"));
          } finally {
            controls.forEach(control => { control.disabled = control.dataset.available !== "true"; });
          }
        });
        pay.dataset.available = String(option?.enabled === true);
        pay.disabled = option?.enabled !== true;
        controls.push(pay);
        actions.append(pay);
        if (option?.enabled !== true) methods.append(element("p", `${providerNames[provider]}: ${option?.reason || "оплата пока не настроена"}`, "rauda-payment-note"));
        else if (Number(option.amount) > 0 && ["RUB", "EUR", "USD"].includes(option.currency)) methods.append(element("p", `${providerNames[provider]} — ${price(option.amount, option.currency)}`, "rauda-payment-note"));
      }
      methods.append(actions, orderArea);
      const existing = orders.get(Number(semester.id));
      if (existing) {
        orderArea.hidden = false;
        renderOrder(orderArea, existing, () => renderOptionsAfterPayment(methods, semester));
      }
    } catch (error) {
      message(output, error.message, "error");
      methods.append(button("Повторить", () => { methods.remove(); renderOptions(card, semester); }, true));
    }
  }

  function renderOptionsAfterPayment(methods, semester) {
    orders.delete(Number(semester.id));
    methods.replaceChildren(element("p", "Оплата подтверждена. Семестр открыт. Учебные материалы доступны в Telegram-боте.", "rauda-payment-status success"));
  }

  function renderOrder(container, order, onPaid) {
    container.replaceChildren();
    if (!order || typeof order.order_uid !== "string") {
      container.append(element("p", "Не удалось получить заказ. Обновите способы оплаты.", "rauda-payment-status error"));
      return;
    }
    const orderStatus = String(order.status);
    if (orderStatus === "paid") { onPaid(); return; }
    if (["refunded", "rejected"].includes(orderStatus)) {
      container.append(element("p", orderStatus === "refunded" ? "Оплата возвращена. За новым доступом обратитесь в поддержку бота." : "Платёж не подтверждён. Обратитесь в поддержку бота.", "rauda-payment-status error"));
      return;
    }
    container.append(element("h4", "Ожидаем подтверждение оплаты"));
    const orderCurrency = ["RUB", "EUR", "USD"].includes(order.currency) ? order.currency : "RUB";
    container.append(element("p", `${providerNames[order.provider] || "Оплата"} · ${price(order.amount ?? order.amount_rub, orderCurrency)}`, "rauda-payment-note"));
    container.append(element("p", order.telegram_sent ? "Ссылка на оплату отправлена в Telegram. Её также можно открыть здесь." : "Ссылка готова. Отправить её в Telegram пока не удалось; открыть оплату можно здесь.", "rauda-payment-note"));
    const actions = element("div", "", "rauda-payment-actions");
    const url = safeUrl(order.payment_url, true);
    if (url) actions.append(externalLink("Перейти к оплате", url, "rauda-payment-button"));
    const result = status(container);
    const refresh = button("Проверить оплату", async () => {
      refresh.disabled = true;
      message(result, "Проверяем оплату…");
      try {
        const data = await request(`/payments/orders/${encodeURIComponent(order.order_uid)}`);
        orders.set(Number(order.semester_id), data.order);
        if (data.order.status === "pending") message(result, "Подтверждение ещё не поступило. Если вы уже оплатили, проверьте чуть позже.");
        else renderOrder(container, data.order, onPaid);
      } catch (error) { message(result, error.message, "error"); }
      finally { refresh.disabled = false; }
    }, true);
    actions.append(refresh);
    container.append(actions);
  }

  async function loadCatalogue(containerId = "studentPaymentCatalog", courseId = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const sequence = ++catalogueRequest;
    container.dataset.request = String(sequence);
    container.replaceChildren(element("p", "Загружаем семестры…", "rauda-payment-note"));
    try {
      const data = await request("/payments/catalog");
      if (container.dataset.request !== String(sequence)) return;
      container.replaceChildren();
      const courses = (Array.isArray(data.courses) ? data.courses : []).filter(course => courseId == null || Number(course.id) === Number(courseId));
      let count = 0;
      for (const course of courses) {
        for (const semester of Array.isArray(course.semesters) ? course.semesters : []) {
          if (!Number.isSafeInteger(Number(semester.id)) || Number(semester.id) < 1) continue;
          count++;
          const card = element("section", "", "rauda-payment-card");
          card.append(element("div", course.name || "Курс", "rauda-payment-note"), element("h3", semester.name || `Семестр ${semester.id}`), element("div", Number(semester.price_rub) > 0 ? price(semester.price_rub) : "Цена пока не указана", "rauda-payment-price"));
          container.append(card);
          if (semester.access_granted) card.append(element("p", "Доступ к семестру открыт. Учебные материалы доступны в Telegram-боте.", "rauda-payment-status success"));
          else {
            const choose = button("Выбрать способ оплаты", () => { choose.remove(); renderOptions(card, semester); }, true);
            card.append(choose);
          }
        }
      }
      if (!count) container.append(element("p", "Семестры для оплаты пока не добавлены. Новости обучения и связь с администратором — в Telegram-боте.", "rauda-payment-note"));
    } catch (error) {
      if (container.dataset.request !== String(sequence)) return;
      container.replaceChildren(element("p", error.message, "rauda-payment-status error"), button("Повторить загрузку", () => loadCatalogue(containerId, courseId), true));
    }
  }

  function openPayments() {
    if (typeof window.closeMenu === "function") window.closeMenu();
    if (typeof window.showScreen === "function") window.showScreen("paymentsScreen");
    loadCatalogue();
  }

  function initStudent(user) {
    const identity = user?.id == null ? null : String(user.id);
    if (identity !== studentIdentity) {
      orders.clear();
      for (const id of ["studentPaymentCatalog", "coursePaymentCatalog"]) document.getElementById(id)?.replaceChildren();
    }
    studentIdentity = identity;
    const ownerLink = document.getElementById("studentOwnerPaymentsLink");
    if (ownerLink) ownerLink.hidden = user?.role !== "owner";
  }

  window.RaudaPayments = { initAdmin, initStudent, loadAdmin, loadCatalogue, openPayments };
})();
