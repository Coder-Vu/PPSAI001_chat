import { getAuthCookie, unauthorized, setAuthCookie, envPick } from "./_util.js";

export async function onRequestPost({ request, env }) {
  if (getAuthCookie(request) !== "1") return unauthorized();

  const url = envPick(env, [
    "N8N_WEBHOOK_URL",
    "N8n_webhook_url",
    "n8n_webhook_url",
  ]);
  if (!url) {
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
  const headers = new Headers();

  // 1) Authorization: Bearer <token> (nếu có)
  const bearer = envPick(env, ["N8N_BEARER", "N8n_bearer", "N8n_beare"]);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

  // 2) Header tuỳ biến (nếu webhook yêu cầu)
  const hName = envPick(env, ["N8N_HEADER_NAME", "N8n_header_name"]);
  const hVal = envPick(env, ["N8N_HEADER_VALUE", "N8n_header_value"]);
  if (hName && hVal) headers.set(hName, hVal);

  // Kiểm tra nếu là endpoint /api/chat/stream thì passthrough stream JSON
  const urlPath = new URL(request.url).pathname;
  const isStream = urlPath.endsWith("/stream");

  if (isStream) {
    const bodyText = await request.text();
    headers.set("content-type", "application/json");

    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: bodyText,
    });

    const refreshCookie = setAuthCookie("1", 30 * 60);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "Set-Cookie": refreshCookie,
      },
    });
  }

  // Non-stream (mặc định JSON, full response)
  let upstream;
  if (method === "POST") {
    const bodyText = await request.text();
    headers.set("content-type", "application/json");
    upstream = await fetch(url, { method: "POST", headers, body: bodyText });
  } else {
    upstream = await fetch(url, { method: "GET", headers });
  }

  const text = await upstream.text();
  const contentType =
    upstream.headers.get("content-type") || "application/json";
  const refreshCookie = setAuthCookie("1", 30 * 60);

  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "Set-Cookie": refreshCookie,
    },
  });
}
