// functions/api/media.js
// ------------------------------------------------------------
// ✅ Đồng bộ tuyệt đối với index.html & chat.js (2025-10)
// ✅ Hỗ trợ IMAGE (base64 data URL) & VIDEO (Veo long-running + poll)
// ✅ Nhất quán truyền API key qua header `x-goog-api-key`
// ✅ Có timeout để tránh treo request
// ------------------------------------------------------------

import { getAuthCookie, unauthorized, envPick } from "./_util.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 60_000;

/* -------------------- tiny fetch with timeout -------------------- */
async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* -------------------- OPTIONS (CORS) -------------------- */
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

/* ------------------------------------------------------------
   GET /api/media?op=<operationName>  → FE poll video
------------------------------------------------------------ */
export async function onRequestGet({ request, env }) {
  if (getAuthCookie(request) !== "1") return unauthorized();

  const apiKey = envPick(env, ["GEMINI_API_KEY"]);
  const base   = env.GEMINI_API_URL || DEFAULT_BASE;
  if (!apiKey) return jErr(500, "missing_GEMINI_API_KEY");

  const url = new URL(request.url);
  const opName = url.searchParams.get("op");
  if (!opName) return jErr(400, "missing_op");

  try {
// Lưu ý: opName thường dạng "operations/xxxx"
// Nếu opName là URL tuyệt đối (bắt đầu bằng http) thì dùng luôn
const opUrl = /^https?:\/\//i.test(opName) ? opName : `${base}/${opName}`;
const st = await fetchWithTimeout(opUrl, { headers: { "x-goog-api-key": apiKey } });
const txt = await st.text().catch(() => "");
let doneJson;
try { doneJson = JSON.parse(txt); } catch { doneJson = null; }
if (!st.ok) return jErr(st.status, "gemini_error", txt || doneJson);

    if (!doneJson?.done) {
      return jOk({ pending: true, poll_after_ms: 8000 });
    }

    // Khi done → lấy URI video
    const uri =
      doneJson?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
      doneJson?.response?.generatedVideos?.[0]?.video?.uri ||
      null;

    if (!uri) return jErr(500, "no_video_returned", doneJson);

// Tải bytes video và trả data URL (tránh CORS)
let vr = await fetchWithTimeout(uri, { headers: { "x-goog-api-key": apiKey } }, 120_000);

// Một số link signed URL không cho kèm API key → thử lại không header
if (!vr.ok && (vr.status === 401 || vr.status === 403)) {
  vr = await fetchWithTimeout(uri, {}, 120_000); // retry không header
}

if (!vr.ok) return jErr(vr.status, "video_download_error", { uri, status: vr.status });

    const ab   = await vr.arrayBuffer();
    const b64  = arrayBufferToBase64(ab);
    const mime = normalizeMime(vr.headers.get("content-type"));

    return jOk({ pending: false, type: "video", video_url: `data:${mime};base64,${b64}` });
  } catch (e) {
    return jErr(500, "fetch_error", { message: String(e) });
  }
}

/* ------------------------------------------------------------
   POST /api/media
   Body: { type: "image" | "video", prompt: "..." }
------------------------------------------------------------ */
export async function onRequestPost({ request, env }) {
  if (getAuthCookie(request) !== "1") return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jErr(400, "invalid_json"); }

  const prompt = (body.prompt || body.text || body.mediaPrompt || "").trim();
  const type   = (body.type || "image").toLowerCase();
  if (!prompt) return jErr(400, "prompt_missing");

  const apiKey = envPick(env, ["GEMINI_API_KEY"]);
  const base   = env.GEMINI_API_URL || DEFAULT_BASE;
  if (!apiKey) return jErr(500, "missing_GEMINI_API_KEY");

  try {
    /* -------------------- IMAGE -------------------- */
    if (type === "image") {
      // Giữ model bạn đang dùng; truyền key qua header cho nhất quán
      const url = `${base}/models/gemini-2.5-flash-image:generateContent`;
      const r = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }]}],
        }),
      });

const txt = await r.text().catch(()=> "");
let j;
try { j = JSON.parse(txt); } catch { j = null; }
if (!r.ok) return jErr(r.status, "gemini_error", txt || j);

      const img = extractInlineImage(j);
      if (!img) return jErr(500, "no_image_returned", j);

      const mime = normalizeMime(img.mime);
      return jOk({ type: "image", image_url: `data:${mime};base64,${img.data}` });
    }

    /* -------------------- VIDEO -------------------- */
    if (type === "video") {
      const model = env.GEMINI_VIDEO_MODEL || "veo-3.1-generate-preview"; // Model VEO 3.1
      const startUrl = `${base}/models/${model}:predictLongRunning`;

      const start = await fetchWithTimeout(startUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          instances: [{ prompt }],
        }),
      });

     const txt = await start.text().catch(()=> "");
let started;
try { started = JSON.parse(txt); } catch { started = null; }
if (!start.ok) return jErr(start.status, "gemini_error", txt || started);

      const opName = started?.name;
      if (!opName) return jErr(500, "no_operation_name", started);

      // FE sẽ poll GET /api/media?op=...
      return jOk({ pending: true, op_name: opName, poll_after_ms: 5000 });
    }

    return jErr(400, "unsupported_type", { type });
  } catch (e) {
    return jErr(500, "fetch_error", { message: String(e) });
  }
}

/* -------------------- Helpers -------------------- */
function extractInlineImage(resp) {
  const cands = resp?.candidates || [];
  for (const c of cands) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      const id1 = p?.inline_data;
      const id2 = p?.inlineData;
      if (id1?.data) return { data: id1.data, mime: id1.mime_type || id1.mimeType };
      if (id2?.data) return { data: id2.data, mime: id2.mimeType || id2.mime_type };
    }
  }
  return null;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function normalizeMime(m) {
  const t = (m || "").toLowerCase();
  if (t.startsWith("image/")) return t;
  if (t.startsWith("video/")) return t;
  // fallback hợp lý
  if (t.includes("webm")) return "video/webm";
  if (t.includes("mp4")) return "video/mp4";
  return "image/png";
}

function jOk(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function jErr(status, error, detail) {
  return new Response(JSON.stringify({ ok: false, error, detail }), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
