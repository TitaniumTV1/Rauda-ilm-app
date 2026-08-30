export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Проверка работы сервера
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        app: "RAUDA ILM",
        message: "Backend работает"
      });
    }

    // Главная API-точка
    if (url.pathname === "/api") {
      return Response.json({
        ok: true,
        app: "RAUDA ILM",
        version: "1.0.0"
      });
    }

    return new Response("RAUDA ILM API", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
};
