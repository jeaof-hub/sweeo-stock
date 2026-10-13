import { createClient } from "npm:@supabase/supabase-js@2";
import { json, replyLine, textMessage, verifyLineSignature } from "../_shared/line.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const channelSecret = Deno.env.get("LINE_CHANNEL_SECRET");
const accessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
if (!projectUrl || !serviceKey || !channelSecret || !accessToken) throw new Error("Required function secrets are unavailable");

const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const linkReplies: Record<string, string> = {
  linked: "เชื่อมบัญชี LINE สำเร็จแล้ว คุณจะได้รับแจ้งเตือนตามสิทธิ์ที่กำหนดในระบบ",
  expired: "รหัสหมดอายุแล้ว กรุณาสร้างรหัสใหม่จากเมนู เชื่อม LINE บนเว็บ",
  locked: "กรอกรหัสไม่ถูกต้องเกินกำหนด กรุณารอ 1 ชั่วโมงแล้วลองใหม่",
  forbidden: "บัญชีนี้ไม่สามารถเชื่อม LINE ได้ กรุณาติดต่อผู้ดูแลระบบ",
  line_in_use: "LINE บัญชีนี้เชื่อมกับผู้ใช้อื่นอยู่แล้ว กรุณายกเลิกการเชื่อมเดิมก่อน",
  invalid: "รหัสไม่ถูกต้อง กรุณาตรวจรหัส 6 หลักหรือสร้างรหัสใหม่จากเว็บ",
};

async function replySafely(replyToken: string | undefined, text: string) {
  try { await replyLine(replyToken, accessToken!, [textMessage(text)]); }
  catch (error) { console.error("LINE reply failed", error instanceof Error ? error.message : "unknown"); }
}

Deno.serve(async request => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  if (!await verifyLineSignature(rawBody, signature, channelSecret!)) return json({ error: "Invalid signature" }, 401);

  let payload: { events?: Array<Record<string, any>> };
  try { payload = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400); }
  for (const event of payload.events || []) {
    const eventId = typeof event.webhookEventId === "string" ? event.webhookEventId : "";
    if (!eventId) continue;
    const { error: eventError } = await admin.from("line_processed_events").insert({ webhook_event_id: eventId });
    if (eventError?.code === "23505") continue;
    if (eventError) { console.error("event dedupe failed", eventError.code); continue; }

    const sourceType = event.source?.type;
    if (sourceType === "group" || sourceType === "room") {
      await replySafely(event.replyToken, "บอทนี้ใช้ได้เฉพาะแชทส่วนตัว กรุณาเปิดแชท 1:1 กับบัญชีทางการ");
      continue;
    }
    if (sourceType !== "user" || typeof event.source?.userId !== "string") continue;
    const lineUserId = event.source.userId;

    if (event.type === "unfollow") {
      const { error } = await admin.rpc("line_unfollow", { p_line_user_id: lineUserId });
      if (error) console.error("LINE unlink failed", error.code);
      continue;
    }
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const text = String(event.message.text || "").trim();
    if (/^[0-9]{6}$/.test(text)) {
      const { data: result, error } = await admin.rpc("consume_line_link_code", { p_code: text, p_line_user_id: lineUserId });
      if (error) {
        console.error("LINE link failed", error.code);
        await replySafely(event.replyToken, "เชื่อมบัญชีไม่สำเร็จ กรุณาลองใหม่ภายหลัง");
      } else await replySafely(event.replyToken, linkReplies[String(result)] || linkReplies.invalid);
      continue;
    }

    const { data: link, error: linkError } = await admin.from("staff_line_links")
      .select("user_id,active").eq("line_user_id", lineUserId).eq("active", true).maybeSingle();
    if (linkError) { console.error("LINE link lookup failed", linkError.code); continue; }
    if (!link) {
      await replySafely(event.replyToken, "ยังไม่ได้เชื่อมบัญชี กรุณาเข้าสู่เว็บสต็อก เปิดเมนู เชื่อม LINE แล้วส่งรหัส 6 หลักมาที่แชทนี้");
      continue;
    }
    const { data: staff, error: staffError } = await admin.from("staff")
      .select("role,is_active").eq("user_id", link.user_id).maybeSingle();
    if (staffError) { console.error("staff lookup failed", staffError.code); continue; }
    if (!staff?.is_active || !["warehouse", "admin", "owner", "founder"].includes(staff.role)) {
      await admin.from("staff_line_links").update({ active: false }).eq("user_id", link.user_id);
      await replySafely(event.replyToken, "บัญชีนี้ไม่มีสิทธิ์ใช้ LINE Bot กรุณาติดต่อผู้ดูแลระบบ");
      continue;
    }
    await replySafely(event.replyToken, "บัญชี LINE เชื่อมกับระบบแล้ว เฟสนี้รองรับการรับแจ้งเตือน ส่วนคำสั่งอนุมัติและขอเบิกจะเปิดในเฟสถัดไป");
  }
  return json({ ok: true });
});
