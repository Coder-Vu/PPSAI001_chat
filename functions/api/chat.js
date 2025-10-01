// functions/api/chat.js
// NOTE: Đồng bộ với index.html (stream & non-stream), giữ cookie phiên, passthrough headers.
// UPDATED: thêm OPTIONS (CORS) + GET (healthcheck), forward query (trừ stream), giữ tương thích env key.

import { getAuthCookie, unauthorized, setAuthCookie, envPick } from "./_util.js";

// Preflight cho CORS (nếu cần)
export async function onRequestOptions() {
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

// Healthcheck đơn giản
export async function onRequestGet({ request }) {
  if (getAuthCookie(request) !== "1") return unauthorized();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
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
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const method = (envPick(env, ["N8N_METHOD", "N8n_method"]) || "POST").toUpperCase();

  const reqUrl = new URL(request.url);
  const isStream =
    reqUrl.pathname.endsWith("/stream") || reqUrl.searchParams.get("stream") === "1";

  // Build upstream URL + forward query (loại stream cờ nội bộ)
  const upstreamUrl = new URL(urlBase);
  reqUrl.searchParams.forEach((v, k) => {
    if (k === "stream") return;
    upstreamUrl.searchParams.set(k, v);
  });

  // Chuẩn bị headers forward
  const headers = new Headers();

  // Authorization Bearer (đảm bảo tương thích các biến env cũ/typo)
  const bearer = envPick(env, ["N8N_BEARER", "N8n_bearer", "N8n_beare", "n8n_bearer"]);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

  // Header tùy biến
  const hName = envPick(env, ["N8N_HEADER_NAME", "N8n_header_name", "n8n_header_name"]);
  const hVal  = envPick(env, ["N8N_HEADER_VALUE", "N8n_header_value", "n8n_header_value"]);
  if (hName && hVal) headers.set(hName, hVal);

  // Forward Accept để n8n quyết định SSE/NDJSON/JSON chính xác
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept); // UPDATED: áp dụng cho cả stream & non-stream

  // ---------- STREAMING PASSTHROUGH ----------
  if (isStream) {
    const bodyText = await request.text();
    headers.set("content-type", "application/json"); // payload {sessionId, chatInput}

    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: "POST", // stream webhook dùng POST
        headers,
        body: bodyText,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: "upstream fetch error", detail: String(err) }),
        { status: 502, headers: { "content-type": "application/json",
                                   "access-control-allow-origin": "*" } }
      );
    }

    const refreshCookie = setAuthCookie("1", 30 * 60);

    const respHeaders = new Headers();
    respHeaders.set("content-type", upstream.headers.get("content-type") || "text/event-stream");
    respHeaders.set("cache-control", "no-cache");
    respHeaders.set("connection", "keep-alive");
    respHeaders.set("x-accel-buffering", "no");
    respHeaders.set("Set-Cookie", refreshCookie);
    respHeaders.set("access-control-allow-origin", "*");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  }

  // ---------- NON-STREAM (trả một lần) ----------
  let upstream;
  try {
    if (method === "POST") {
      const bodyText = await request.text();
      headers.set("content-type", "application/json");
      upstream = await fetch(upstreamUrl.toString(), {
        method: "POST",
        headers,
        body: bodyText,
      });
    } else {
      upstream = await fetch(upstreamUrl.toString(), { method: "GET", headers });
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: "upstream fetch error", detail: String(err) }),
      { status: 502, headers: { "content-type": "application/json",
                                 "access-control-allow-origin": "*" } }
    );
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";
  const refreshCookie = setAuthCookie("1", 30 * 60);

  const respHeaders = new Headers();
  respHeaders.set("content-type", contentType);
  respHeaders.set("Set-Cookie", refreshCookie);
  respHeaders.set("access-control-allow-origin", "*");

  return new Response(text, {
    status: upstream.status,
    headers: respHeaders,
  });
}
