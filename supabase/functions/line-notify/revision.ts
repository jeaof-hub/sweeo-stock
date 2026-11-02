const purposeNames: Record<string, Record<string, string>> = {
  th: { sale: "ขาย", gift: "แถม", claim: "เคลม", other: "อื่น ๆ" },
  zh: { sale: "銷售", gift: "贈品", claim: "索賠", other: "其他" },
};

// Flex card for a pending revision of an approved delivery note (quantity change or added product).
export function buildRevisionFlex(input: {
  kind: "qty_change" | "add_line"; lang: string; request: Record<string, unknown>; itemName: string;
  requesterName: string; fromQty: number | null; toQty: number; purpose: string; reason: string; siteUrl: string;
}) {
  const zh = input.lang === "zh-TW";
  const t = zh ? {
    qty_change: "待核准：修改數量", add_line: "待核准：新增商品", note: "送貨單", customer: "客戶／目的地",
    requester: "申請人", item: "商品", qty: "數量", purpose: "用途", reason: "原因／備註", open: "在網頁開啟審核", unit: "件",
  } : {
    qty_change: "ขออนุมัติแก้จำนวน", add_line: "ขออนุมัติเพิ่มสินค้า", note: "ใบส่งของ", customer: "ลูกค้า/ปลายทาง",
    requester: "ผู้ขอ", item: "สินค้า", qty: "จำนวน", purpose: "วัตถุประสงค์", reason: "เหตุผล/หมายเหตุ", open: "เปิดในเว็บเพื่ออนุมัติ", unit: "ชิ้น",
  };
  const locale = zh ? "zh-TW" : "th-TH";
  const qtyText = input.fromQty == null
    ? `${input.toQty.toLocaleString(locale)} ${t.unit}`
    : `${input.fromQty.toLocaleString(locale)} → ${input.toQty.toLocaleString(locale)} ${t.unit}`;
  const purposes = zh ? purposeNames.zh : purposeNames.th;
  const row = (label: string, value: string) => ({ type: "text", text: `${label}: ${value || "–"}`, size: "sm", wrap: true });
  const url = `${input.siteUrl}?tab=pending&request=${encodeURIComponent(String(input.request.id || ""))}`;
  const title = t[input.kind];
  return {
    type: "flex", altText: `${title} ${String(input.request.delivery_note_no || "")}`.trim(),
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: "#D99A00", paddingAll: "16px", contents: [
        { type: "text", text: title, color: "#FFFFFF", weight: "bold", size: "lg", wrap: true },
        { type: "text", text: `${t.note} ${String(input.request.delivery_note_no || "–")}`, color: "#FFFFFF", size: "sm" },
      ] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        row(t.customer, String(input.request.customer || "")),
        row(t.requester, input.requesterName),
        { type: "separator", margin: "md" },
        row(t.item, input.itemName),
        { type: "text", text: `${t.qty}: ${qtyText}`, size: "md", weight: "bold", wrap: true },
        ...(input.kind === "add_line" ? [row(t.purpose, purposes[input.purpose] || input.purpose)] : []),
        ...(input.reason ? [row(t.reason, input.reason)] : []),
      ] },
      footer: { type: "box", layout: "vertical", contents: [
        { type: "button", style: "primary", color: "#F78325", action: { type: "uri", label: t.open, uri: url } },
      ] },
    },
  };
}
