// functions/api/chat.js
// ------------------------------------------------------------
// Flow:
// 1) Forward tới N8N (stream & non-stream).
// 2) Non-stream: nếu nội dung từ GPT trong N8N chứa directive:
//    - _media       → gọi /api/media       (tạo ảnh/video mới)
//    - _media_edit  → gọi /api/media-edit  (chỉnh sửa ảnh có sẵn)
//    Gắn image_url/video_url vào response và SCRUB phần JSON directive
//    để FE không thấy "{...}".
// ------------------------------------------------------------

import { getAuthCookie, unauthorized, setAuthCookie, envPick } from "./_util.js";

/* ---------------- CORS ---------------- */
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

/* ---------------- HEALTHCHECK ---------------- */
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

/* ---------------- Helpers: parse & scrub directives ---------------- */
function stripCodeFence(s) {
  if (typeof s !== "string") return s;
  return s.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1");
}
function tryParseOnce(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (!t) return s;
  try { return JSON.parse(t); } catch { return s; }
}
function stripMediaFromText(text) {
  if (typeof text !== "string") return text;
  let out = stripCodeFence(text);
  out = out.replace(/\s*,?\s*\{[\s\S]*?"_media_edit"[\s\S]*?\}\s*,?\s*/gi, " ");
  out = out.replace(/\s*,?\s*\{[\s\S]*?"_media"[\s\S]*?\}\s*,?\s*/gi, " ");
  out = out.replace(/\s*,?\s*\{[\s\S]*?"__media__"[\s\S]*?\}\s*,?\s*/gi, " ");
  out = out.replace(/(^|\s)[}\]]+(?=\s|$)/g, "$1");
  out = out.replace(/(^|\s),(?=\s|$)/g, "$1");
  out = out.replace(/\s{2,}/g, " ");
  return out.trim();
}
function sliceJsonObjectContaining(text, key) {
  if (typeof text !== "string") return null;
  const idx = text.indexOf(`"${key}"`);
  if (idx < 0) return null;
  let start = -1, depth = 0;
  for (let i = idx; i >= 0; i--) if (text[i] === "{") { start = i; break; }
  if (start < 0) return null;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, j + 1);
  }
  return null;
}
function extractMediaDirective(text = "") {
  // { _media: { type: "image|video", prompt: "..." } }
  const out = { type: null, prompt: null };
  if (!text || typeof text !== "string") return out;

  const src = stripCodeFence(text);
  let p = tryParseOnce(src);
  if (typeof p === "string") p = tryParseOnce(p);

  const pick = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    const cand = obj._media || obj.__media__ || obj.media;
    if (cand && typeof cand === "object" && cand.prompt && cand.type) {
      out.type = String(cand.type).toLowerCase().includes("video") ? "video" : "image";
      out.prompt = String(cand.prompt);
      return true;
    }
    return false;
  };
  if (pick(p)) return out;

  // fenced
  for (const m of Array.from(src.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))) {
    try { if (pick(JSON.parse(m[1]))) return out; } catch {}
  }
  // inline JSON small
  for (const m of Array.from(src.matchAll(/\{[\s\S]*?\}/g))) {
    const s = m[0]; if (s.length > 5000) continue;
    try { if (pick(JSON.parse(s))) return out; } catch {}
  }
  // slice by key
  const frag = sliceJsonObjectContaining(src, "_media") || sliceJsonObjectContaining(src, "__media__");
  if (frag) { try { if (pick(JSON.parse(frag))) return out; } catch {} }

  return out;
}
function extractMediaEditDirective(text = "") {
  // { _media_edit: { prompt:"...", base64:"data:image/...;base64,xxx" | image_url:"https://..." } }
  const out = { prompt: null, base64: null, image_url: null };
  if (!text || typeof text !== "string") return out;

  const src = stripCodeFence(text);
  let p = tryParseOnce(src);
  if (typeof p === "string") p = tryParseOnce(p);

  const pick = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    const cand = obj._media_edit || obj.media_edit;
    if (cand && typeof cand === "object" && cand.prompt) {
      out.prompt = String(cand.prompt);
      if (cand.base64) out.base64 = String(cand.base64);
      if (cand.image_url) out.image_url = String(cand.image_url);
      return true;
    }
    return false;
  };
  if (pick(p)) return out;

  for (const m of Array.from(src.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))) {
    try { if (pick(JSON.parse(m[1]))) return out; } catch {}
  }
  for (const m of Array.from(src.matchAll(/\{[\s\S]*?\}/g))) {
    const s = m[0]; if (s.length > 5000) continue;
    try { if (pick(JSON.parse(s))) return out; } catch {}
  }
  const frag = sliceJsonObjectContaining(src, "_media_edit");
  if (frag) { try { if (pick(JSON.parse(frag))) return out; } catch {} }

  return out;
}

/* ---------------- small helpers ---------------- */
async function fetchUrlToBase64(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = await r.arrayBuffer();
    let bin = ""; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    const ct = r.headers.get("content-type") || "image/png";
    return `data:${ct};base64,${b64}`;
  } finally { clearTimeout(t); }
}

/* ---------------- POST main ---------------- */
export async function onRequestPost({ request, env }) {
  if (getAuthCookie(request) !== "1") return unauthorized();

  let bodyJson;
  try { bodyJson = await request.json(); }
  catch {
    return new Response(JSON.stringify({ ok:false, error:"invalid json body" }), {
      status:400, headers:{ "content-type":"application/json", "access-control-allow-origin":"*" }
    });
  }

  const urlBase = envPick(env, ["N8N_WEBHOOK_URL","N8n_webhook_url","n8n_webhook_url"]);
  if (!urlBase) {
    return new Response(JSON.stringify({ ok:false, error:"missing N8N_WEBHOOK_URL" }), {
      status:500, headers:{ "content-type":"application/json", "access-control-allow-origin":"*" }
    });
  }

  const method = (envPick(env, ["N8N_METHOD","N8n_method"]) || "POST").toUpperCase();

  const reqUrl = new URL(request.url);
  const isStream = reqUrl.pathname.endsWith("/stream") || reqUrl.searchParams.get("stream")==="1";

  const upstreamUrl = new URL(urlBase);
  reqUrl.searchParams.forEach((v,k)=>{ if(k!=="stream") upstreamUrl.searchParams.set(k,v); });

  // Forward headers
  const headers = new Headers();
  const bearer = envPick(env, ["N8N_BEARER","N8n_bearer","n8n_bearer"]);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("accept", request.headers.get("accept") || "*/*");
  headers.set("content-type","application/json");

  /* -------- STREAM: passthrough -------- */
  if (isStream) {
    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(bodyJson),
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok:false, error:"upstream fetch error", detail:String(err) }), {
        status:502, headers:{ "content-type":"application/json", "access-control-allow-origin":"*" }
      });
    }

    const respHeaders = new Headers();
    respHeaders.set("content-type", upstream.headers.get("content-type") || "text/event-stream");
    respHeaders.set("cache-control","no-cache");
    respHeaders.set("connection","keep-alive");
    respHeaders.set("x-accel-buffering","no");
    respHeaders.set("access-control-allow-origin","*");
    respHeaders.set("Set-Cookie", setAuthCookie("1", 30*60));

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  }

  /* -------- NON-STREAM: phân tích & gọi /api/media(/-edit) -------- */
  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method,
      headers,
      body: JSON.stringify(bodyJson),
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok:false, error:"upstream fetch error", detail:String(err) }), {
      status:502, headers:{ "content-type":"application/json", "access-control-allow-origin":"*" }
    });
  }

  const rawText = await upstream.text();
  const ct = (upstream.headers.get("content-type") || "").toLowerCase();

  let patchedBodyText = rawText;

  // Helpers để lấy/đặt text ở JSON kết quả
  const getText = (o) => String(o?.content ?? o?.output ?? o?.text ?? "");
  const setText = (o, s) => {
    if ("content" in o) o.content = s;
    else if ("output" in o) o.output = s;
    else o.content = s;
  };

  async function handleDirectivesOnText(contentText, cookieHeader) {
    // 1) _media_edit ưu tiên nếu có
    const edit = extractMediaEditDirective(contentText);
    if (edit.prompt) {
      let base64 = (edit.base64 || "").trim();

      // Nếu chỉ có image_url → tải & chuyển về base64
      if (!base64 && edit.image_url) {
        try { base64 = await fetchUrlToBase64(edit.image_url); }
        catch { /* bỏ qua, rơi xuống scrub-only */ }
      }

      if (base64) {
        const here = new URL(reqUrl.toString());
        here.pathname = "/api/media-edit"; here.search = "";

        // Gọi media-edit với { prompt, base64 } cho đồng bộ
        const mediaResp = await fetch(here.toString(), {
          method: "POST",
          headers: new Headers({
            "content-type":"application/json",
            "accept":"application/json",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
          }),
          body: JSON.stringify({ prompt: edit.prompt, base64 }),
        });

        const mediaJson = await mediaResp.json().catch(()=>null);
        if (mediaResp.ok && mediaJson?.ok) {
          const first = mediaJson.results?.find(r => r.ok && r.image_url);
          if (first) {
            return {
              patchedText: stripMediaFromText(contentText),
              attach: { image_url: first.image_url, video_url: null, url: first.image_url }
            };
          }
        }
        // Nếu không sửa được thì vẫn scrub directive để tránh lộ JSON
        return { patchedText: stripMediaFromText(contentText), attach: null };
      }

      // Không có base64 (và cũng không tải được), vẫn scrub
      return { patchedText: stripMediaFromText(contentText), attach: null };
    }

    // 2) _media (tạo ảnh/video mới)
    const gen = extractMediaDirective(contentText);
    if (gen.type && gen.prompt) {
      const here = new URL(reqUrl.toString());
      here.pathname = "/api/media"; here.search = "";
      const mediaResp = await fetch(here.toString(), {
        method: "POST",
        headers: new Headers({
          "content-type":"application/json",
          "accept":"application/json",
          ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
        }),
        body: JSON.stringify({ type: gen.type, prompt: gen.prompt }),
      });
      const mediaJson = await mediaResp.json().catch(()=>null);
      if (mediaResp.ok && mediaJson?.ok) {
        return {
          patchedText: stripMediaFromText(contentText),
          attach: {
            image_url: mediaJson.image_url || null,
            video_url: mediaJson.video_url || null,
            url: mediaJson.image_url || mediaJson.video_url || null
          }
        };
      }
      return { patchedText: stripMediaFromText(contentText), attach: null };
    }

    // 3) Không có directive → chỉ scrub đề phòng
    return { patchedText: stripMediaFromText(contentText), attach: null };
  }

  try {
    const cookie = request.headers.get("cookie") || "";
    if (ct.includes("application/json")) {
      const obj = JSON.parse(rawText);

      if (Array.isArray(obj)) {
        const first = obj[0] ?? (obj[0] = {});
        const contentText = getText(first);
        const { patchedText, attach } = await handleDirectivesOnText(contentText, cookie);
        setText(first, patchedText);
        if (attach) {
          first.image_url = attach.image_url;
          first.video_url = attach.video_url;
          first.url       = attach.url;
        }
        patchedBodyText = JSON.stringify(obj);
      } else {
        const contentText = getText(obj);
        const { patchedText, attach } = await handleDirectivesOnText(contentText, cookie);
        setText(obj, patchedText);
        if (attach) {
          obj.image_url = attach.image_url;
          obj.video_url = attach.video_url;
          obj.url       = attach.url;
        }
        patchedBodyText = JSON.stringify(obj);
      }
    } else {
      // text / ndjson
      const { patchedText, attach } = await handleDirectivesOnText(rawText, request.headers.get("cookie") || "");
      if (attach) {
        patchedBodyText =
          patchedText +
          `\n\n{"image_url":${JSON.stringify(attach.image_url)},"video_url":${JSON.stringify(attach.video_url)},"url":${JSON.stringify(attach.url)}}`;
      } else {
        patchedBodyText = patchedText;
      }
    }
  } catch {
    patchedBodyText = rawText; // giữ nguyên nếu parse lỗi
  }

  const respHeaders = new Headers();
  respHeaders.set("content-type", upstream.headers.get("content-type") || "application/json");
  respHeaders.set("Set-Cookie", setAuthCookie("1", 30 * 60));
  respHeaders.set("access-control-allow-origin", "*");

  return new Response(patchedBodyText, { status: upstream.status, headers: respHeaders });
}
