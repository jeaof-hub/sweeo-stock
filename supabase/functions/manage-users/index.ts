// Founder-only user administration. The service-role key exists only in this Edge Function.
import { createClient } from "npm:@supabase/supabase-js@2";

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!projectUrl || !serviceKey) throw new Error("Supabase function secrets are unavailable");

const admin = createClient(projectUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const siteOrigin = "https://jeaof-hub.github.io";
const cors = {
  "Access-Control-Allow-Origin": siteOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const validRole = role => role === "sales" || role === "warehouse" || role === "manager";
const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validPassword = value => typeof value === "string" && value.length >= 8 && value.length <= 128;

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  // Always verify the caller with Supabase Auth. The browser's publishable key is not an identity.
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return reply({ error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" }, 401);
  const { data: actor, error: actorError } = await admin.from("staff")
    .select("role,is_active").eq("user_id", authData.user.id).maybeSingle();
  if (actorError) {
    console.error("staff lookup failed", actorError);
    return reply({ error: "ตรวจสิทธิ์ไม่สำเร็จ" }, 500);
  }
  if (!actor?.is_active || actor.role !== "founder") return reply({ error: "เฉพาะ Founder จัดการผู้ใช้ได้" }, 403);

  let input;
  try { input = await request.json(); } catch { return reply({ error: "ข้อมูลคำขอไม่ถูกต้อง" }, 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return reply({ error: "ข้อมูลคำขอไม่ถูกต้อง" }, 400);

  if (input.action === "list") {
    const { data, error } = await admin.from("staff")
      .select("user_id,email,name,role,is_active,created_at").order("created_at", { ascending: true });
    if (error) {
      console.error("list staff failed", error);
      return reply({ error: "โหลดรายชื่อผู้ใช้ไม่สำเร็จ" }, 500);
    }
    return reply({ users: data });
  }

  if (input.action === "create") {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!validEmail(email) || !name || name.length > 100 || !validRole(input.role) || !validPassword(input.password)) {
      return reply({ error: "ตรวจอีเมล ชื่อ สิทธิ์ และรหัสผ่าน (8–128 ตัวอักษร)" }, 400);
    }
    const { data: existing, error: lookupError } = await admin.from("staff")
      .select("user_id").eq("email", email).maybeSingle();
    if (lookupError) {
      console.error("staff email lookup failed", lookupError);
      return reply({ error: "ตรวจบัญชีเดิมไม่สำเร็จ" }, 500);
    }
    if (existing) return reply({ error: "อีเมลนี้มีบัญชีในทีมแล้ว" }, 409);

    const { data: createdAuth, error: createError } = await admin.auth.admin.createUser({
      email, password: input.password, email_confirm: true, user_metadata: { name },
    });
    if (createError || !createdAuth?.user?.id) {
      console.error("create auth user failed", createError);
      return reply({ error: "สร้างบัญชีไม่สำเร็จ อาจมีอีเมลนี้อยู่ในระบบแล้ว" }, 409);
    }
    const { data: created, error: insertError } = await admin.from("staff")
      .insert({ user_id: createdAuth.user.id, email, name, role: input.role, is_active: true, is_admin: false })
      .select("user_id,email,name,role,is_active,created_at").single();
    if (insertError) {
      console.error("auth user created but staff insert failed", insertError);
      return reply({ error: "สร้างบัญชีแล้ว แต่บันทึกสิทธิ์ไม่สำเร็จ ติดต่อผู้ดูแลฐานข้อมูล" }, 500);
    }
    return reply({ user: created }, 201);
  }

  if (input.action === "set_password") {
    if (typeof input.user_id !== "string" || !validUuid(input.user_id)) return reply({ error: "รหัสผู้ใช้ไม่ถูกต้อง" }, 400);
    if (!validPassword(input.password)) return reply({ error: "รหัสผ่านต้องมี 8–128 ตัวอักษร" }, 400);
    const { data: target, error: targetError } = await admin.from("staff")
      .select("user_id,email,role").eq("user_id", input.user_id).maybeSingle();
    if (targetError) {
      console.error("password target lookup failed", targetError);
      return reply({ error: "ตรวจบัญชีเป้าหมายไม่สำเร็จ" }, 500);
    }
    if (!target) return reply({ error: "ไม่พบบัญชีนี้" }, 404);
    if (target.role === "founder") return reply({ error: "ไม่สามารถออกรหัสผ่านให้ Foundator ผ่านเว็บได้" }, 403);
    const { error: updateError } = await admin.auth.admin.updateUserById(target.user_id, {
      password: input.password, email_confirm: true,
    });
    if (updateError) {
      console.error("issue password failed", updateError);
      return reply({ error: "ออกรหัสผ่านใหม่ไม่สำเร็จ" }, 500);
    }
    return reply({ email: target.email });
  }

  if (input.action === "update") {
    if (typeof input.user_id !== "string" || !validUuid(input.user_id)) return reply({ error: "รหัสผู้ใช้ไม่ถูกต้อง" }, 400);
    const { data: target, error: targetError } = await admin.from("staff")
      .select("user_id,role").eq("user_id", input.user_id).maybeSingle();
    if (targetError) {
      console.error("target lookup failed", targetError);
      return reply({ error: "ตรวจบัญชีเป้าหมายไม่สำเร็จ" }, 500);
    }
    if (!target) return reply({ error: "ไม่พบบัญชีนี้" }, 404);
    if (target.role === "founder") return reply({ error: "ไม่สามารถเปลี่ยนสิทธิ์ Founder ผ่านเว็บได้" }, 403);

    const patch = {};
    if (Object.hasOwn(input, "role")) {
      if (!validRole(input.role)) return reply({ error: "สิทธิ์ที่เลือกไม่ถูกต้อง" }, 400);
      patch.role = input.role;
    }
    if (Object.hasOwn(input, "is_active")) {
      if (typeof input.is_active !== "boolean") return reply({ error: "สถานะบัญชีไม่ถูกต้อง" }, 400);
      patch.is_active = input.is_active;
    }
    if (Object.hasOwn(input, "name")) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 100) return reply({ error: "ชื่อไม่ถูกต้อง" }, 400);
      patch.name = name;
    }
    if (!Object.keys(patch).length) return reply({ error: "ไม่มีข้อมูลที่ต้องบันทึก" }, 400);
    const { data: updated, error: updateError } = await admin.from("staff")
      .update(patch).eq("user_id", target.user_id)
      .select("user_id,email,name,role,is_active,created_at").single();
    if (updateError) {
      console.error("update staff failed", updateError);
      return reply({ error: "บันทึกสิทธิ์ไม่สำเร็จ" }, 500);
    }
    return reply({ user: updated });
  }

  return reply({ error: "ไม่รู้จักคำสั่งนี้" }, 400);
});
