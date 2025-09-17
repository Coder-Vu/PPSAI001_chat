import { getAuthCookie, okJSON, unauthorized } from "./_util.js";

export async function onRequestGet({ request }) {
  const authed = getAuthCookie(request) === "1";
  return authed ? okJSON({ ok: true }) : unauthorized();
}
