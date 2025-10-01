import { getAuthCookie, unauthorized, setAuthCookie, envPick } from "./_util.js";

export async function onRequestOptions() {
  // UPDATED: Trả preflight CORS (nếu bạn gọi từ domain khác / Cloudflare Pages)
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400",
    },
  });
}

export async function onRequestGet({ request }) {
  // UPDATED: Healthcheck đơn giản cho GET /api/chat
  if (getAuthCookie(request) !== "1") return unauthorized();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  if (getAuthCookie(request) !== "1") return unauthorized();

  const urlBase = envPick(env, [
    "N8N_WEBHOOK_URL",
    "N8n_webhook_url",
    "n8n_webhook_url",
  ]);
  if (!urlBase) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing N8N_WEBHOOK_URL" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }

  const method = (
    envPick(env, ["N8N_METHOD", "N8n_method"]) || "POST"
  ).toUpperCase();

  const reqUrl = new URL(request.url);
  // UPDATED: Xác định stream từ path hoặc query (?stream=1)
  const isStream =
    reqUrl.pathname.endsWith("/stream") || reqUrl
