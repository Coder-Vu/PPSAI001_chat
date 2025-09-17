import { okJSON, badRequest, setAuthCookie, envPick } from "./_util.js";

export async function onRequestPost({ request, env }) {
  const envCode = envPick(env, ["ACCESS_CODE", "Access_code", "access_code"]);
  if (!envCode) return badRequest("missing_ACCESS_CODE_env");

  const body = await request.json().catch(() => ({}));
  const code = (body?.code ?? "").toString().trim();
  if (!code) return badRequest("empty_code");

  if (code !== envCode) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_code" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const maxAge = 30 * 60; // 30'
  return okJSON({ ok: true }, {
    headers: { "Set-Cookie": setAuthCookie("1", maxAge) },
  });
}
