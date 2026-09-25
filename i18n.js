/* Interface translations only. Product names and stock records keep their stored values. */
(() => {
  "use strict";
  const lang = localStorage.getItem("sweeo-language") === "en" ? "en" : "th";
  window.SWEEO_I18N = { lang };
  document.documentElement.lang = lang;
  if (lang === "en") document.title = "SWEEO Stock";

  const english = {
    "สต็อกสินค้า SWEEO": "SWEEO Stock",
    "กำลังโหลดข้อมูล": "Loading stock",
    "ผู้เยี่ยมชม": "Visitor", "ผู้ตรวจสอบ": "Auditor", "คลังสินค้า": "Warehouse", "แอดมิน": "Admin", "เจ้าของ": "Owner", "ผู้ก่อตั้ง": "Founder",
    "เข้าสู่ระบบ": "Sign in", "บัญชี": "Account", "ส่งออก Excel": "Export Excel", "จัดการผู้ใช้": "Manage users", "เปลี่ยนรหัสผ่าน": "Change password", "ออกจากระบบ": "Sign out",
    "สต็อก": "Stock", "ประวัติรับเข้า/ส่งออก": "Stock movements", "รายการที่ถูกลบ": "Deleted entries", "บันทึกการเปลี่ยนแปลง": "Change log",
    "ค้นหารุ่น รหัสสินค้า หรือสเปก": "Search model, product code or specification", "ค้นหาสินค้า": "Search products", "สถานะสต็อก": "Stock status",
    "ประเภทสินค้า": "Product type", "ทุกประเภท": "All types", "แผนก": "Department", "ทุกแผนก": "All departments", "เรียงลำดับ": "Sort by",
    "เรียงตามรายการเดิม": "Original order", "คงเหลือ มาก → น้อย": "Balance: high to low", "คงเหลือ น้อย → มาก": "Balance: low to high", "ขายต่อเดือน มากสุด": "Monthly sales: high to low", "ใกล้หมดก่อน": "Lowest cover first", "ซ่อนรายการที่คงเหลือ 0": "Hide zero balance",
    "เพิ่มสินค้าใหม่": "Add product", "ค้นหาลูกค้า เลขเอกสาร หรือรุ่น": "Search customer, document or model", "ค้นหาประวัติ": "Search movements",
    "เดือน": "Month", "ประเภทรายการ": "Movement type", "รับเข้าและส่งออก": "Receipts and dispatches", "เฉพาะส่งออก": "Dispatches only", "เฉพาะรับเข้า": "Receipts only",
    "บันทึกส่งออก": "Record dispatch", "บันทึกรับเข้า": "Record receipt", "ปิด": "Close", "ยกเลิก": "Cancel", "บันทึก": "Save", "ลบ": "Delete",
    "สำหรับพนักงานที่ได้รับบัญชีจากผู้ดูแลระบบ": "For team members with an account created by an administrator", "อีเมล": "Email", "รหัสผ่าน": "Password", "ลืมรหัสผ่าน ติดต่อผู้ดูแลระบบเพื่อรีเซ็ต": "Forgot your password? Contact an administrator to reset it.",
    "รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)": "New password (at least 8 characters)", "ยืนยันรหัสผ่านใหม่": "Confirm new password", "บันทึกรหัสผ่าน": "Save password",
    "ผู้ก่อตั้งและเจ้าของสร้างบัญชีและกำหนดสิทธิ์ได้ โดยแก้บัญชีผู้ก่อตั้งไม่ได้": "Founders and Owners can create accounts and assign roles. The Founder account cannot be managed here.",
    "สร้างบัญชีสมาชิก": "Create team account", "ชื่อที่แสดง": "Display name", "สิทธิ์": "Role", "รหัสผ่านเริ่มต้น (8–128 ตัวอักษร)": "Initial password (8–128 characters)", "ยืนยันรหัสผ่าน": "Confirm password",
    "บัญชีจะใช้งานได้ทันที ไม่มีอีเมลเชิญ กรุณาแจ้งรหัสผ่านให้เจ้าของบัญชีด้วยช่องทางที่คุณเลือก": "The account is ready immediately. No invitation email is sent. Share the password privately with its owner.",
    "สร้างบัญชี": "Create account", "สมาชิกทีม": "Team members", "กำลังโหลดรายชื่อ": "Loading team members", "ตั้งรหัสผ่านสมาชิก": "Set member password", "รหัสผ่านใหม่ (8–128 ตัวอักษร)": "New password (8–128 characters)", "รหัสผ่านเดิมจะใช้ไม่ได้อีกต่อไป ระบบจะไม่ส่งอีเมล": "The old password will stop working. No email will be sent.",
    "วันที่": "Date", "เลขที่ INV / เอกสาร": "Invoice / document number", "ลูกค้า": "Customer", "แผนก / ประเภทงาน": "Department / job type", "เซลส์": "Salesperson", "หมายเหตุ": "Notes", "เพิ่มสินค้าอีกรายการ": "Add another product",
    "ปรับยอดตามการตรวจนับ": "Adjust to stock count", "จำนวนที่นับได้จริง": "Counted quantity", "วันที่นับ": "Count date", "เช่น นับซ้ำแล้ว ผู้นับ": "For example, recount completed and counted by", "บันทึกการปรับยอด": "Save adjustment",
    "รหัสสินค้า (Lot No.)": "Product code (Lot No.)", "รุ่น (Model No.)": "Model (Model No.)", "สเปก": "Specification", "ประเภท": "Type", "ที่เก็บ": "Storage location", "ยอดยกมา": "Opening balance", "ขายเฉลี่ยต่อเดือน": "Average monthly sales", "จุดสั่งผลิต (ROP)": "Reorder point (ROP)", "บันทึกข้อมูลสินค้า": "Save product",
    "ไม่ลบ": "Keep entry", "ลบรายการ": "Delete entry", "ลบรายการนี้": "Delete this entry",
    "รายการทั้งหมด": "All products", "ต้องสั่งผลิต": "Reorder needed", "ใกล้ถึงจุดสั่ง": "Near reorder point", "ปกติ": "Normal", "คงเหลือติดลบ": "Negative balance", "คงเหลือ": "Balance", "จุดสั่งผลิต": "Reorder point", "รับเข้า": "Receipt", "ส่งออก": "Dispatch", "ชิ้น": "units",
    "ยังไม่มีข้อมูลสินค้า": "No products yet", "กดเพิ่มสินค้าใหม่ หรือนำเข้าข้อมูลตามคู่มือ": "Add a product or import data using the setup guide.", "ยังไม่มีสินค้าที่แสดงได้": "No products to display.", "ไม่พบรายการที่ตรงกับเงื่อนไข": "No matching products", "ลองลบคำค้นหา เปลี่ยนประเภท หรือยกเลิกตัวกรองด้านบน": "Try another search or clear the filters.",
    "ทุกเดือน": "All months", "ไม่ระบุวันที่": "No date", "ไม่มีรายการในช่วงนี้": "No movements in this period", "เปลี่ยนเดือนหรือตัวกรองด้านบน": "Change the month or filters above.", "ไม่พบสินค้า": "No products found",
    "ยังไม่มีรายการที่ถูกลบ": "No deleted entries", "โหลดรายการเก่าเพิ่ม": "Load older changes", "ยังไม่มีการเปลี่ยนแปลงหลังเปิดใช้ log": "No changes have been logged yet", "ก่อน": "Before", "หลัง": "After", "แก้ไข": "Edit", "เพิ่ม": "Add", "สินค้า": "Product", "รายการรับเข้า/ส่งออก": "Movement",
    "รหัสสินค้า": "Product code", "สอบถามรายละเอียดเพิ่มเติมกับฝ่ายขาย": "Contact the sales team for more details.", "ส่งออกรายการนี้": "Dispatch this product", "แก้ไขข้อมูลสินค้า": "Edit product", "พอขายอีกประมาณ": "Estimated cover", "ลูกค้า / เอกสาร": "Customer / document", "ผู้บันทึก": "Recorded by", "เอกสาร": "Document", "รหัส": "Code",
    "ยังไม่มีรายการรับเข้าหรือส่งออกของสินค้านี้": "No movements for this product yet.", "รหัสนี้ไม่อยู่ในรายการสินค้า": "This code is not in the product list.", "รายการนี้ไม่ถูกนับเข้าสต็อกของสินค้าใด เพราะรหัสไม่ตรงกับรายการสินค้า": "This movement is excluded from stock balances because its code does not match a product.",
    "ค้นหารุ่นหรือรหัสสินค้า": "Search model or product code", "จำนวน": "Quantity", "หน่วย": "Unit", "เลือกสินค้า": "Choose a product", "ลบแถว": "Remove row", "รับจาก / แหล่งที่มา": "Received from / source", "เลขที่เอกสารรับเข้า": "Receipt document number",
    "ตัดสต็อกตามใบส่งของ ใส่ได้หลายรายการในเอกสารเดียว": "Dispatch stock against a delivery document. Add several products to one document.", "เพิ่มสต็อกจากการรับสินค้าเข้าคลัง": "Add stock received into the warehouse.",
    "แก้ไขข้อมูลสินค้า": "Edit product", "สินค้าที่ยังไม่มีในรายการ": "A product not yet in the list", "ยอดยกมาแก้ไม่ได้ ถ้าคงเหลือไม่ตรง ให้ใช้ปรับยอดตามการนับ ซึ่งจะเก็บประวัติไว้": "The opening balance cannot be edited. Use a stock count adjustment to correct the balance and keep a record.", "สินค้าใหม่ส่วนใหญ่ให้ยอดยกมาเป็น 0 แล้วบันทึกรับเข้าตามจริง": "For most new products, set the opening balance to 0 and record actual receipts.",
    "ใช้งาน": "Active", "ปิดใช้งาน": "Disabled", "สถานะ": "Status", "บันทึกสิทธิ์แล้ว": "Role saved", "ตั้งรหัสผ่าน": "Set password", "ยังไม่มีสมาชิกทีม": "No team members yet.", "คุณ": "You", "พนักงาน": "Team member", "Google Sheet": "Google Sheet",
    "บัญชีที่ไม่อยู่ในทีม": "Account outside the team", "ระบบ/ผู้ดูแลฐานข้อมูล": "System / database administrator", "ระบบ": "System", "ไม่ระบุ": "Unspecified", "(ไม่ทราบรุ่น)": "(Unknown model)", "(ไม่มีชื่อรุ่น)": "(Unnamed model)", "(สินค้าที่ไม่อยู่ในรายการ)": "(Product not in list)"
  };

  Object.assign(english, {
    "ลิงก์เชิญหมดอายุแล้ว กรุณาขอ Foundator ส่งคำเชิญใหม่ แล้วเปิดลิงก์ใหม่ทันที": "The invitation link has expired. Ask an administrator for a new link and open it promptly.",
    "ลิงก์ยืนยันบัญชีใช้ไม่ได้ กรุณาขอ Foundator ส่งคำเชิญใหม่": "This account link is invalid. Ask an administrator for a new one.",
    "บัญชีนี้ยังไม่ได้รับสิทธิ์ ติดต่อ Foundator": "This account has no access. Contact an administrator.",
    "ตั้งรหัสผ่านของคุณ": "Set your password", "อีเมลหรือรหัสผ่านไม่ถูกต้อง": "Incorrect email or password", "เข้าสู่ระบบแล้ว": "Signed in", "ออกจากระบบแล้ว": "Signed out",
    "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร": "Password must be at least 8 characters.", "รหัสผ่านสองช่องไม่ตรงกัน": "Passwords do not match.", "เปลี่ยนรหัสผ่านแล้ว": "Password changed.", "กรุณาเข้าสู่ระบบใหม่": "Please sign in again.",
    "สร้างบัญชีแล้ว แจ้งรหัสผ่านให้เจ้าของบัญชี": "Account created. Share the password with its owner.", "ตั้งรหัสผ่านแล้ว แจ้งรหัสใหม่ให้เจ้าของบัญชี": "Password set. Share the new password with its owner.",
    "โหลดข้อมูลล่าสุดไม่สำเร็จ กำลังแสดงข้อมูลชุดเดิม": "Could not load the latest data. Showing the previous version.", "โหลดข้อมูลไม่สำเร็จ": "Could not load stock data", "รีเฟรชหน้าแล้วลองใหม่": "Refresh the page and try again.",
    "บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูล ติดต่อผู้ดูแลระบบ": "This account cannot save data. Contact an administrator.", "หมดเวลาการเข้าสู่ระบบ ออกจากระบบแล้วเข้าใหม่": "Your session has expired. Sign out and sign in again.", "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่": "Cannot connect to the server. Check your connection and retry.", "บันทึกไม่สำเร็จ ลองอีกครั้ง": "Could not save. Please retry.",
    "หลังส่งออก": "After dispatch", "หลังรับเข้า": "After receipt", "ส่งออกเกินยอดคงเหลือ": "Dispatch exceeds available balance",
    "ใส่วันที่ก่อนบันทึก": "Enter a date before saving.", "เลือกสินค้าจากรายการที่ค้นหาให้ครบทุกบรรทัด": "Choose a product from the search results on every row.", "ใส่จำนวนที่มากกว่า 0 ให้ครบทุกบรรทัด": "Enter a quantity above 0 on every row.", "เพิ่มสินค้าอย่างน้อยหนึ่งรายการ": "Add at least one product.",
    "ใส่จำนวนที่นับได้ ระบบจะสร้างรายการปรับยอดให้เท่ากับยอดนับจริง": "Enter the counted quantity. The system will create an adjustment to match it.", "ยอดนับตรงกับระบบ ไม่ต้องปรับ": "Count matches the system. No adjustment is needed.", "ใส่จำนวนที่นับได้ (0 ขึ้นไป)": "Enter a counted quantity of 0 or more.", "ยอดตรงกันแล้ว ไม่ได้สร้างรายการปรับยอด": "Count matches. No adjustment was created.",
    "ใส่รหัส รุ่น หรือสเปกอย่างน้อยหนึ่งช่อง": "Enter a code, model or specification.", "บันทึกข้อมูลสินค้าแล้ว": "Product saved.", "เพิ่มสินค้าแล้ว": "Product added.", "บัญชีนี้ไม่มีสิทธิ์ลบรายการนี้": "This account cannot delete this entry.", "ลบรายการแล้ว": "Entry deleted.", "โหลดตัวสร้างไฟล์ Excel ไม่สำเร็จ": "Could not load the Excel exporter.", "โหลด log เก่าไม่สำเร็จ": "Could not load older changes.",
    "ยังไม่ได้ตั้งค่าการเชื่อมต่อ": "Connection is not configured", "ใส่ SUPABASE_URL และ SUPABASE_ANON_KEY ในไฟล์ config.js ตามคู่มือ README": "Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js as described in the README.",
    "รายการ": "Entry", "ผู้ดูแลระบบ": "Administrator", "คงเหลือในระบบ": "System balance", "นับได้": "Counted", "จะบันทึกรับเข้าปรับยอด": "Will record a receipt adjustment of", "จะบันทึกส่งออกปรับยอด": "Will record a dispatch adjustment of", "ปรับยอดตามการตรวจนับ": "Stock count adjustment"
  });

  const dynamic = [
    [/^([\d,]+) รายการ\s+อัปเดต (.+?) น\.$/, "$1 products · Updated $2"],
    [/^แสดง ([\d,]+) จาก ([\d,]+) รายการ$/, "Showing $1 of $2 products"],
    [/^แสดง 300 รายการแรก พิมพ์คำค้นหาเพื่อกรองให้แคบลง$/, "Showing the first 300 products. Search to narrow the list."],
    [/^จุดสั่ง ([\d,.]+)$/, "Reorder at $1"],
    [/^ที่เก็บ (.+)$/, "Location: $1"],
    [/^([\d,]+) รายการ\s+ส่งออกรวม ([\d,.]+) ชิ้น\s+รับเข้ารวม ([\d,.]+) ชิ้น$/, "$1 movements · $2 units dispatched · $3 units received"],
    [/^([\d,]+) รายการที่ถูกลบ$/, "$1 deleted entries"],
    [/^แสดง ([\d,]+) การเปลี่ยนแปลง(ล่าสุด|ทั้งหมด) \(เริ่มเก็บตั้งแต่เปิดใช้ระบบบันทึก\)$/, (_, count, scope) => `Showing ${count} ${action[scope]} changes (since logging was enabled)`],
    [/^ลบเมื่อ (.+) โดย (.+)$/, "Deleted on $1 by $2"],
    [/^คงเหลือ ([\d,.]+)$/, "Balance: $1"],
    [/^([\d,.]+) ชิ้น$/, "$1 units"],
    [/^พอขายอีกประมาณ$/, "Estimated cover"],
    [/^([\d,.]+) เดือน$/, "$1 months"],
    [/^ลบรายการ(รับเข้า|ส่งออก) ([\d,.]+) ชิ้น$/, (_, kind, qty) => `Delete ${action[kind]} of ${qty} units`],
    [/^(.+)\s+ยอดคงเหลือของสินค้านี้จะเปลี่ยนตาม ระบบเก็บประวัติการลบไว้$/, "$1 · This product's balance will change. The deletion is logged."],
    [/^รหัสนี้ใช้กับ (.+) แล้ว กดบันทึกอีกครั้งถ้าตั้งใจใช้ซ้ำ$/, "This code is already used by $1. Save again to confirm the duplicate."],
    [/^ปิดการใช้งาน (.+)\?$/, "Disable $1?"],
    [/^สิทธิ์ของ (.+)$/, "Role of $1"],
    [/^สถานะของ (.+)$/, "Status of $1"],
    [/^([\d,.]+) รายการ$/, "$1 entries"],
    [/^สเกลคงเหลือ ([\d,.]+)\+$/, "Balance scale $1+"]
  ];
  dynamic.push(
    [/^บันทึก(ส่งออก|รับเข้า)แล้ว ([\d,]+) รายการ$/, (_, kind, count) => `${action[kind]} recorded: ${count} entries`],
    [/^(.+)\s+คงเหลือในระบบ ([\d,.]+)$/, "$1 · System balance: $2"],
    [/^ปรับยอดแล้ว คงเหลือ ([\d,.]+)$/, "Adjustment saved. Balance: $1"],
    [/^(.+) คงเหลือ ([\d,.]+)$/, "$1 · Balance: $2"],
    [/^(.+) คงเหลือ$/, "$1 · Balance"],
    [/^บันทึกไม่สำเร็จ: (.+)$/, "Could not save: $1"],
    [/^เข้าสู่ระบบไม่สำเร็จ: (.+)$/, "Could not sign in: $1"],
    [/^เปลี่ยนรหัสผ่านไม่สำเร็จ: (.+)$/, "Could not change password: $1"],
    [/^จัดการผู้ใช้ไม่สำเร็จ \((\d+)\)$/, "Could not manage users ($1)"],
    [/^(เพิ่ม|แก้ไข|ลบ|ลบรายการ)(สินค้า|รายการรับเข้า\/ส่งออก): (.+)$/, (_, verb, entity, model) => `${action[verb]} ${action[entity]}: ${model}`],
    [/^(.+)\s+คงเหลือ ([\d,.]+)\s+(.+)$/, "$1 · Balance: $2 · $3"]
  );
  const action = { "รับเข้า": "receipt", "ส่งออก": "dispatch", "ล่าสุด": "latest", "ทั้งหมด": "total", "เพิ่ม": "Add", "แก้ไข": "Edit", "ลบ": "Delete", "ลบรายการ": "Delete movement", "สินค้า": "product", "รายการรับเข้า/ส่งออก": "movement" };
  function translate(value) {
    const raw = String(value);
    const trimmed = raw.trim();
    if (!trimmed || !/[ก-๙]/.test(trimmed)) return raw;
    let result = english[trimmed];
    if (!result) {
      for (const [pattern, replacement] of dynamic) {
        const match = trimmed.match(pattern);
        if (match) { result = trimmed.replace(pattern, replacement); break; }
      }
    }
    if (!result) return raw;
    return raw.replace(trimmed, result);
  }
  window.SWEEO_I18N.translate = translate;

  const attrs = ["placeholder", "aria-label", "title"];
  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentElement?.closest("script,style,pre,code,[data-no-translate]")) return;
      const next = translate(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches("script,style,pre,code,[data-no-translate]")) return;
    for (const attr of attrs) if (root.hasAttribute(attr)) {
      const old = root.getAttribute(attr), next = translate(old);
      if (old !== next) root.setAttribute(attr, next);
    }
    for (const child of root.childNodes) walk(child);
  }

  const button = document.getElementById("langSwitch");
  button.textContent = lang === "en" ? "ไทย" : "EN";
  button.setAttribute("aria-label", lang === "en" ? "เปลี่ยนเป็นภาษาไทย" : "Switch to English");
  button.title = button.getAttribute("aria-label");
  button.addEventListener("click", () => {
    localStorage.setItem("sweeo-language", lang === "en" ? "th" : "en");
    location.reload();
  });
  if (lang === "en") {
    walk(document.body);
    new MutationObserver(mutations => {
      for (const change of mutations) {
        if (change.type === "characterData") walk(change.target);
        else if (change.type === "attributes") walk(change.target);
        else for (const added of change.addedNodes) walk(added);
      }
    }).observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: attrs });
  }
})();
