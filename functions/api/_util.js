export function getAuthCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie.split(";").map(s => s.trim())
    .find(s => s.startsWith("ppsai_auth="))?.split("=")[1] || "";
}

export function setAuthCookie(value, maxAgeSeconds) {
  return `ppsai_auth=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function okJSON(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

export function badRequest(message) {
  return okJSON({ ok: false, error: message || "bad_request" }, { status: 400 });
}

export function unauthorized() {
  return okJSON({ ok: false, error: "unauthorized" }, { status: 401 });
}

// Cho phép chấp nhận nhiều biến thể tên ENV (tránh sai chữ hoa/thường)
export function envPick(env, keys = []) {
  for (const k of keys) {
    const v = env?.[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}
