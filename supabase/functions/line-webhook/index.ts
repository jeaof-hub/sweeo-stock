import { createClient } from "npm:@supabase/supabase-js@2";
import { confirmationFlex, json, leaveLine, pendingRequestsFlex, replyLine, textMessage, verifyLineSignature } from "../_shared/line.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const channelSecret = Deno.env.get("LINE_CHANNEL_SECRET");
const accessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
if (!projectUrl || !serviceKey || !channelSecret || !accessToken) throw new Error("Required function secrets are unavailable");
const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const siteUrl = "https://jeaof-hub.github.io/sweeo-stock/";
const linkReplies: Record<string, string> = {
  linked: "เชื่อมบัญชี LINE สำเร็จแล้ว คุณจะได้รับแจ้งเตือนตามสิทธิ์ที่กำหนดในระบบ",
  expired: "รหัสหมดอายุแล้ว กรุณาสร้างรหัสใหม่จากเมนู เชื่อม LINE บนเว็บ",
  locked: "กรอกรหัสไม่ถูกต้องเกินกำหนด กรุณารอ 1 ชั่วโมงแล้วลองใหม่",
  forbidden: "บัญชีนี้ไม่สามารถเชื่อม LINE ได้ กรุณาติดต่อผู้ดูแลระบบ",
  line_in_use: "LINE บัญชีนี้เชื่อมกับผู้ใช้อื่นอยู่แล้ว กรุณายกเลิกการเชื่อมเดิมก่อน",
  invalid: "รหัสไม่ถูกต้อง กรุณาตรวจรหัส 6 หลักหรือสร้างรหัสใหม่จากเว็บ",
};

async function replySafely(replyToken: string | undefined, messages: unknown | unknown[]) {
  try { await replyLine(replyToken, accessToken!, Array.isArray(messages) ? messages : [messages]); }
  catch (error) { console.error("LINE reply failed", error instanceof Error ? error.message : "unknown"); }
}

async function actorFor(lineUserId: string) {
  const { data: link, error: linkError } = await admin.from("staff_line_links")
    .select("user_id,active").eq("line_user_id", lineUserId).eq("active", true).maybeSingle();
  if (linkError || !link) return null;
  const { data: staff, error: staffError } = await admin.from("staff")
    .select("user_id,name,role,is_active").eq("user_id", link.user_id).maybeSingle();
  if (staffError || !staff?.is_active || !["warehouse", "admin", "owner", "founder"].includes(staff.role)) {
    await admin.from("staff_line_links").update({ active: false }).eq("user_id", link.user_id);
    return null;
  }
  return staff;
}

const canReview = (actor: Record<string, any>, request: Record<string, any>) =>
  actor.user_id !== request.requester_id &&
  ((request.requester_role === "warehouse" && ["admin", "owner", "founder"].includes(actor.role)) ||
    (request.requester_role === "admin" && ["owner", "founder"].includes(actor.role)));

async function requestInfo(requestId: string) {
  const [{ data: request }, { data: lines }] = await Promise.all([
    admin.from("dispatch_requests").select("id,delivery_note_no,status,requester_id,requester_role,decided_by,decided_at").eq("id", requestId).maybeSingle(),
    admin.from("dispatch_request_lines").select("id,requested_qty").eq("request_id", requestId).order("id"),
  ]);
  return { request, lines: lines || [] };
}

async function currentStatusMessage(request: Record<string, any> | null) {
  if (!request) return "ไม่พบคำขอนี้";
  if (request.status === "pending") return "คำขอนี้ยังรออนุมัติ กรุณาลองอีกครั้ง";
  const { data: decider } = request.decided_by
    ? await admin.from("staff").select("name").eq("user_id", request.decided_by).maybeSingle() : { data: null };
  const action = request.status === "approved" ? "อนุมัติ" : request.status === "rejected" ? "ปฏิเสธ" : "จัดการ";
  const when = request.decided_at ? new Date(request.decided_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "–";
  return `คำขอนี้ถูก${action}แล้วโดย ${decider?.name || "ผู้มีสิทธิ์"} เมื่อ ${when}`;
}

async function startAction(lineUserId: string, actor: Record<string, any>, requestId: string, action: "approve" | "reject") {
  const { request, lines } = await requestInfo(requestId);
  if (!request || request.status !== "pending" || !canReview(actor, request))
    return { message: await currentStatusMessage(request), request: null, lines: [] };
  const { error } = await admin.from("line_action_sessions").upsert({
    line_user_id: lineUserId, actor_user_id: actor.user_id, request_id: requestId, action,
    state: action === "approve" ? "awaiting_confirmation" : "awaiting_reason",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), created_at: new Date().toISOString(),
  }, { onConflict: "line_user_id" });
  if (error) return { message: "เริ่มรายการไม่สำเร็จ กรุณาลองใหม่", request: null, lines: [] };
  return { message: "", request, lines };
}

async function handlePostback(event: Record<string, any>, lineUserId: string, actor: Record<string, any>) {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(String(event.postback?.data || "")); } catch { /* invalid button */ }
  const action = typeof payload.a === "string" ? payload.a : "";
  const requestId = typeof payload.r === "string" ? payload.r : "";
  if (Object.keys(payload).some(key => key !== "a" && key !== "r") || !/^[0-9a-f-]{36}$/i.test(requestId))
    return replySafely(event.replyToken, textMessage("ปุ่มนี้ไม่ถูกต้อง กรุณาเปิดรายการใหม่"));
  if (action === "cancel") {
    await admin.from("line_action_sessions").delete().eq("line_user_id", lineUserId).eq("request_id", requestId);
    return replySafely(event.replyToken, textMessage("ยกเลิกรายการแล้ว"));
  }
  if (action === "approve" || action === "reject") {
    const started = await startAction(lineUserId, actor, requestId, action);
    if (!started.request) return replySafely(event.replyToken, textMessage(started.message));
    if (action === "reject") return replySafely(event.replyToken, textMessage(`กรุณาพิมพ์เหตุผลที่ปฏิเสธ ${started.request.delivery_note_no || "คำขอนี้"} ภายใน 5 นาที`));
    const total = started.lines.reduce((sum: number, line: any) => sum + Number(line.requested_qty || 0), 0);
    return replySafely(event.replyToken, confirmationFlex(started.request, started.lines.length, total));
  }
  if (action === "confirm") {
    const { data: session } = await admin.from("line_action_sessions").select("actor_user_id,request_id,expires_at")
      .eq("line_user_id", lineUserId).eq("request_id", requestId).eq("action", "approve")
      .eq("state", "awaiting_confirmation").gt("expires_at", new Date().toISOString()).maybeSingle();
    if (!session || session.actor_user_id !== actor.user_id)
      return replySafely(event.replyToken, textMessage("ปุ่มยืนยันหมดอายุแล้ว กรุณาเปิดรายการใหม่"));
    const { request, lines } = await requestInfo(requestId);
    if (!request || request.status !== "pending") {
      await admin.from("line_action_sessions").delete().eq("line_user_id", lineUserId);
      return replySafely(event.replyToken, textMessage(await currentStatusMessage(request)));
    }
    const approvalLines = lines.map((line: any) => ({ line_id: line.id, qty: line.requested_qty }));
    const { error } = await admin.rpc("approve_dispatch_request_as", { p_actor: actor.user_id, p_request_id: requestId, p_lines: approvalLines });
    await admin.from("line_action_sessions").delete().eq("line_user_id", lineUserId);
    if (error) {
      const latest = await requestInfo(requestId);
      return replySafely(event.replyToken, textMessage(latest.request?.status !== "pending" ? await currentStatusMessage(latest.request) : "อนุมัติไม่สำเร็จ กรุณาตรวจยอดคงเหลือในเว็บ"));
    }
    return replySafely(event.replyToken, textMessage(`อนุมัติ ${request.delivery_note_no || "คำขอ"} สำเร็จ\nเปิดใบส่งของ: ${siteUrl}?tab=deliveries&request=${encodeURIComponent(requestId)}`));
  }
  return replySafely(event.replyToken, textMessage("ไม่รู้จักคำสั่งจากปุ่มนี้"));
}

async function handleText(event: Record<string, any>, lineUserId: string, actor: Record<string, any>, text: string) {
  const { data: rejection } = await admin.from("line_action_sessions").select("actor_user_id,request_id,expires_at")
    .eq("line_user_id", lineUserId).eq("action", "reject").eq("state", "awaiting_reason")
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (rejection?.actor_user_id === actor.user_id) {
    if (text.length < 2) return replySafely(event.replyToken, textMessage("กรุณาระบุเหตุผลอย่างน้อย 2 ตัวอักษร"));
    const { request } = await requestInfo(rejection.request_id);
    const { error } = await admin.rpc("reject_dispatch_request_as", { p_actor: actor.user_id, p_request_id: rejection.request_id, p_reason: text });
    await admin.from("line_action_sessions").delete().eq("line_user_id", lineUserId);
    if (error) {
      const latest = await requestInfo(rejection.request_id);
      return replySafely(event.replyToken, textMessage(latest.request?.status !== "pending" ? await currentStatusMessage(latest.request) : "ปฏิเสธไม่สำเร็จ กรุณาลองในเว็บ"));
    }
    return replySafely(event.replyToken, textMessage(`ปฏิเสธ ${request?.delivery_note_no || "คำขอ"} สำเร็จ`));
  }
  if (text === "รออนุมัติ") {
    if (!["admin", "owner", "founder"].includes(actor.role)) return replySafely(event.replyToken, textMessage("บัญชีนี้ไม่มีสิทธิ์อนุมัติคำขอ"));
    const { data, error } = await admin.rpc("line_pending_dispatch_requests", { p_actor: actor.user_id });
    if (error) return replySafely(event.replyToken, textMessage("โหลดรายการไม่สำเร็จ กรุณาลองใหม่"));
    if (!data?.length) return replySafely(event.replyToken, textMessage("ไม่มีคำขอที่คุณอนุมัติได้ในขณะนี้"));
    return replySafely(event.replyToken, pendingRequestsFlex(data, siteUrl));
  }
  return replySafely(event.replyToken, textMessage("คำสั่งที่ใช้ได้: รออนุมัติ"));
}

Deno.serve(async request => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const rawBody = await request.text();
  if (!await verifyLineSignature(rawBody, request.headers.get("x-line-signature"), channelSecret!)) return json({ error: "Invalid signature" }, 401);
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
      if (event.type === "join") {
        await replySafely(event.replyToken, textMessage("บอทนี้ใช้ได้เฉพาะแชทส่วนตัว กรุณาเปิดแชท 1:1 กับบัญชีทางการ"));
        try { await leaveLine(event.source, accessToken!); } catch (error) { console.error("LINE leave failed", error instanceof Error ? error.message : "unknown"); }
      }
      continue;
    }
    if (sourceType !== "user" || typeof event.source?.userId !== "string") continue;
    const lineUserId = event.source.userId;
    if (event.type === "unfollow") { await admin.rpc("line_unfollow", { p_line_user_id: lineUserId }); continue; }
    if (event.type === "message" && event.message?.type === "text" && /^[0-9]{6}$/.test(String(event.message.text || "").trim())) {
      const { data: result, error } = await admin.rpc("consume_line_link_code", { p_code: String(event.message.text).trim(), p_line_user_id: lineUserId });
      await replySafely(event.replyToken, textMessage(error ? "เชื่อมบัญชีไม่สำเร็จ กรุณาลองใหม่ภายหลัง" : (linkReplies[String(result)] || linkReplies.invalid)));
      continue;
    }
    const actor = await actorFor(lineUserId);
    if (!actor) { await replySafely(event.replyToken, textMessage("ยังไม่ได้เชื่อมบัญชี กรุณาเข้าสู่เว็บสต็อก เปิดเมนู เชื่อม LINE แล้วส่งรหัส 6 หลักมาที่แชทนี้")); continue; }
    if (event.type === "postback") await handlePostback(event, lineUserId, actor);
    else if (event.type === "message" && event.message?.type === "text") await handleText(event, lineUserId, actor, String(event.message.text || "").trim());
  }
  return json({ ok: true });
});
