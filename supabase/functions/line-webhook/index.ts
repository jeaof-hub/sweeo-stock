import { createClient } from "npm:@supabase/supabase-js@2";
import { confirmationFlex, dispatchSummaryFlex, json, leaveLine, myRequestsFlex, pendingRequestsFlex, postbackData, quickReplyMessage, replyLine, textMessage, verifyLineSignature } from "../_shared/line.ts";
import { matchLineProducts, type LineProduct } from "../_shared/product-match.ts";

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
    .select("user_id,active,rich_menu_id").eq("line_user_id", lineUserId).eq("active", true).maybeSingle();
  if (linkError || !link) return null;
  const { data: staff, error: staffError } = await admin.from("staff")
    .select("user_id,name,role,is_active").eq("user_id", link.user_id).maybeSingle();
  if (staffError || !staff?.is_active || !["warehouse", "admin", "owner", "founder"].includes(staff.role)) {
    await admin.from("staff_line_links").update({ active: false }).eq("user_id", link.user_id);
    return null;
  }
  return { ...staff, rich_menu_id: link.rich_menu_id || "" };
}

async function lineApi(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.line.me${path}`, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`LINE API failed (${response.status})`);
  return response;
}

async function createRichMenu(name: string, labels: string[]) {
  const width = 2500, height = 843, cell = width / labels.length;
  const body = {
    size: { width, height }, selected: true, name: `SWEEO ${name} L3`, chatBarText: "เมนูสต็อก",
    areas: labels.map((label, index) => ({
      bounds: { x: Math.round(index * cell), y: 0, width: Math.round((index + 1) * cell) - Math.round(index * cell), height },
      action: { type: "message", label, text: label },
    })),
  };
  const response = await lineApi("/v2/bot/richmenu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return String((await response.json()).richMenuId || "");
}

async function uploadRichMenuImage(id: string, file: string) {
  const response = await fetch(`${siteUrl}assets/line/${file}`);
  if (!response.ok) throw new Error("Rich menu image unavailable");
  const upload = await fetch(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/png" }, body: await response.arrayBuffer(),
  });
  if (!upload.ok) throw new Error(`LINE rich menu upload failed (${upload.status})`);
}

async function setupRichMenus(lineUserId: string) {
  const member = await createRichMenu("Member", ["ขอเบิกสินค้า", "คำขอของฉัน", "วิธีใช้"]);
  const approver = await createRichMenu("Approver", ["ขอเบิกสินค้า", "คำขอของฉัน", "รออนุมัติ", "วิธีใช้"]);
  await Promise.all([
    uploadRichMenuImage(member, "rich-menu-member.png"),
    uploadRichMenuImage(approver, "rich-menu-approver.png"),
  ]);
  await lineApi(`/v2/bot/user/all/richmenu/${member}`, { method: "POST" });
  await lineApi(`/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${approver}`, { method: "POST" });
  const { error } = await admin.rpc("line_save_rich_menus", { p_member: member, p_approver: approver });
  if (error) throw error;
  await admin.from("staff_line_links").update({ rich_menu_id: approver }).eq("line_user_id", lineUserId);
}

async function ensureRichMenu(lineUserId: string, actor: Record<string, any>) {
  const { data } = await admin.rpc("line_rich_menu_settings");
  const settings = data?.[0], approver = ["admin", "owner", "founder"].includes(actor.role);
  const desired = approver ? settings?.approver_rich_menu_id : settings?.member_rich_menu_id;
  if (!desired || desired === actor.rich_menu_id) return;
  await lineApi(`/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${desired}`, { method: "POST" });
  await admin.from("staff_line_links").update({ rich_menu_id: desired }).eq("line_user_id", lineUserId);
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

const sessionExpiry = () => new Date(Date.now() + 30 * 60_000).toISOString();

async function sessionFor(lineUserId: string) {
  const { data } = await admin.from("line_sessions").select("*").eq("line_user_id", lineUserId)
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  return data;
}

async function saveSession(lineUserId: string, values: Record<string, unknown>) {
  return admin.from("line_sessions").update({ ...values, expires_at: sessionExpiry(), updated_at: new Date().toISOString() })
    .eq("line_user_id", lineUserId);
}

async function catalog() {
  const { data, error } = await admin.rpc("line_product_catalog");
  return { products: (data || []) as LineProduct[], error };
}

function addSessionLine(lines: Array<Record<string, any>>, product: LineProduct, qty: number, purpose: string) {
  const next = lines.map(line => ({ ...line }));
  const existing = next.find(line => line.item_id === product.id);
  if (existing) existing.qty = Number(existing.qty) + qty;
  else next.push({ item_id: product.id, code: product.code || "", model: product.model || "", qty, purpose, return_required: false, line_note: "" });
  return next;
}

function lineList(session: Record<string, any>) {
  const lines = Array.isArray(session.lines) ? session.lines : [];
  if (!lines.length) return "ยังไม่มีสินค้าในคำขอ";
  return lines.map((line: any, index: number) => `${index + 1}. ${line.model || line.code || line.item_id} × ${line.qty}`).join("\n");
}

async function handleDispatchPostback(event: Record<string, any>, lineUserId: string, actor: Record<string, any>, action: string, reference: string) {
  const session = await sessionFor(lineUserId);
  if (!session || session.actor_user_id !== actor.user_id) return replySafely(event.replyToken, textMessage("รายการหมดอายุแล้ว กรุณาพิมพ์ ขอเบิกสินค้า เพื่อเริ่มใหม่"));
  if (action === "dispatch_cancel") {
    await admin.from("line_sessions").delete().eq("line_user_id", lineUserId);
    return replySafely(event.replyToken, textMessage("ยกเลิกคำขอแล้ว"));
  }
  if (action === "dispatch_edit") {
    await saveSession(lineUserId, { step: "items" });
    return replySafely(event.replyToken, textMessage(`กลับมาแก้ไขรายการแล้ว\n${lineList(session)}\nพิมพ์สินค้าเพิ่ม, ลบ <ลำดับ> หรือ เสร็จ`));
  }
  if (action === "purpose" && ["sale", "gift", "claim", "other"].includes(reference)) {
    await saveSession(lineUserId, { step: "items", purpose: reference });
    return replySafely(event.replyToken, textMessage("พิมพ์สินค้าแต่ละบรรทัดเป็น <รหัส/รุ่น/คำค้น> <จำนวน>\nเช่น 5991301242T 3\nเมื่อครบแล้วพิมพ์ เสร็จ"));
  }
  if (action === "pick") {
    const pending = session.pending_match || {};
    if (session.step !== "items" || !Array.isArray(pending.candidate_ids) || !pending.candidate_ids.includes(reference))
      return replySafely(event.replyToken, textMessage("ตัวเลือกนี้หมดอายุแล้ว กรุณาพิมพ์สินค้าอีกครั้ง"));
    const { products, error } = await catalog();
    const product = products.find(item => item.id === reference), qty = Number(pending.qty || 0);
    if (error || !product || !Number.isInteger(qty) || qty <= 0) return replySafely(event.replyToken, textMessage("เลือกสินค้าไม่สำเร็จ กรุณาลองใหม่"));
    const currentLines = Array.isArray(session.lines) ? session.lines : [];
    const existingQty = Number(currentLines.find((line: any) => line.item_id === product.id)?.qty || 0);
    if (existingQty + qty > Number(product.balance || 0)) return replySafely(event.replyToken, textMessage(`ยอดคงเหลือไม่พอ คงเหลือ ${Number(product.balance || 0).toLocaleString("th-TH")} ชิ้น`));
    const lines = addSessionLine(currentLines, product, qty, session.purpose);
    await saveSession(lineUserId, { lines, pending_match: null });
    return replySafely(event.replyToken, textMessage(`เพิ่ม ${product.model || product.code} × ${qty} แล้ว`));
  }
  if (action === "dispatch_confirm") {
    if (session.step !== "confirm" || !Array.isArray(session.lines) || !session.lines.length)
      return replySafely(event.replyToken, textMessage("รายการยังไม่พร้อมส่ง กรุณาตรวจสอบอีกครั้ง"));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const { data: requestId, error } = await admin.rpc("create_dispatch_request_as", {
      p_actor: actor.user_id, p_document_date: today, p_delivery_date: today, p_customer: session.customer,
      p_doc_no: "", p_dept: "LINE", p_sale: "", p_note: "สร้างผ่าน LINE Bot", p_lines: session.lines,
    });
    if (error) return replySafely(event.replyToken, textMessage("ส่งคำขอไม่สำเร็จ กรุณาตรวจยอดคงเหลือหรือลองในเว็บ"));
    await admin.from("line_sessions").delete().eq("line_user_id", lineUserId);
    const { data: request } = await admin.from("dispatch_requests").select("delivery_note_no,status").eq("id", requestId).single();
    const state = request?.status === "approved" ? "อนุมัติและตัดยอดแล้ว" : "รออนุมัติ";
    return replySafely(event.replyToken, textMessage(`ส่งคำขอสำเร็จ ${request?.delivery_note_no || ""}\nสถานะ: ${state}`));
  }
  return replySafely(event.replyToken, textMessage("ปุ่มนี้ใช้ไม่ได้ในขั้นตอนปัจจุบัน"));
}

async function handlePostback(event: Record<string, any>, lineUserId: string, actor: Record<string, any>) {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(String(event.postback?.data || "")); } catch { /* invalid button */ }
  const action = typeof payload.a === "string" ? payload.a : "";
  const requestId = typeof payload.r === "string" ? payload.r : "";
  if (["dispatch_cancel", "dispatch_edit", "dispatch_confirm", "purpose", "pick"].includes(action))
    return handleDispatchPostback(event, lineUserId, actor, action, requestId);
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
  if (text === "ตั้งค่าเมนู") {
    if (actor.role !== "founder") return replySafely(event.replyToken, textMessage("คำสั่งนี้ใช้ได้เฉพาะผู้ก่อตั้ง"));
    try { await setupRichMenus(lineUserId); return replySafely(event.replyToken, textMessage("ติดตั้งเมนู LINE สำเร็จแล้ว")); }
    catch (error) { console.error("rich menu setup failed", error instanceof Error ? error.message : "unknown"); return replySafely(event.replyToken, textMessage("ติดตั้งเมนูไม่สำเร็จ กรุณาลองอีกครั้ง")); }
  }
  if (text === "ยกเลิก") {
    await Promise.all([
      admin.from("line_action_sessions").delete().eq("line_user_id", lineUserId),
      admin.from("line_sessions").delete().eq("line_user_id", lineUserId),
    ]);
    return replySafely(event.replyToken, textMessage("ยกเลิกรายการแล้ว"));
  }
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
  if (text === "คำขอของฉัน") {
    const { data, error } = await admin.rpc("line_my_dispatch_requests", { p_actor: actor.user_id });
    if (error) return replySafely(event.replyToken, textMessage("โหลดรายการไม่สำเร็จ กรุณาลองใหม่"));
    if (!data?.length) return replySafely(event.replyToken, textMessage("ยังไม่มีคำขอเบิกสินค้า"));
    return replySafely(event.replyToken, myRequestsFlex(data));
  }
  if (text === "วิธีใช้") return replySafely(event.replyToken, textMessage(
    "คำสั่ง LINE Bot\n• ขอเบิกสินค้า — เริ่มสร้างคำขอ\n• คำขอของฉัน — ดู 10 รายการล่าสุด\n• รออนุมัติ — สำหรับผู้มีสิทธิ์อนุมัติ\n• ยกเลิก — ยกเลิกรายการที่กำลังทำ",
  ));
  if (text === "ขอเบิกสินค้า") {
    const { error } = await admin.from("line_sessions").upsert({
      line_user_id: lineUserId, actor_user_id: actor.user_id, step: "customer", customer: "",
      purpose: null, lines: [], pending_match: null, expires_at: sessionExpiry(), updated_at: new Date().toISOString(),
    }, { onConflict: "line_user_id" });
    return replySafely(event.replyToken, textMessage(error ? "เริ่มคำขอไม่สำเร็จ กรุณาลองใหม่" : "กรุณาพิมพ์ชื่อลูกค้าหรือสถานที่ปลายทาง"));
  }

  const session = await sessionFor(lineUserId);
  if (session?.actor_user_id === actor.user_id) {
    if (session.step === "customer") {
      if (text.length < 2 || text.length > 300) return replySafely(event.replyToken, textMessage("กรุณาระบุชื่อลูกค้าหรือปลายทาง 2–300 ตัวอักษร"));
      await saveSession(lineUserId, { customer: text, step: "purpose" });
      return replySafely(event.replyToken, quickReplyMessage("เลือกวัตถุประสงค์", [
        { label: "ขาย", data: postbackData("purpose", "sale") },
        { label: "แถม", data: postbackData("purpose", "gift") },
        { label: "เคลม", data: postbackData("purpose", "claim") },
        { label: "อื่นๆ", data: postbackData("purpose", "other") },
      ]));
    }
    if (session.step === "purpose") {
      const purposes: Record<string, string> = { "ขาย": "sale", "แถม": "gift", "เคลม": "claim", "อื่นๆ": "other", sale: "sale", gift: "gift", claim: "claim", other: "other" };
      if (!purposes[text.toLowerCase()]) return replySafely(event.replyToken, textMessage("กรุณาเลือกวัตถุประสงค์จากปุ่ม: ขาย / แถม / เคลม / อื่นๆ"));
      await saveSession(lineUserId, { purpose: purposes[text.toLowerCase()], step: "items" });
      return replySafely(event.replyToken, textMessage("พิมพ์สินค้าเป็น <รหัส/รุ่น/คำค้น> <จำนวน> บรรทัดละหนึ่งรายการ\nเช่น 5991301242T 3\nเมื่อครบแล้วพิมพ์ เสร็จ"));
    }
    if (session.step === "confirm") return replySafely(event.replyToken, dispatchSummaryFlex(session));
    if (session.step === "items") {
      if (text === "ดูรายการ") return replySafely(event.replyToken, textMessage(lineList(session)));
      if (text === "เสร็จ") {
        if (!Array.isArray(session.lines) || !session.lines.length) return replySafely(event.replyToken, textMessage("กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ"));
        await saveSession(lineUserId, { step: "confirm", pending_match: null });
        return replySafely(event.replyToken, dispatchSummaryFlex(session));
      }
      const remove = text.match(/^ลบ\s+(\d+)$/);
      if (remove) {
        const lines = Array.isArray(session.lines) ? [...session.lines] : [], index = Number(remove[1]) - 1;
        if (index < 0 || index >= lines.length) return replySafely(event.replyToken, textMessage("ไม่พบลำดับที่ต้องการลบ พิมพ์ ดูรายการ เพื่อตรวจสอบ"));
        const [deleted] = lines.splice(index, 1);
        await saveSession(lineUserId, { lines, pending_match: null });
        return replySafely(event.replyToken, textMessage(`ลบ ${deleted.model || deleted.code || "สินค้า"} แล้ว\n${lineList({ lines })}`));
      }
      const entries = text.split(/[\r\n]+/).map(value => value.trim()).filter(Boolean);
      const parsed = entries.map(value => value.match(/^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/));
      if (!parsed.length || parsed.some(value => !value || !Number.isInteger(Number(value[2])) || Number(value[2]) <= 0))
        return replySafely(event.replyToken, textMessage("รูปแบบไม่ถูกต้อง กรุณาพิมพ์ <รหัส/รุ่น/คำค้น> <จำนวนเต็มบวก> บรรทัดละหนึ่งรายการ"));
      const { products, error } = await catalog();
      if (error) return replySafely(event.replyToken, textMessage("โหลดรายการสินค้าไม่สำเร็จ กรุณาลองใหม่"));
      let lines = Array.isArray(session.lines) ? session.lines : [];
      const added: string[] = [];
      for (const match of parsed) {
        const query = match![1].trim(), qty = Number(match![2]);
        const result = matchLineProducts(query, products);
        if (!result.match) {
          if (!result.candidates.length) return replySafely(event.replyToken, textMessage(`ไม่พบสินค้า “${query}” กรุณาตรวจรหัสหรือชื่อรุ่น`));
          await saveSession(lineUserId, { lines, pending_match: { qty, candidate_ids: result.candidates.map(row => row.product.id) } });
          return replySafely(event.replyToken, quickReplyMessage(`พบหลายรายการสำหรับ “${query}” กรุณาเลือก`, result.candidates.map(row => ({
            label: row.product.model || row.product.code || row.product.id,
            data: postbackData("pick", row.product.id),
          }))));
        }
        const product = result.match, existingQty = Number(lines.find((line: any) => line.item_id === product.id)?.qty || 0);
        if (existingQty + qty > Number(product.balance || 0))
          return replySafely(event.replyToken, textMessage(`${product.model || product.code}: ยอดคงเหลือไม่พอ คงเหลือ ${Number(product.balance || 0).toLocaleString("th-TH")} ชิ้น`));
        lines = addSessionLine(lines, product, qty, session.purpose);
        added.push(`${product.model || product.code} × ${qty}`);
      }
      await saveSession(lineUserId, { lines, pending_match: null });
      return replySafely(event.replyToken, textMessage(`เพิ่มแล้ว\n${added.join("\n")}\n\nพิมพ์สินค้าเพิ่ม, ดูรายการ, ลบ <ลำดับ> หรือ เสร็จ`));
    }
  }
  return replySafely(event.replyToken, textMessage("คำสั่งที่ใช้ได้: ขอเบิกสินค้า, คำขอของฉัน, รออนุมัติ, วิธีใช้"));
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
    try { await ensureRichMenu(lineUserId, actor); } catch (error) { console.error("rich menu link failed", error instanceof Error ? error.message : "unknown"); }
    if (event.type === "postback") await handlePostback(event, lineUserId, actor);
    else if (event.type === "message" && event.message?.type === "text") await handleText(event, lineUserId, actor, String(event.message.text || "").trim());
  }
  return json({ ok: true });
});
