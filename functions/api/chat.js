// chat.js
import { getAuthCookie, unauthorized, setAuthCookie, envPick } from "./_util.js";

export async function onRequestPost({ request, env }) {
  // Yêu cầu đã đăng nhập (cookie do /api/login đặt)
  if (getAuthCookie(request) !== "1") return unauthorized();

  // Lấy URL webhook N8N từ env (hỗ trợ nhiều key để tránh sai chính tả)
  const url = envPick(env, ["N8N_WEBHOOK_URL", "N8n_webhook_url", "n8n_webhook_url"]);
  if (!url) {
    return new Response(JSON.stringify({ ok: false, error: "missing N8N_WEBHOOK_URL" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // Cho phép override method qua ENV (mặc định POST)
  const method = (envPick(env, ["N8N_METHOD", "N8n_method"]) || "POST").toUpperCase();

  // Chuẩn bị header forward lên N8N
  const headers = new Headers();

  // 1) Authorization: Bearer <token> nếu có
  const bearer = envPick(env, ["N8N_BEARER", "N8n_bearer", "N8n_beare"]);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

  // 2) Header tuỳ biến nếu webhook yêu cầu (tên + giá trị)
  const hName = envPick(env, ["N8N_HEADER_NAME", "N8n_header_name"]);
  const hVal  = envPick(env, ["N8N_HEADER_VALUE", "N8n_header_value"]);
  if (hName && hVal) headers.set(hName, hVal);

  // 3) Forward Accept từ client nếu có (để N8N có thể chọn SSE/NDJSON phù hợp)
  try {
    const accept = request.headers.get("accept");
    if (accept) headers.set("Accept", accept);
  } catch {}

  // Xác định chế độ stream:
  // - /api/chat/stream
  // - /api/chat?stream=1 (hoặc stream=true)
  const reqUrl = new URL(request.url);
  const urlPath = reqUrl.pathname;
  const urlSearch = reqUrl.search.toLowerCase();
  const isStream =
    urlPath.endsWith("/stream") ||
    urlSearch.includes("stream=1") ||
    urlSearch.includes("stream=true");

  if (isStream) {
    // -------- STREAMING MODE (SSE/NDJSON giữ nguyên) --------
    const bodyText = await request.text(); // đọc text để tránh body lock
    headers.set("content-type", "application/json");

    let upstream;
    try {
      upstream = await fetch(url, { method: "POST", headers, body: bodyText });
    } catch (e) {
      return new Response(`Upstream error: ${e?.message || e}`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Gia hạn cookie phiên
    const refreshCookie = setAuthCookie("1", 30 * 60);

    // Giữ nguyên content-type từ upstream: text/event-stream | application/x-ndjson | text/plain | application/json
    // Nếu trống, default là event-stream để client đọc theo dòng được.
    const upstreamCT =
      upstream.headers.get("content-type") ||
      "text/event-stream; charset=utf-8";

    // Một số proxy thích hợp để nói "đừng buffer"
    const extraHeaders = {
      "content-type": upstreamCT,
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "Set-Cookie": refreshCookie,
      // "X-Accel-Buffering": "no", // bật nếu cần với Nginx, CF không dùng
    };

    // Trả thẳng body stream về client
    return new Response(upstream.body, {
      status: upstream.status,
      headers: extraHeaders,
    });
  }

  // -------- NON-STREAM (trả một lần) --------
  let upstream;
  try {
    if (method === "POST") {
      const bodyText = await request.text();
      headers.set("content-type", "application/json");
      upstream = await fetch(url, { method: "POST", headers, body: bodyText });
    } else {
      upstream = await fetch(url, { method: "GET", headers });
    }
  } catch (e) {
    return new Response(`Upstream error: ${e?.message || e}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Đọc toàn bộ text (có thể là JSON chuẩn hoặc NDJSON/text)
  const text = await upstream.text();

  // Forward content-type từ upstream; default JSON
  const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";

  // Gia hạn cookie phiên
  const refreshCookie = setAuthCookie("1", 30 * 60);

  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "Set-Cookie": refreshCookie,
    },
  });
}

// (Tuỳ chọn) Nếu bạn muốn hỗ trợ cả GET cho healthcheck hay debug:
// export async function onRequestGet(ctx) {
//   return new Response(JSON.stringify({ ok: true, service: "chat-proxy" }), {
//     headers: { "content-type": "application/json" },
//   });
// }
