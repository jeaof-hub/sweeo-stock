export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const encoder = new TextEncoder();

export async function verifyLineSignature(rawBody: string, received: string | null, secret: string) {
  if (!received || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  let binary = "";
  signed.forEach(byte => { binary += String.fromCharCode(byte); });
  const expected = btoa(binary);
  if (expected.length !== received.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  return difference === 0;
}

export async function lineRequest(path: string, accessToken: string, body: unknown) {
  return fetch(`https://api.line.me${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function replyLine(replyToken: string | undefined, accessToken: string, messages: unknown[]) {
  if (!replyToken) return;
  const response = await lineRequest("/v2/bot/message/reply", accessToken, { replyToken, messages });
  if (!response.ok) throw new Error(`LINE reply failed (${response.status})`);
}

export const textMessage = (text: string) => ({ type: "text", text: text.slice(0, 5000) });

type FlexInput = {
  kind: "pending" | "result";
  lang: string;
  request: Record<string, unknown>;
  requesterName: string;
  lines: Array<Record<string, unknown>>;
  itemNames: Map<string, string>;
  siteUrl: string;
};

export function buildNotificationFlex(input: FlexInput) {
  const zh = input.lang === "zh-TW";
  const request = input.request;
  const lines = input.lines;
  const shown = lines.slice(0, 10);
  const total = lines.reduce((sum, line) => sum + Number(line.approved_qty ?? line.requested_qty ?? 0), 0);
  const purposes = [...new Set(lines.map(line => String(line.purpose || "sale")))];
  const purposeLabels: Record<string, Record<string, string>> = {
    th: { sale: "ขาย", gift: "แถม", claim: "เคลม", other: "อื่น ๆ" },
    zh: { sale: "銷售", gift: "贈品", claim: "索賠", other: "其他" },
  };
  const labels = zh ? {
    pending: "待審核出庫申請", approved: "已核准", rejected: "已拒絕", requester: "申請人",
    destination: "客戶／目的地", purpose: "用途", total: "總數", more: "另有", open: "在網頁開啟",
  } : {
    pending: "คำขอเบิกรออนุมัติ", approved: "อนุมัติแล้ว", rejected: "ปฏิเสธแล้ว", requester: "ผู้ขอ",
    destination: "ลูกค้า/ปลายทาง", purpose: "วัตถุประสงค์", total: "รวม", more: "อีก", open: "เปิดในเว็บ",
  };
  const status = String(request.status || "pending");
  const title = input.kind === "pending" ? labels.pending : (status === "approved" ? labels.approved : labels.rejected);
  const requestId = encodeURIComponent(String(request.id || ""));
  const url = `${input.siteUrl}?tab=pending&request=${requestId}`;
  const itemRows = shown.map(line => ({
    type: "box", layout: "horizontal", spacing: "sm",
    contents: [
      { type: "text", text: input.itemNames.get(String(line.item_id)) || String(line.model || line.code || "–"), size: "sm", wrap: true, flex: 4 },
      { type: "text", text: String(line.approved_qty ?? line.requested_qty ?? 0), size: "sm", align: "end", flex: 1 },
    ],
  }));
  if (lines.length > 10) itemRows.push({
    type: "box", layout: "horizontal",
    contents: [{ type: "text", text: `${labels.more} ${lines.length - 10} ${zh ? "項" : "รายการ"}`, size: "xs", color: "#777777" }],
  });
  const purposeMap = zh ? purposeLabels.zh : purposeLabels.th;
  const altText = `${title} ${String(request.delivery_note_no || "")}`.trim();
  return {
    type: "flex", altText,
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: "#F78325", paddingAll: "16px", contents: [
        { type: "text", text: title, color: "#FFFFFF", weight: "bold", size: "lg" },
        { type: "text", text: String(request.delivery_note_no || "–"), color: "#FFFFFF", size: "sm" },
      ] },
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
        { type: "box", layout: "vertical", spacing: "xs", contents: [
          { type: "text", text: `${labels.requester}: ${input.requesterName || "–"}`, size: "sm", wrap: true },
          { type: "text", text: `${labels.destination}: ${String(request.customer || "–")}`, size: "sm", wrap: true },
          { type: "text", text: `${labels.purpose}: ${purposes.map(value => purposeMap[value] || value).join(", ")}`, size: "sm", wrap: true },
        ] },
        { type: "separator" },
        { type: "box", layout: "vertical", spacing: "sm", contents: itemRows },
        { type: "separator" },
        { type: "text", text: `${labels.total}: ${total.toLocaleString(zh ? "zh-TW" : "th-TH")} ${zh ? "件" : "ชิ้น"}`, weight: "bold", align: "end" },
      ] },
      footer: { type: "box", layout: "vertical", contents: [
        { type: "button", style: "primary", color: "#F78325", action: { type: "uri", label: labels.open, uri: url } },
      ] },
    },
  };
}
