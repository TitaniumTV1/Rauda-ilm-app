import { HttpError } from "./school-core.js";

/*
 * Tribute subscriptions compatibility module.
 * Существующие файлы проекта не изменяются.
 */

export async function getSubscriptionOffers(env, user, channel = "web") {
  return [];
}

export async function createSubscriptionCheckout(env, user, input = {}) {
  throw new HttpError(
    404,
    "Подписки Tribute пока не настроены"
  );
}

export async function handleTributeSubscriptionRequest(request, env, ctx) {
  return null;
}