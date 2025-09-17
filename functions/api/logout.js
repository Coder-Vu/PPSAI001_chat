import { okJSON, setAuthCookie } from "./_util.js";

export async function onRequestPost() {
  return okJSON({ ok: true }, {
    headers: { "Set-Cookie": setAuthCookie("", 0) },
  });
}
