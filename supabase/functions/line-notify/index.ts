import { createClient } from "npm:@supabase/supabase-js@2";
import { buildNotificationFlex, json, lineRequest } from "../_shared/line.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const accessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
if (!projectUrl || !serviceKey || !accessToken) throw new Error("Required function secrets are unavailable");
const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const siteUrl = "https://jeaof-hub.github.io/sweeo-stock/";

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
      .select("id,request_id,recipient_user_id,kind,attempts").eq("id", id).single();
    if (jobError || !job?.recipient_user_id) throw new Error("Outbox record unavailable");
    const [{ data: requestRow, error: requestError }, { data: link, error: linkError }, { data: staff, error: staffError }, { data: lines, error: linesError }] = await Promise.all([
      admin.from("dispatch_requests").select("id,delivery_note_no,status,customer,requester_id,rejection_reason").eq("id", job.request_id).single(),
      admin.from("staff_line_links").select("line_user_id,active").eq("user_id", job.recipient_user_id).eq("active", true).single(),
      admin.from("staff").select("name,preferred_language,is_active,role").eq("user_id", job.recipient_user_id).single(),
      admin.from("dispatch_request_lines").select("item_id,code,model,requested_qty,approved_qty,purpose").eq("request_id", job.request_id).order("id"),
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
