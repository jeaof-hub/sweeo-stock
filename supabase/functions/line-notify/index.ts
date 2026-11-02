import { createClient } from "npm:@supabase/supabase-js@2";
import { buildNotificationFlex, json, lineRequest } from "../_shared/line.ts";
import { buildRevisionFlex } from "./revision.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const accessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
if (!projectUrl || !serviceKey || !accessToken) throw new Error("Required function secrets are unavailable");
const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const siteUrl = "https://jeaof-hub.github.io/sweeo-stock/";

async function finishPush(id: string, response: Response) {
  if (response.ok) {
    await admin.rpc("line_finish_notification", { p_id: id, p_status: "sent", p_error: null });
    return json({ ok: true });
  }
  const responseBody = await response.text();
  const quota = response.status === 429 || /monthly limit/i.test(responseBody);
  await admin.rpc("line_finish_notification", {
    p_id: id, p_status: quota ? "quota_exceeded" : "failed",
    p_error: quota ? "LINE monthly quota exceeded" : `LINE push failed (${response.status})`,
  });
  return json({ ok: false, retryable: !quota }, quota ? 200 : 502);
}

async function sendRevision(id: string, job: Record<string, any>) {
  if (!job.ref_id) throw new Error("Revision reference missing");
  const [{ data: requestRow, error: requestError }, { data: link, error: linkError }, { data: staff, error: staffError }] = await Promise.all([
    admin.from("dispatch_requests").select("id,delivery_note_no,customer").eq("id", job.request_id).single(),
    admin.from("staff_line_links").select("line_user_id,active").eq("user_id", job.recipient_user_id).eq("active", true).single(),
    admin.from("staff").select("preferred_language,is_active").eq("user_id", job.recipient_user_id).single(),
  ]);
  if (requestError || linkError || staffError || !staff?.is_active || !link?.active) throw new Error("Notification recipient unavailable");
  let itemId = "", requesterId = "", fromQty: number | null = null, toQty = 0, purpose = "sale", reason = "";
  if (job.kind === "add_line") {
    const { data: a, error } = await admin.from("dispatch_line_additions")
      .select("item_id,qty,purpose,line_note,requested_by").eq("id", job.ref_id).single();
    if (error || !a) throw new Error("Addition unavailable");
    itemId = a.item_id; requesterId = a.requested_by; toQty = Number(a.qty); purpose = a.purpose; reason = a.line_note || "";
  } else {
    const { data: l, error } = await admin.from("dispatch_request_lines")
      .select("item_id,approved_qty,qty_change_requested_qty,qty_change_reason,qty_change_requested_by").eq("id", job.ref_id).single();
    if (error || !l) throw new Error("Quantity change unavailable");
    itemId = l.item_id; requesterId = l.qty_change_requested_by; fromQty = Number(l.approved_qty);
    toQty = Number(l.qty_change_requested_qty); reason = l.qty_change_reason || "";
  }
  const [{ data: item }, { data: requester }] = await Promise.all([
    admin.from("items").select("model,spec,code").eq("id", itemId).maybeSingle(),
    admin.from("staff").select("name").eq("user_id", requesterId).maybeSingle(),
  ]);
  const message = buildRevisionFlex({
    kind: job.kind, lang: staff.preferred_language, request: requestRow, itemName: item?.model || item?.spec || item?.code || itemId,
    requesterName: requester?.name || "–", fromQty, toQty, purpose, reason, siteUrl,
  });
  const response = await lineRequest("/v2/bot/message/push", accessToken!, { to: link.line_user_id, messages: [message] });
  return finishPush(id, response);
}

Deno.serve(async request => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let payload: Record<string, any>;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const id = String(payload.record?.id || payload.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Invalid outbox id" }, 400);

  const { data: claimed, error: claimError } = await admin.rpc("line_claim_notification", { p_id: id });
  if (claimError) { console.error("outbox claim failed", claimError.code); return json({ error: "Claim failed" }, 500); }
  if (!claimed) return json({ ok: true, skipped: true });

  try {
    const { data: job, error: jobError } = await admin.from("notification_outbox")
      .select("id,request_id,recipient_user_id,kind,attempts,ref_id").eq("id", id).single();
    if (jobError || !job?.recipient_user_id) throw new Error("Outbox record unavailable");
    if (job.kind === "qty_change" || job.kind === "add_line") return await sendRevision(id, job);
    const [{ data: requestRow, error: requestError }, { data: link, error: linkError }, { data: staff, error: staffError }, { data: lines, error: linesError }] = await Promise.all([
      admin.from("dispatch_requests").select("id,delivery_note_no,status,customer,requester_id,rejection_reason").eq("id", job.request_id).single(),
      admin.from("staff_line_links").select("line_user_id,active").eq("user_id", job.recipient_user_id).eq("active", true).single(),
      admin.from("staff").select("name,preferred_language,is_active,role").eq("user_id", job.recipient_user_id).single(),
      admin.from("dispatch_request_lines").select("item_id,code,model,requested_qty,approved_qty,purpose").eq("request_id", job.request_id).is("voided_at", null).order("id"),
    ]);
    if (requestError || linkError || staffError || linesError || !staff?.is_active || !link?.active) throw new Error("Notification recipient unavailable");
    const itemIds = [...new Set((lines || []).map(line => line.item_id).filter(Boolean))];
    const { data: itemRows, error: itemError } = itemIds.length
      ? await admin.from("items").select("id,model,spec,code").in("id", itemIds)
      : { data: [], error: null };
    if (itemError) throw new Error("Notification items unavailable");
    const { data: requester } = await admin.from("staff").select("name").eq("user_id", requestRow.requester_id).maybeSingle();
    const itemNames = new Map((itemRows || []).map(item => [String(item.id), item.model || item.spec || item.code || "–"]));
    const message = buildNotificationFlex({ kind: job.kind, lang: staff.preferred_language, request: requestRow,
      requesterName: requester?.name || "–", lines: lines || [], itemNames, siteUrl });
    const response = await lineRequest("/v2/bot/message/push", accessToken!, { to: link.line_user_id, messages: [message] });
    if (response.ok) {
      await admin.rpc("line_finish_notification", { p_id: id, p_status: "sent", p_error: null });
      return json({ ok: true });
    }
    const responseBody = await response.text();
    const quota = response.status === 429 || /monthly limit/i.test(responseBody);
    await admin.rpc("line_finish_notification", {
      p_id: id, p_status: quota ? "quota_exceeded" : "failed",
      p_error: quota ? "LINE monthly quota exceeded" : `LINE push failed (${response.status})`,
    });
    return json({ ok: false, retryable: !quota }, quota ? 200 : 502);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification failed";
    await admin.rpc("line_finish_notification", { p_id: id, p_status: "failed", p_error: message });
    console.error("LINE notification failed", message);
    return json({ error: "Notification failed" }, 500);
  }
});
