// Resolve a private username server-side, then authenticate with the same Supabase Auth password.
import { createClient } from "npm:@supabase/supabase-js@2";

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
if (!projectUrl || !serviceKey || !anonKey) throw new Error("Supabase function secrets are unavailable");

const admin = createClient(projectUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const cors = {
  "Access-Control-Allow-Origin": "https://jeaof-hub.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const invalidLogin = () => reply({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 401);
const validUsername = value => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(value);
const encoder = new TextEncoder();
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", encoder.encode(`${serviceKey}:${value}`),
))).map(byte => byte.toString(16).padStart(2, "0")).join("");

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  let input;
  try {
    const body = await request.text();
    if (body.length > 2048) return invalidLogin();
    input = JSON.parse(body);
  } catch { return invalidLogin(); }
  const username = typeof input?.username === "string" ? input.username.trim().toLowerCase() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || forwarded || "unknown";
  const { data: allowed, error: limitError } = await admin.rpc("consume_username_login_attempt", {
    ip_bucket: await hash(`ip:${clientIp}`),
    identity_bucket: await hash(`identity:${username}`),
  });
  if (limitError) {
    console.error("username login rate limit failed", limitError);
    return reply({ error: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง" }, 503);
  }
  if (!allowed) return reply({ error: "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่" }, 429);
  if (!validUsername(username) || !password || password.length > 128) return invalidLogin();

  const { data: staff, error: lookupError } = await admin.from("staff")
    .select("email,is_active").eq("username", username).maybeSingle();
  if (lookupError) {
    console.error("username lookup failed", lookupError);
    return reply({ error: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง" }, 500);
  }
  // A fresh anon client per request prevents one user's session from affecting another.
  const auth = createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // A sentinel address keeps unknown, disabled, and wrong-password paths alike.
  const email = staff?.is_active ? staff.email : "invalid-login@invalid.local";
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data?.session) return invalidLogin();
  return reply({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});
