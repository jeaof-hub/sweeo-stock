/* Pure helpers for the delivery-note list. Database RLS remains the source of row visibility. */
(function (root) {
  "use strict";
  const allowedRoles = new Set(["warehouse", "admin", "owner", "founder"]);
  function canSeeDeliveryNotes(role) { return allowedRoles.has(role); }
  function invoiceState(request, lines) {
    if (request?.status !== "approved") return "";
    const own = lines.filter(line => line.request_id === request.id);
    const done = own.filter(line => line.invoice_id || line.no_invoice_reason).length;
    return !done ? "รอ INV" : done < own.length ? "INV บางส่วน" : "ครบ";
  }
  function thaiDate(value) {
    const match = String(value || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${Number(match[1]) + 543}` : "";
  }
  function filterRequests(requests, { query = "", status = "" } = {}) {
    const needle = query.trim().toLowerCase();
    return [...requests].filter(request => {
      if (status && request.status !== status) return false;
      if (!needle) return true;
      return [request.delivery_note_no, request.customer, request.document_date, request.delivery_date, thaiDate(request.document_date), thaiDate(request.delivery_date)]
        .some(value => String(value || "").toLowerCase().includes(needle));
    }).sort((a, b) => String(b.created_at || b.document_date || "").localeCompare(String(a.created_at || a.document_date || "")));
  }
  function printLabel(status) {
    if (status === "approved") return "พิมพ์ / บันทึก PDF";
    if (status === "pending") return "ดูใบส่งของฉบับร่าง";
    return "";
  }
  root.SWEEO_DISPATCH_VIEW = { canSeeDeliveryNotes, invoiceState, filterRequests, printLabel };
})(window);
