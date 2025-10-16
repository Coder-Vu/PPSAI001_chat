// functions/api/media-edit.js
// ------------------------------------------------------------
// ✅ Hỗ trợ chỉnh sửa 1 hoặc nhiều ảnh (image-to-image)
// ✅ Tương thích directive {"_media_edit":{"type":"image","instructions":"..."}}
// ✅ Input có thể là:
//    { prompt, base64 }
//    { instructions, images:[...] }
//    { attachments:[{type:'image',base64:'...'}], instructions }
// ✅ Output: { ok:true, results:[{image_url:"data:image/png;base64,..."}] }
// ------------------------------------------------------------

import { getAuthCookie, unauthorized, envPick } from "./_util.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 60_000;

/* -------------------- fetch timeout helper -------------------- */
async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/* -------------------- OPTIONS -------------------- */
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

/* -------------------- POST /api/media-edit -------------------- */
export async function onRequestPost({ request, env }) {
  if (getAuthCookie(request) !== "1") return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jErr(400, "invalid_json"); }

  // Hỗ trợ prompt hoặc instructions (từ directive _media_edit)
  const instructions = (body.instructions || body.prompt || "").trim();
  if (!instructions) return jErr(400, "missing_instructions");

  // Chuẩn hoá danh sách ảnh (base64 hoặc attachments[] hoặc field base64 đơn)
  let images = [];
  if (Array.isArray(body.images)) images = body.images;
  else if (Array.isArray(body.attachments))
    images = body.attachments
      .filter(a => a?.type === "image" && typeof a.base64 === "string")
      .map(a => a.base64);
  else if (typeof body.base64 === "string") images = [body.base64];

  if (!images.length) return jErr(400, "missing_images");

  const apiKey = envPick(env, ["GEMINI_API_KEY"]);
  const base = env.GEMINI_API_URL || DEFAULT_BASE;
  if (!apiKey) return jErr(500, "missing_GEMINI_API_KEY");

  const url = `${base}/models/gemini-2.5-flash-image:generateContent`;

  // Loop qua từng ảnh
  const results = [];
  for (const img64 of images) {
    const b64data = img64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    const mime = detectMime(img64);
    const payload = {
      contents: [{
        role: "user",
        parts: [
          { text: instructions },
          { inline_data: { mime_type: mime, data: b64data } }
        ]
      }]
    };

    try {
      const r = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });

      const j = await r.json().catch(()=>null);
      if (!r.ok) {
        results.push({ ok:false, error:"gemini_error", detail:j });
        continue;
      }

      const img = extractInlineImage(j);
      if (!img) {
        results.push({ ok:false, error:"no_image_returned", detail:j });
        continue;
      }

      const outMime = normalizeMime(img.mime);
      results.push({ ok:true, image_url:`data:${outMime};base64,${img.data}` });
    } catch (e) {
      results.push({ ok:false, error:"fetch_error", detail:String(e) });
    }
  }

  // Tổng hợp kết quả
  const success = results.some(r => r.ok);
  return jOk({ ok: success, results });
}

/* -------------------- helpers -------------------- */
function extractInlineImage(resp) {
  const cands = resp?.candidates || [];
  for (const c of cands) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      const id1 = p?.inline_data;
      const id2 = p?.inlineData;
      if (id1?.data) return { data:id1.data, mime:id1.mime_type||id1.mimeType };
      if (id2?.data) return { data:id2.data, mime:id2.mimeType||id2.mime_type };
    }
  }
  return null;
}

function detectMime(str){
  const m = /^data:(image\/[a-z0-9+.-]+);base64,/i.exec(str||"");
  return m ? m[1] : "image/png";
}

function normalizeMime(m){
  const t=(m||"").toLowerCase();
  if(t.startsWith("image/")) return t;
  if(t.includes("png")) return "image/png";
  if(t.includes("jpeg")||t.includes("jpg")) return "image/jpeg";
  return "image/png";
}

function jOk(data){
  return new Response(JSON.stringify(data),{
    status:200,
    headers:{ "content-type":"application/json", "access-control-allow-origin":"*" }
  });
}

function jErr(status,error,detail){
  return new Response(JSON.stringify({ ok:false, error, detail }),{
    status,
    headers:{ "content-type":"application/json", "access-control-allow-origin":"*" }
  });
}
