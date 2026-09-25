/* SWEEO Stock — GitHub Pages + Supabase
 * Visitor (ไม่ล็อกอิน): เห็นเฉพาะยอดคงเหลือผ่านฟังก์ชัน public_stock()
 * Auditor: อ่านรายละเอียดสต็อกและประวัติ
 * Warehouse: บันทึกรับเข้า/ส่งออก และลบรายการของตนเองในวันเดียวกัน
 * Admin / Owner / Founder: จัดการสินค้า ปรับยอด ส่งออกข้อมูล และดูรายการที่ถูกลบ
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const nf = new Intl.NumberFormat("en-US");
  const locale = window.SWEEO_I18N?.lang === "en" ? "en-GB" : "th-TH";
  const fmt = n => (n === null || n === undefined || isNaN(n)) ? "–" : nf.format(Math.round(n * 10) / 10);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const thDate = s => { if (!s) return "–"; const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(locale, { day: "numeric", month: "short", year: "2-digit" }); };
  const thMonth = s => { const [y, m] = s.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: "long", year: "numeric" }); };
  const newerFirst = (a, b) => (b.date || "").localeCompare(a.date || "") || String(b.created_at).localeCompare(String(a.created_at));
  const olderFirst = (a, b) => (a.date || "").localeCompare(b.date || "") || String(a.created_at).localeCompare(String(b.created_at));
  const statusLabel = { red: "ต้องสั่งผลิต", amber: "ใกล้ถึงจุดสั่ง", green: "ปกติ" };

  /* ---------- state ---------- */
  let sb = null;
  let mode = "visitor";            // "visitor" | "member"
  let session = null;
  let currentRole = null;          // "founder" | "owner" | "admin" | "warehouse" | "auditor" | null
  let items = new Map();           // id -> item
  let entries = [];                // movements (not deleted)
  let deletedEntries = [];         // admin / owner / founder deleted entries
  let stockChanges = [];           // founder / owner change log
  let moreStockChanges = false;
  let calc = new Map();            // id -> {inQ,out,bal,status}
  let staffNames = {};
  let statusFilter = "";
  let channel = null, reloadTimer = null, loading = false;
  const canManageUsers = () => ["founder", "owner"].includes(currentRole);
  const canRecord = () => ["founder", "owner", "admin", "warehouse"].includes(currentRole);
  const canManageStock = () => ["founder", "owner", "admin"].includes(currentRole);
  const bangkokDate = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  const canDeleteEntry = e => !!e && (canManageStock() || (currentRole === "warehouse" && e.created_by === session?.user.id && bangkokDate(e.created_at) === bangkokDate(Date.now())));
  const recorderLabel = (uid, source) => staffNames[uid] || (source === "sheet" ? "Google Sheet" : uid === session?.user.id ? "คุณ" : "พนักงาน");
  // Supabase may remove the invite URL fragment while restoring the session.
  const authParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  const authUrlType = authParams.get("type");
  let invitePending = authUrlType === "invite" || authUrlType === "recovery";
  if (authParams.has("error")) {
    $("authNotice").textContent = authParams.get("error_code") === "otp_expired"
      ? "ลิงก์เชิญหมดอายุแล้ว กรุณาขอ Foundator ส่งคำเชิญใหม่ แล้วเปิดลิงก์ใหม่ทันที"
      : "ลิงก์ยืนยันบัญชีใช้ไม่ได้ กรุณาขอ Foundator ส่งคำเชิญใหม่";
    $("authNotice").hidden = false;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
  }

  /* ---------- helpers ---------- */
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
  }
  const openDlg = d => { if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); };
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach(d => {
    let backdropPointer = null;
    d.addEventListener("pointerdown", e => {
      backdropPointer = e.target === d ? e.pointerId : null;
    });
    d.addEventListener("pointerup", e => {
      if (backdropPointer === e.pointerId && e.target === d) d.close();
      backdropPointer = null;
    });
    d.addEventListener("pointercancel", () => { backdropPointer = null; });
    d.addEventListener("close", () => { backdropPointer = null; });
  });
  function fillSelect(sel, values, first) {
    const cur = sel.value; sel.innerHTML = "";
    const o0 = document.createElement("option"); o0.value = ""; o0.textContent = first; sel.appendChild(o0);
    values.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });
    if (values.includes(cur)) sel.value = cur;
  }
  const fillDatalist = (el, values) => { el.innerHTML = values.map(v => `<option value="${esc(v)}">`).join(""); };
  const itemName = it => it ? (it.model || it.spec || it.code || "(ไม่มีชื่อรุ่น)") : "(สินค้าที่ไม่อยู่ในรายการ)";
  const hayOf = it => [it.code, it.model, it.spec, it.loc, it.type, it.dept, it.remark].join(" ").toLowerCase();
  function dbErr(err) {
    const m = (err && (err.message || err.error_description)) || "";
    if (/row-level security|permission denied/i.test(m)) return "บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูล ติดต่อผู้ดูแลระบบ";
    if (/JWT|expired|session/i.test(m)) return "หมดเวลาการเข้าสู่ระบบ ออกจากระบบแล้วเข้าใหม่";
    if (/Failed to fetch|NetworkError/i.test(m)) return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่";
    return m ? "บันทึกไม่สำเร็จ: " + m : "บันทึกไม่สำเร็จ ลองอีกครั้ง";
  }
  function fatal(title, msg) {
    $("list").innerHTML = `<div class="state"><h2>${esc(title)}</h2><p>${esc(msg)}</p></div>`;
    $("status").textContent = title; $("count").textContent = "";
  }
  async function fetchAll(build) {
    const out = []; const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await build().range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  }

  /* ---------- compute ---------- */
  const statusOf = (bal, rop) => !rop ? "" : bal <= rop ? "red" : bal <= rop * 1.3 ? "amber" : "green";
  function recompute() {
    calc = new Map();
    items.forEach((it, id) => calc.set(id, { inQ: 0, out: 0, bal: 0, status: "" }));
    if (mode === "visitor") {
      items.forEach((it, id) => { const c = calc.get(id); c.bal = Number(it.balance) || 0; });
      return;
    }
    entries.forEach(e => { const c = calc.get(e.item_id); if (!c) return; if (e.kind === "in") c.inQ += e.qty; else c.out += e.qty; });
    items.forEach((it, id) => { const c = calc.get(id); c.bal = (Number(it.opening) || 0) + c.inQ - c.out; c.status = statusOf(c.bal, Number(it.rop) || 0); });
  }

  /* ---------- loading ---------- */
  async function loadVisitor() {
    const rows = await fetchAll(() => sb.rpc("public_stock").order("id"));
    items = new Map(rows.map(r => [r.id, r])); entries = []; deletedEntries = []; stockChanges = []; moreStockChanges = false;
  }
  async function loadMember() {
    const [its, mvs, audit, st, changes] = await Promise.all([
      fetchAll(() => sb.from("items").select("*").eq("active", true).order("id")),
      fetchAll(() => sb.from("movements").select("id,item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_at,created_by").is("deleted_at", null).order("id")),
      canManageStock() ? fetchAll(() => sb.from("movements").select("id,item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_at,created_by,deleted_at,deleted_by").not("deleted_at", "is", null).order("deleted_at", { ascending: false })) : Promise.resolve([]),
      canManageUsers() ? sb.rpc("staff_display_names") : Promise.resolve({ data: [] }),
      canManageUsers() ? sb.from("stock_audit").select("id,occurred_at,actor_id,entity,entity_id,action,before_data,after_data").order("id", { ascending: false }).limit(201) : Promise.resolve({ data: [] })
    ]);
    items = new Map(its.map(r => [r.id, r]));
    entries = mvs.map(m => ({ ...m, qty: Number(m.qty), date: m.date ? String(m.date).slice(0, 10) : null }));
    deletedEntries = audit.map(m => ({ ...m, qty: Number(m.qty), date: m.date ? String(m.date).slice(0, 10) : null }));
    if (changes.error) throw changes.error;
    stockChanges = (changes.data || []).slice(0, 200);
    moreStockChanges = (changes.data || []).length > 200;
    staffNames = {}; (st.data || []).forEach(s => staffNames[s.user_id] = s.name);
  }
  async function reload() {
    if (loading) return; loading = true;
    try {
      if (mode === "member") await loadMember(); else await loadVisitor();
      renderAll();
      $("status").textContent = `${fmt(items.size)} รายการ  อัปเดต ${new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} น.`;
    } catch (err) {
      if (!items.size) fatal("โหลดข้อมูลไม่สำเร็จ", dbErr(err).replace("บันทึกไม่สำเร็จ: ", "") + "  รีเฟรชหน้าแล้วลองใหม่");
      else $("status").textContent = "โหลดข้อมูลล่าสุดไม่สำเร็จ กำลังแสดงข้อมูลชุดเดิม";
    } finally { loading = false; }
  }
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 700); };
  function subscribe() {
    unsubscribe();
    channel = sb.channel("stock-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "movements" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, scheduleReload)
      .subscribe();
  }
  function unsubscribe() { if (channel) { sb.removeChannel(channel); channel = null; } }

  /* ---------- auth / mode ---------- */
  async function applySession(s) {
    session = s;
    currentRole = null;
    if (s) { const { data, error } = await sb.rpc("my_role"); if (!error) currentRole = data; }
    if (currentRole === "editor") currentRole = "warehouse";
    if (currentRole === "viewer") currentRole = "auditor";
    if (currentRole === "sales") currentRole = "auditor";
    if (currentRole === "manager") currentRole = "admin";
    mode = ["founder", "owner", "admin", "warehouse", "auditor"].includes(currentRole) ? "member" : "visitor";
    const isMember = mode === "member";
    $("loginBtn").hidden = !!s; $("userMenu").hidden = !s;
    $("meEmail").textContent = s ? s.user.email : "";
    $("roleBadge").textContent = { founder: "ผู้ก่อตั้ง", owner: "เจ้าของ", admin: "แอดมิน", warehouse: "คลังสินค้า", auditor: "ผู้ตรวจสอบ" }[currentRole] || "ผู้เยี่ยมชม";
    $("roleBadge").classList.toggle("staff", isMember);
    $("roleBadge").classList.toggle("founder", canManageUsers());
    $("tabs").hidden = !isMember; $("actions").hidden = !canRecord(); $("newItemBtn").hidden = !canManageStock();
    $("tabAudit").hidden = !canManageStock();
    $("tabChanges").hidden = !canManageUsers();
    $("alerts").hidden = !isMember; $("exportBtn").hidden = !canManageStock();
    $("manageUsersBtn").hidden = !canManageUsers();
    document.querySelectorAll("[data-member]").forEach(o => { o.hidden = !isMember; o.disabled = !isMember; });
    if (!isMember && ["avgDesc", "cover"].includes($("fSort").value)) $("fSort").value = "order";
    const b = $("banner");
    if (s && !isMember) { b.hidden = false; b.textContent = "บัญชีนี้ยังไม่ได้รับสิทธิ์ ติดต่อ Foundator"; }
    else b.hidden = true;
    if (invitePending && s) {
      invitePending = false;
      try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
      $("pwTitle").textContent = "ตั้งรหัสผ่านของคุณ";
      $("pw1").value = ""; $("pw2").value = ""; $("pwMsg").textContent = "";
      openDlg($("dPw"));
    }
    if (!isMember || !canManageStock() && !$("viewAudit").hidden || !canManageUsers() && !$("viewChanges").hidden) setTab("stock");
    items = new Map(); entries = []; deletedEntries = []; stockChanges = []; moreStockChanges = false; statusFilter = "";
    $("list").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    await reload();
    if (isMember) subscribe(); else unsubscribe();
  }

  $("loginBtn").onclick = () => { $("lgMsg").textContent = ""; openDlg($("dLogin")); setTimeout(() => $("lgEmail").focus(), 50); };
  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("lgSubmit").disabled = true; $("lgMsg").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: $("lgEmail").value.trim(), password: $("lgPw").value });
    $("lgSubmit").disabled = false;
    if (error) { $("lgMsg").textContent = /invalid/i.test(error.message) ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง" : "เข้าสู่ระบบไม่สำเร็จ: " + error.message; return; }
    $("lgPw").value = ""; $("dLogin").close(); toast("เข้าสู่ระบบแล้ว");
  });
  $("menuBtn").onclick = () => { const p = $("menuPop"); p.hidden = !p.hidden; $("menuBtn").setAttribute("aria-expanded", String(!p.hidden)); };
  document.addEventListener("click", e => { if (!e.target.closest("#userMenu")) { $("menuPop").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false"); } });
  $("logoutBtn").onclick = async () => { $("menuPop").hidden = true; await sb.auth.signOut(); toast("ออกจากระบบแล้ว"); };
  $("pwBtn").onclick = () => { $("menuPop").hidden = true; $("pwTitle").textContent = "เปลี่ยนรหัสผ่าน"; $("pw1").value = ""; $("pw2").value = ""; $("pwMsg").textContent = ""; openDlg($("dPw")); };
  $("pwForm").addEventListener("submit", async e => {
    e.preventDefault();
    if ($("pw1").value.length < 8) { $("pwMsg").textContent = "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร"; return; }
    if ($("pw1").value !== $("pw2").value) { $("pwMsg").textContent = "รหัสผ่านสองช่องไม่ตรงกัน"; return; }
    const { error } = await sb.auth.updateUser({ password: $("pw1").value });
    if (error) { $("pwMsg").textContent = "เปลี่ยนรหัสผ่านไม่สำเร็จ: " + error.message; return; }
    $("dPw").close(); toast("เปลี่ยนรหัสผ่านแล้ว");
  });

  /* ---------- Founder / Owner: user access ---------- */
  let managedUsers = [];
  async function userAdmin(action, fields = {}) {
    const { data, error } = await sb.auth.getSession();
    if (error || !data.session) throw new Error("กรุณาเข้าสู่ระบบใหม่");
    const response = await fetch(`${cfg.SUPABASE_URL}/functions/v1/manage-users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${data.session.access_token}`,
      },
      body: JSON.stringify({ action, ...fields }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `จัดการผู้ใช้ไม่สำเร็จ (${response.status})`);
    return result;
  }
  function renderUsers() {
    const box = $("userList");
    if (!managedUsers.length) { box.innerHTML = '<p class="note">ยังไม่มีสมาชิกทีม</p>'; return; }
    box.innerHTML = managedUsers.map(u => {
      const founder = u.role === "founder";
      return `<div class="user-card" data-uid="${esc(u.user_id)}">
        <div class="user-meta"><b>${esc(u.name)}</b><small>${esc(u.email)}</small></div>
        ${founder ? '<span class="badge founder">ผู้ก่อตั้ง</span>' : `<div class="user-controls">
          <label>สิทธิ์ <select class="user-role" aria-label="สิทธิ์ของ ${esc(u.email)}">
            <option value="auditor"${["auditor", "sales", "viewer"].includes(u.role) ? " selected" : ""}>ผู้ตรวจสอบ</option>
            <option value="warehouse"${["warehouse", "editor"].includes(u.role) ? " selected" : ""}>คลังสินค้า</option>
            <option value="admin"${["admin", "manager"].includes(u.role) ? " selected" : ""}>แอดมิน</option>
            <option value="owner"${u.role === "owner" ? " selected" : ""}>เจ้าของ</option>
          </select></label>
          <label>สถานะ <select class="user-active" aria-label="สถานะของ ${esc(u.email)}">
            <option value="true"${u.is_active ? " selected" : ""}>ใช้งาน</option>
            <option value="false"${!u.is_active ? " selected" : ""}>ปิดใช้งาน</option>
          </select></label>
          <button class="btn sm" type="button" data-save-user>บันทึก</button>
          <button class="btn sm" type="button" data-set-pw>ตั้งรหัสผ่าน</button>
        </div>`}
      </div>`;
    }).join("");
  }
  async function refreshUsers() {
    const result = await userAdmin("list");
    managedUsers = result.users || [];
    renderUsers();
  }
  $("manageUsersBtn").onclick = async () => {
    if (!canManageUsers()) return;
    $("menuPop").hidden = true;
    $("uMsg").textContent = "";
    $("userList").textContent = "กำลังโหลดรายชื่อ";
    openDlg($("dUsers"));
    try { await refreshUsers(); } catch (error) { $("userList").textContent = error.message; }
  };
  $("inviteForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!canManageUsers()) return;
    $("uMsg").textContent = "";
    if ($("uPw1").value !== $("uPw2").value) { $("uMsg").textContent = "รหัสผ่านสองช่องไม่ตรงกัน"; return; }
    $("uInvite").disabled = true;
    try {
      await userAdmin("create", { email: $("uEmail").value.trim(), name: $("uName").value.trim(), role: $("uRole").value, password: $("uPw1").value });
      $("uName").value = ""; $("uEmail").value = "";
      await refreshUsers();
      toast("สร้างบัญชีแล้ว แจ้งรหัสผ่านให้เจ้าของบัญชี");
    } catch (error) { $("uMsg").textContent = error.message; }
    finally { $("uPw1").value = ""; $("uPw2").value = ""; $("uInvite").disabled = false; }
  });
  $("userList").addEventListener("click", async event => {
    const passwordButton = event.target.closest("[data-set-pw]");
    if (passwordButton && canManageUsers()) {
      const row = passwordButton.closest(".user-card");
      const user = managedUsers.find(u => u.user_id === row.dataset.uid);
      if (!user || user.role === "founder") return;
      $("dUserPw").dataset.uid = user.user_id;
      $("upEmail").textContent = user.email;
      $("up1").value = ""; $("up2").value = ""; $("upMsg").textContent = "";
      openDlg($("dUserPw"));
      return;
    }
    const button = event.target.closest("[data-save-user]");
    if (!button || !canManageUsers()) return;
    const row = button.closest(".user-card");
    const user = managedUsers.find(u => u.user_id === row.dataset.uid);
    if (!user || user.role === "founder") return;
    const role = row.querySelector(".user-role").value;
    const is_active = row.querySelector(".user-active").value === "true";
    if (user.is_active && !is_active && !window.confirm(`ปิดการใช้งาน ${user.email}?`)) return;
    button.disabled = true; $("uMsg").textContent = "";
    try {
      const result = await userAdmin("update", { user_id: user.user_id, role, is_active });
      managedUsers = managedUsers.map(u => u.user_id === result.user.user_id ? result.user : u);
      renderUsers();
      toast("บันทึกสิทธิ์แล้ว");
    } catch (error) { $("uMsg").textContent = error.message; button.disabled = false; }
  });
  $("userPwForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!canManageUsers()) return;
    $("upMsg").textContent = "";
    if ($("up1").value !== $("up2").value) { $("upMsg").textContent = "รหัสผ่านสองช่องไม่ตรงกัน"; return; }
    $("upSave").disabled = true;
    try {
      await userAdmin("set_password", { user_id: $("dUserPw").dataset.uid, password: $("up1").value });
      $("dUserPw").close();
      toast("ตั้งรหัสผ่านแล้ว แจ้งรหัสใหม่ให้เจ้าของบัญชี");
    } catch (error) { $("upMsg").textContent = error.message; }
    finally { $("up1").value = ""; $("up2").value = ""; $("upSave").disabled = false; }
  });

  /* ---------- stock view ---------- */
  function renderAlerts() {
    if (mode === "visitor") return;
    const c = { red: 0, amber: 0, neg: 0 };
    items.forEach((it, id) => { const k = calc.get(id); if (k.status === "red") c.red++; if (k.status === "amber") c.amber++; if (k.bal < 0) c.neg++; });
    const defs = [["", items.size, "รายการทั้งหมด", ""], ["red", c.red, "ต้องสั่งผลิต", "red"], ["amber", c.amber, "ใกล้ถึงจุดสั่ง", "amber"]];
    if (c.neg) defs.push(["neg", c.neg, "คงเหลือติดลบ", "red"]);
    const box = $("alerts"); box.innerHTML = "";
    defs.forEach(([k, n, label, cls]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "alert " + cls;
      b.setAttribute("aria-pressed", String(statusFilter === k));
      b.innerHTML = `<b>${fmt(n)}</b><span>${esc(label)}</span>`;
      b.onclick = () => { statusFilter = (statusFilter === k || k === "") ? "" : k; renderAlerts(); renderList(); };
      box.appendChild(b);
    });
  }
  function renderList() {
    const q = $("q").value.trim().toLowerCase(), terms = q ? q.split(/\s+/) : [];
    const t = $("fType").value, d = $("fDept").value, hideZero = $("fZero").checked;
    const arr = [];
    items.forEach((it, id) => {
      const c = calc.get(id);
      if (t && it.type !== t) return; if (d && it.dept !== d) return;
      if (hideZero && !statusFilter && !q && c.bal === 0) return;
      if (statusFilter === "neg" ? c.bal >= 0 : (statusFilter && c.status !== statusFilter)) return;
      if (terms.length) { const h = hayOf(it); if (!terms.every(w => h.includes(w))) return; }
      arr.push([id, it, c]);
    });
    const s = $("fSort").value, cover = ([, it, c]) => (Number(it.avg_month) > 0) ? c.bal / Number(it.avg_month) : Infinity;
    if (s === "balDesc") arr.sort((a, b) => b[2].bal - a[2].bal);
    else if (s === "balAsc") arr.sort((a, b) => a[2].bal - b[2].bal);
    else if (s === "avgDesc") arr.sort((a, b) => (Number(b[1].avg_month) || 0) - (Number(a[1].avg_month) || 0));
    else if (s === "cover") arr.sort((a, b) => cover(a) - cover(b));
    else arr.sort((a, b) => (a[1].sort_order || 9e9) - (b[1].sort_order || 9e9));
    // Use public balances alone for the stock-only gauge. A bar scaled by ROP
    // would reveal the private reorder point even if its label were hidden.
    const positiveBalances = [...calc.values()].map(c => c.bal).filter(n => n > 0).sort((a, b) => a - b);
    const reference = positiveBalances[Math.floor((positiveBalances.length - 1) * .75)] || 1;
    const unit = 10 ** Math.floor(Math.log10(reference));
    const stockScale = [1, 2, 5, 10].map(n => n * unit).find(n => n >= reference) || reference;
    $("count").textContent = `แสดง ${fmt(arr.length)} จาก ${fmt(items.size)} รายการ`;
    const list = $("list");
    if (!items.size) { list.innerHTML = `<div class="state"><h2>ยังไม่มีข้อมูลสินค้า</h2><p>${canManageStock() ? "กดเพิ่มสินค้าใหม่ หรือนำเข้าข้อมูลตามคู่มือ" : "ยังไม่มีสินค้าที่แสดงได้"}</p></div>`; return; }
    if (!arr.length) { list.innerHTML = `<div class="state"><h2>ไม่พบรายการที่ตรงกับเงื่อนไข</h2><p>ลองลบคำค้นหา เปลี่ยนประเภท หรือยกเลิกตัวกรองด้านบน</p></div>`; return; }
    list.innerHTML = arr.slice(0, 300).map(([id, it, c]) => {
      const st = c.status ? `<span class="tag st-${c.status}">${statusLabel[c.status]}</span>` : "";
      let g = "";
      const rop = Number(it.rop) || 0;
      if (mode === "member" && rop) {
        const pct = Math.max(0, Math.min(1, c.bal / (rop * 2))) * 100;
        const col = c.status === "red" ? "var(--red)" : c.status === "amber" ? "var(--amber)" : "var(--green)";
        const trackColor = c.bal <= 0 ? "var(--red-soft)" : "var(--track)";
        g = `<div class="gauge" aria-hidden="true"><div class="track" style="background:${trackColor}"><div class="fill" style="width:${pct}%;background:${col}"></div><div class="rop"></div></div><div class="legend"><span>0</span><span>จุดสั่ง ${fmt(rop)}</span><span>${fmt(rop * 2)}+</span></div></div>`;
      } else {
        const pct = Math.max(0, Math.min(1, c.bal / stockScale)) * 100;
        // These colors compare public balances with the public display scale,
        // never with the reorder point that visitors cannot read.
        const stockColor = pct <= 25 ? "var(--red)" : pct <= 60 ? "var(--amber)" : "var(--green)";
        const trackColor = c.bal <= 0 ? "var(--red-soft)" : "var(--track)";
        g = `<div class="gauge" aria-hidden="true"><div class="track" style="background:${trackColor}"><div class="fill" style="width:${pct}%;background:${stockColor}"></div></div><div class="legend"><span>0</span><span>สเกลคงเหลือ ${fmt(stockScale)}+</span></div></div>`;
      }
      return `<button type="button" class="item" data-id="${esc(id)}"><div class="model">${esc(itemName(it))}</div>
        <div class="qty"><b class="${c.bal < 0 ? "neg" : ""}">${fmt(c.bal)}</b><small>คงเหลือ</small></div>
        <div class="spec">${esc(it.model ? it.spec : "")}</div>
        <div class="tags">${st}<span class="tag">${esc(it.type)}</span><span class="tag">${esc(it.dept)}</span>${mode !== "visitor" && it.loc ? `<span class="tag">ที่เก็บ ${esc(it.loc)}</span>` : ""}${it.code ? `<span class="tag">${esc(it.code)}</span>` : ""}</div>${g}</button>`;
    }).join("") + (arr.length > 300 ? `<p class="count">แสดง 300 รายการแรก พิมพ์คำค้นหาเพื่อกรองให้แคบลง</p>` : "");
  }
  $("list").addEventListener("click", e => { const b = e.target.closest(".item"); if (b) openItem(b.dataset.id); });
  let st; $("q").addEventListener("input", () => { clearTimeout(st); st = setTimeout(renderList, 120); });
  ["fType", "fDept", "fSort", "fZero"].forEach(id => $(id).addEventListener("change", renderList));

  /* ---------- log view (staff) ---------- */
  function renderLog() {
    const months = [...new Set(entries.map(e => e.date && e.date.slice(0, 7)).filter(Boolean))].sort().reverse();
    const hasUndated = entries.some(e => !e.date);
    const cur = $("lMonth").value, touched = $("lMonth").dataset.touched;
    $("lMonth").innerHTML = `<option value="">ทุกเดือน</option>` + months.map(m => `<option value="${m}">${esc(thMonth(m))}</option>`).join("") + (hasUndated ? `<option value="__undated__">ไม่ระบุวันที่</option>` : "");
    $("lMonth").value = (!touched && months.length) ? months[0] : (months.includes(cur) || (hasUndated && cur === "__undated__") ? cur : "");
    fillSelect($("lDept"), [...new Set(entries.map(e => e.dept).filter(Boolean))].sort(), "ทุกแผนก");
    const m = $("lMonth").value, k = $("lKind").value, dp = $("lDept").value;
    const q = $("lq").value.trim().toLowerCase(), terms = q ? q.split(/\s+/) : [];
    const arr = entries.filter(e => (m === "__undated__" ? !e.date : (!m || (e.date && e.date.startsWith(m)))) && (!k || e.kind === k) && (!dp || e.dept === dp) &&
      (!terms.length || terms.every(w => [e.customer, e.doc_no, e.dept, e.note, e.code, e.model, itemName(items.get(e.item_id))].join(" ").toLowerCase().includes(w))))
      .sort(newerFirst);
    let tin = 0, tout = 0; arr.forEach(e => e.kind === "in" ? tin += e.qty : tout += e.qty);
    $("lcount").textContent = `${fmt(arr.length)} รายการ  ส่งออกรวม ${fmt(tout)} ชิ้น  รับเข้ารวม ${fmt(tin)} ชิ้น`;
    if (!arr.length) { $("log").innerHTML = `<div class="state"><h2>ไม่มีรายการในช่วงนี้</h2><p>เปลี่ยนเดือนหรือตัวกรองด้านบน</p></div>`; return; }
    let html = `<div class="log">`, lastDay;
    arr.slice(0, 500).forEach(e => {
      if (e.date !== lastDay) { html += `<div class="day">${e.date ? esc(thDate(e.date)) : "ไม่ระบุวันที่"}</div>`; lastDay = e.date; }
      const it = items.get(e.item_id);
      const sub = [e.customer, e.doc_no, e.dept, recorderLabel(e.created_by, e.source)].filter(Boolean).join("  |  ");
      html += `<button type="button" class="row" data-eid="${esc(e.id)}"><div class="m">${esc(it ? itemName(it) : (e.model || e.code || "(ไม่ทราบรุ่น)"))}</div>
        <div class="q ${e.kind}">${e.kind === "in" ? "+" : "−"}${fmt(e.qty)}<small>${e.kind === "in" ? "รับเข้า" : "ส่งออก"}</small></div>
        <div class="s">${esc(sub || "–")}</div></button>`;
    });
    $("log").innerHTML = html + `</div>`;
  }
  $("log").addEventListener("click", e => { const r = e.target.closest(".row"); if (r) openEntry(r.dataset.eid); });
  ["lMonth", "lKind", "lDept"].forEach(id => $(id).addEventListener("change", () => { if (id === "lMonth") $("lMonth").dataset.touched = "1"; renderLog(); }));
  let lt; $("lq").addEventListener("input", () => { clearTimeout(lt); lt = setTimeout(renderLog, 150); });
  function setTab(which) {
    $("tabStock").setAttribute("aria-selected", String(which === "stock"));
    $("tabLog").setAttribute("aria-selected", String(which === "log"));
    $("tabAudit").setAttribute("aria-selected", String(which === "audit"));
    $("tabChanges").setAttribute("aria-selected", String(which === "changes"));
    $("viewStock").hidden = which !== "stock"; $("viewLog").hidden = which !== "log"; $("viewAudit").hidden = which !== "audit"; $("viewChanges").hidden = which !== "changes";
    if (which === "log") renderLog();
    if (which === "audit") renderAudit();
    if (which === "changes") renderChangeLog();
  }
  $("tabStock").onclick = () => setTab("stock"); $("tabLog").onclick = () => setTab("log"); $("tabAudit").onclick = () => { if (canManageStock()) setTab("audit"); };
  $("tabChanges").onclick = () => { if (canManageUsers()) setTab("changes"); };

  function renderAudit() {
    if (!canManageStock()) return;
    $("auditCount").textContent = `${fmt(deletedEntries.length)} รายการที่ถูกลบ`;
    $("auditList").innerHTML = deletedEntries.length ? `<div class="log">${deletedEntries.map(e => {
      const item = items.get(e.item_id);
      const who = canManageUsers() ? recorderLabel(e.deleted_by, e.source) : e.deleted_by === session?.user.id ? "คุณ" : "พนักงาน";
      return `<div class="row"><div class="m">${esc(item ? itemName(item) : (e.model || e.code || "รายการ"))}</div><div class="q ${e.kind}">${e.kind === "in" ? "+" : "−"}${fmt(e.qty)}<small>${e.kind === "in" ? "รับเข้า" : "ส่งออก"}</small></div><div class="s">${esc(thDate(e.date))}  |  ${esc(e.customer || "–")}  |  ${esc(e.doc_no || "–")}<br>ลบเมื่อ ${esc(new Date(e.deleted_at).toLocaleString(locale))} โดย ${esc(who)}</div></div>`;
    }).join("")}</div>` : '<div class="state"><h2>ยังไม่มีรายการที่ถูกลบ</h2></div>';
  }

  function renderChangeLog() {
    if (!canManageUsers()) return;
    $("changesCount").textContent = `แสดง ${fmt(stockChanges.length)} การเปลี่ยนแปลง${moreStockChanges ? "ล่าสุด" : "ทั้งหมด"} (เริ่มเก็บตั้งแต่เปิดใช้ระบบบันทึก)`;
    const labels = { insert: "เพิ่ม", update: "แก้ไข", delete: "ลบ", soft_delete: "ลบรายการ" };
    $("changesList").innerHTML = stockChanges.length ? `<div class="log">${stockChanges.map(c => {
      const data = c.after_data || c.before_data || {};
      const title = c.entity === "items" ? "สินค้า" : "รายการรับเข้า/ส่งออก";
      const model = data.model || data.code || c.entity_id;
      const actor = c.actor_id ? (staffNames[c.actor_id] || "บัญชีที่ไม่อยู่ในทีม") : "ระบบ/ผู้ดูแลฐานข้อมูล";
      return `<details class="row change-row"><summary><b>${esc(labels[c.action] || c.action)}${esc(title)}: ${esc(model)}</b><small>${esc(new Date(c.occurred_at).toLocaleString(locale))} · ${esc(actor)}</small></summary><div class="change-data"><strong>ก่อน</strong><pre>${esc(c.before_data ? JSON.stringify(c.before_data, null, 2) : "–")}</pre><strong>หลัง</strong><pre>${esc(c.after_data ? JSON.stringify(c.after_data, null, 2) : "–")}</pre></div></details>`;
    }).join("")}</div>${moreStockChanges ? '<button class="btn" type="button" id="loadMoreChanges">โหลดรายการเก่าเพิ่ม</button>' : ""}` : '<div class="state"><h2>ยังไม่มีการเปลี่ยนแปลงหลังเปิดใช้ log</h2></div>';
  }
  $("changesList").addEventListener("click", async event => {
    const button = event.target.closest("#loadMoreChanges");
    if (!button || !canManageUsers() || !moreStockChanges || !stockChanges.length) return;
    button.disabled = true;
    const { data, error } = await sb.from("stock_audit")
      .select("id,occurred_at,actor_id,entity,entity_id,action,before_data,after_data")
      .lt("id", stockChanges[stockChanges.length - 1].id).order("id", { ascending: false }).limit(201);
    if (error) { button.disabled = false; toast("โหลด log เก่าไม่สำเร็จ"); return; }
    stockChanges.push(...data.slice(0, 200));
    moreStockChanges = data.length > 200;
    renderChangeLog();
  });

  function renderAll() {
    recompute();
    const its = [...items.values()];
    fillSelect($("fType"), [...new Set(its.map(i => i.type))].sort(), "ทุกประเภท");
    fillSelect($("fDept"), [...new Set(its.map(i => i.dept))].sort(), "ทุกแผนก");
    if (canRecord()) {
      fillDatalist($("typeList"), [...new Set(its.map(i => i.type))].sort());
      fillDatalist($("itemDeptList"), [...new Set(its.map(i => i.dept))].sort());
      const sorted = [...entries].sort(newerFirst);
      const recent = a => [...new Set(a.filter(Boolean))].slice(0, 80);
      fillDatalist($("custList"), recent(sorted.map(e => e.customer)));
      fillDatalist($("deptList"), [...new Set(entries.map(e => e.dept).filter(Boolean))].sort());
      fillDatalist($("saleList"), recent(sorted.map(e => e.sale)));
    }
    renderAlerts(); renderList();
    if (!$("viewLog").hidden) renderLog();
    if (!$("viewAudit").hidden) renderAudit();
    if (!$("viewChanges").hidden) renderChangeLog();
    if ($("dItem").open && $("dItem").dataset.id && items.has($("dItem").dataset.id)) openItem($("dItem").dataset.id);
  }

  /* ---------- item detail ---------- */
  function openItem(id) {
    const it = items.get(id); if (!it) return;
    const c = calc.get(id);
    $("dItem").dataset.id = id;
    $("iTitle").textContent = itemName(it); $("iSub").textContent = it.model ? it.spec : "";
    if (mode === "visitor") {
      $("iBody").innerHTML = `<div class="flow" style="grid-template-columns:1fr"><div class="bal"><small>คงเหลือ</small><b class="${c.bal < 0 ? "neg" : ""}">${fmt(c.bal)}</b></div></div>
        <dl class="meta"><dt>รหัสสินค้า</dt><dd>${esc(it.code || "–")}</dd><dt>ประเภท</dt><dd>${esc(it.type)}</dd><dt>แผนก</dt><dd>${esc(it.dept)}</dd></dl>
        <p class="note">สอบถามรายละเอียดเพิ่มเติมกับฝ่ายขาย</p>`;
      openDlg($("dItem")); return;
    }
    const hist = entries.filter(e => e.item_id === id).sort(newerFirst);
    const avg = Number(it.avg_month), rop = Number(it.rop) || 0;
    const cover = avg > 0 ? c.bal / avg : null;
    let h = `<div class="flow"><div><small>ยอดยกมา</small><b>${fmt(Number(it.opening))}</b></div><div><small>รับเข้า</small><b>${fmt(c.inQ)}</b></div><div><small>ส่งออก</small><b>${fmt(c.out)}</b></div><div class="bal"><small>คงเหลือ</small><b class="${c.bal < 0 ? "neg" : ""}">${fmt(c.bal)}</b></div></div>
      ${canRecord() || canManageStock() ? `<div class="btnrow">${canRecord() ? '<button class="btn primary sm" type="button" data-act="out">ส่งออกรายการนี้</button><button class="btn sm" type="button" data-act="in">รับเข้า</button>' : ""}${canManageStock() ? '<button class="btn sm" type="button" data-act="count">ปรับยอดตามการนับ</button><button class="btn sm" type="button" data-act="edit">แก้ไขข้อมูลสินค้า</button>' : ""}</div>` : ""}
      <dl class="meta"><dt>รหัสสินค้า</dt><dd>${esc(it.code || "–")}</dd><dt>ประเภท</dt><dd>${esc(it.type)}</dd><dt>แผนก</dt><dd>${esc(it.dept)}</dd><dt>ที่เก็บ</dt><dd>${esc(it.loc || "–")}</dd>
      ${it.avg_month != null ? `<dt>ขายเฉลี่ยต่อเดือน</dt><dd>${fmt(avg)} ชิ้น</dd>` : ""}${rop ? `<dt>จุดสั่งผลิต</dt><dd>${fmt(rop)} ชิ้น${c.status ? " (" + statusLabel[c.status] + ")" : ""}</dd>` : ""}
      ${cover !== null ? `<dt>พอขายอีกประมาณ</dt><dd>${fmt(cover)} เดือน</dd>` : ""}<dt>หมายเหตุ</dt><dd>${esc(it.remark || "–")}</dd></dl><h3>ประวัติรับเข้า/ส่งออก</h3>`;
    if (!hist.length) h += `<p class="note">ยังไม่มีรายการรับเข้าหรือส่งออกของสินค้านี้</p>`;
    else {
      h += `<div class="tbl"><table><thead><tr><th>วันที่</th><th>ลูกค้า / เอกสาร</th><th>แผนก</th><th class="n">ส่งออก</th><th class="n">รับเข้า</th><th>ผู้บันทึก</th>${canRecord() ? "<th></th>" : ""}</tr></thead><tbody>`;
      hist.forEach(e => {
        h += `<tr><td>${esc(thDate(e.date))}</td><td class="w">${esc([e.customer, e.doc_no].filter(Boolean).join(" / ") || "–")}${e.note ? `<br><small>${esc(e.note)}</small>` : ""}</td><td>${esc(e.dept || "–")}</td><td class="n">${e.kind === "out" ? fmt(e.qty) : ""}</td><td class="n in">${e.kind === "in" ? fmt(e.qty) : ""}</td><td>${esc(recorderLabel(e.created_by, e.source))}</td>${canRecord() ? `<td>${canDeleteEntry(e) ? `<button class="btn sm danger" type="button" data-del="${esc(e.id)}">ลบ</button>` : ""}</td>` : ""}</tr>`;
      });
      h += `</tbody></table></div>`;
    }
    $("iBody").innerHTML = h;
    openDlg($("dItem"));
  }
  $("iBody").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const id = $("dItem").dataset.id;
    if (b.dataset.del) return confirmDelete(b.dataset.del);
    const a = b.dataset.act;
    if (canRecord() && (a === "out" || a === "in")) { $("dItem").close(); openEntryForm(a, id); }
    if (canManageStock() && a === "count") openCount(id);
    if (canManageStock() && a === "edit") openEdit(id);
  });
  function openEntry(eid) {
    const e = entries.find(x => x.id === eid); if (!e) return;
    if (e.item_id && items.has(e.item_id)) { openItem(e.item_id); return; }
    $("dItem").dataset.id = "";
    $("iTitle").textContent = e.model || e.code || "รายการ"; $("iSub").textContent = "รหัสนี้ไม่อยู่ในรายการสินค้า";
    $("iBody").innerHTML = `<dl class="meta"><dt>วันที่</dt><dd>${esc(thDate(e.date))}</dd><dt>รหัส</dt><dd>${esc(e.code || "–")}</dd><dt>${e.kind === "in" ? "รับเข้า" : "ส่งออก"}</dt><dd>${fmt(e.qty)} ชิ้น</dd><dt>ลูกค้า</dt><dd>${esc(e.customer || "–")}</dd><dt>เอกสาร</dt><dd>${esc(e.doc_no || "–")}</dd><dt>แผนก</dt><dd>${esc(e.dept || "–")}</dd></dl>
      <p class="note">รายการนี้ไม่ถูกนับเข้าสต็อกของสินค้าใด เพราะรหัสไม่ตรงกับรายการสินค้า</p>
      ${canDeleteEntry(e) ? `<div class="btnrow"><button class="btn sm danger" type="button" data-del="${esc(e.id)}">ลบรายการนี้</button></div>` : ""}`;
    openDlg($("dItem"));
  }

  /* ---------- entry form ---------- */
  let formKind = "out";
  function addLine(itemId) {
    const w = document.createElement("div");
    w.innerHTML = `<div class="line"><div class="picker"><input type="text" placeholder="ค้นหารุ่นหรือรหัสสินค้า" autocomplete="off" aria-label="สินค้า"><div class="sel"></div><div class="sugg" hidden></div></div>
      <input class="qtyin" type="number" inputmode="numeric" min="1" step="1" placeholder="จำนวน" aria-label="จำนวน">
      <button class="btn sm" type="button" data-rm>ลบ</button></div>`;
    const line = w.firstChild; $("eLines").appendChild(line); wirePicker(line);
    if (itemId) pick(line, itemId);
    return line;
  }
  function pick(line, id) {
    line.dataset.item = id; line.querySelector(".picker input").value = itemName(items.get(id));
    updateLineInfo(line); line.querySelector(".sugg").hidden = true;
  }
  function updateLineInfo(line) {
    const id = line.dataset.item, sel = line.querySelector(".sel");
    if (!id) { sel.innerHTML = ""; return; }
    const it = items.get(id), c = calc.get(id), q = Number(line.querySelector(".qtyin").value) || 0;
    let t = `${esc(it.code || "")} คงเหลือ <b>${fmt(c.bal)}</b>`;
    if (formKind === "out" && q > 0) t += q > c.bal ? `  <span class="warn">ส่งออกเกินยอดคงเหลือ</span>` : `  หลังส่งออก <b>${fmt(c.bal - q)}</b>`;
    if (formKind === "in" && q > 0) t += `  หลังรับเข้า <b>${fmt(c.bal + q)}</b>`;
    sel.innerHTML = t;
  }
  function wirePicker(line) {
    const inp = line.querySelector(".picker input"), box = line.querySelector(".sugg");
    let hits = [], on = -1;
    inp.addEventListener("input", () => {
      const q = inp.value.trim().toLowerCase(); delete line.dataset.item; line.querySelector(".sel").innerHTML = "";
      if (!q) { box.hidden = true; return; }
      const terms = q.split(/\s+/); hits = [];
      items.forEach((it, id) => { if (terms.every(w => hayOf(it).includes(w))) hits.push(id); });
      hits = hits.slice(0, 8); on = -1;
      box.innerHTML = hits.length ? hits.map((id, i) => { const it = items.get(id), c = calc.get(id); return `<button type="button" data-i="${i}">${esc(itemName(it))}<small>${esc(it.code || "")}  คงเหลือ ${fmt(c.bal)}  ${esc(it.dept)}</small></button>`; }).join("") : `<button type="button" disabled>ไม่พบสินค้า</button>`;
      box.hidden = false;
    });
    inp.addEventListener("keydown", e => {
      if (box.hidden) return;
      if (e.key === "ArrowDown") { on = Math.min(hits.length - 1, on + 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { on = Math.max(0, on - 1); e.preventDefault(); }
      else if (e.key === "Enter" && hits[Math.max(on, 0)]) { pick(line, hits[Math.max(on, 0)]); line.querySelector(".qtyin").focus(); e.preventDefault(); return; }
      else if (e.key === "Escape") { box.hidden = true; return; }
      box.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === on));
    });
    box.addEventListener("mousedown", e => e.preventDefault());
    box.addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (b) { pick(line, hits[+b.dataset.i]); line.querySelector(".qtyin").focus(); } });
    inp.addEventListener("blur", () => setTimeout(() => box.hidden = true, 150));
    line.querySelector(".qtyin").addEventListener("input", () => updateLineInfo(line));
    line.querySelector("[data-rm]").addEventListener("click", () => { line.remove(); if (!$("eLines").children.length) addLine(); });
  }
  function openEntryForm(kind, itemId) {
    if (!canRecord()) return;
    formKind = kind;
    $("eTitle").textContent = kind === "out" ? "บันทึกส่งออก" : "บันทึกรับเข้า";
    $("eSub").textContent = kind === "out" ? "ตัดสต็อกตามใบส่งของ ใส่ได้หลายรายการในเอกสารเดียว" : "เพิ่มสต็อกจากการรับสินค้าเข้าคลัง";
    $("eCustL").textContent = kind === "out" ? "ลูกค้า" : "รับจาก / แหล่งที่มา";
    $("eInvL").textContent = kind === "out" ? "เลขที่ INV / เอกสาร" : "เลขที่เอกสารรับเข้า";
    $("eDate").value = today(); $("eInv").value = ""; $("eNote").value = ""; $("eDept").value = ""; $("eMsg").textContent = "";
    $("eCust").value = kind === "in" ? "STOCK IN" : "";
    $("eSave").textContent = kind === "out" ? "บันทึกส่งออก" : "บันทึกรับเข้า";
    $("eLines").innerHTML = ""; addLine(itemId);
    openDlg($("dEntry"));
    setTimeout(() => { const i = $("eLines").querySelector(itemId ? ".qtyin" : ".picker input"); if (i) i.focus(); }, 50);
  }
  $("addLine").onclick = () => addLine().querySelector(".picker input").focus();
  $("outBtn").onclick = () => openEntryForm("out");
  $("inBtn").onclick = () => openEntryForm("in");
  $("eSave").onclick = async () => {
    if (!canRecord()) return;
    const date = $("eDate").value, msg = $("eMsg"); msg.textContent = "";
    if (!date) { msg.textContent = "ใส่วันที่ก่อนบันทึก"; return; }
    const rows = [];
    for (const l of $("eLines").children) {
      const id = l.dataset.item, q = Number(l.querySelector(".qtyin").value), typed = l.querySelector(".picker input").value.trim();
      if (!id && !typed && !q) continue;
      if (!id) { msg.textContent = "เลือกสินค้าจากรายการที่ค้นหาให้ครบทุกบรรทัด"; return; }
      if (!(q > 0) || !Number.isFinite(q)) { msg.textContent = "ใส่จำนวนที่มากกว่า 0 ให้ครบทุกบรรทัด"; return; }
      const it = items.get(id);
      rows.push({ item_id: id, code: it.code || "", model: it.model || "", date, kind: formKind, qty: q,
        customer: $("eCust").value.trim(), doc_no: $("eInv").value.trim(), dept: $("eDept").value.trim(),
        sale: $("eSale").value.trim(), note: $("eNote").value.trim(), source: "app", created_by: session.user.id });
    }
    if (!rows.length) { msg.textContent = "เพิ่มสินค้าอย่างน้อยหนึ่งรายการ"; return; }
    $("eSave").disabled = true;
    const { error } = await sb.from("movements").insert(rows);
    $("eSave").disabled = false;
    if (error) { msg.textContent = dbErr(error); return; }
    $("dEntry").close(); toast(`${formKind === "out" ? "บันทึกส่งออก" : "บันทึกรับเข้า"}แล้ว ${rows.length} รายการ`); reload();
  };

  /* ---------- count adjust ---------- */
  function openCount(id) {
    if (!canManageStock()) return;
    const it = items.get(id), c = calc.get(id);
    $("dCount").dataset.id = id;
    $("cSub").textContent = `${itemName(it)}  คงเหลือในระบบ ${fmt(c.bal)}`;
    $("cQty").value = ""; $("cDate").value = today(); $("cNote").value = ""; $("cMsg").textContent = "";
    updCount(); openDlg($("dCount")); setTimeout(() => $("cQty").focus(), 50);
  }
  function updCount() {
    const c = calc.get($("dCount").dataset.id), v = $("cQty").value;
    if (v === "") { $("cDiff").textContent = "ใส่จำนวนที่นับได้ ระบบจะสร้างรายการปรับยอดให้เท่ากับยอดนับจริง"; return; }
    const d = Number(v) - c.bal;
    $("cDiff").innerHTML = d === 0 ? "ยอดนับตรงกับระบบ ไม่ต้องปรับ" : `ระบบ <b>${fmt(c.bal)}</b>  นับได้ <b>${fmt(Number(v))}</b>  จะบันทึก${d > 0 ? "รับเข้า" : "ส่งออก"}ปรับยอด <b>${fmt(Math.abs(d))}</b> ชิ้น`;
  }
  $("cQty").addEventListener("input", updCount);
  $("cSave").onclick = async () => {
    if (!canManageStock()) return;
    const id = $("dCount").dataset.id, c = calc.get(id), v = $("cQty").value, it = items.get(id);
    if (v === "" || Number(v) < 0 || !Number.isFinite(Number(v))) { $("cMsg").textContent = "ใส่จำนวนที่นับได้ (0 ขึ้นไป)"; return; }
    const d = Number(v) - c.bal;
    if (d === 0) { $("dCount").close(); toast("ยอดตรงกันแล้ว ไม่ได้สร้างรายการปรับยอด"); return; }
    $("cSave").disabled = true;
    const { error } = await sb.from("movements").insert({ item_id: id, code: it.code || "", model: it.model || "", date: $("cDate").value || today(),
      kind: d > 0 ? "in" : "out", qty: Math.abs(d), customer: "ปรับยอดตามการตรวจนับ", dept: "Stock Adjust",
      note: [`นับได้ ${Number(v)}`, $("cNote").value.trim()].filter(Boolean).join("  "), source: "adjustment", created_by: session.user.id });
    $("cSave").disabled = false;
    if (error) { $("cMsg").textContent = dbErr(error); return; }
    $("dCount").close(); toast("ปรับยอดแล้ว คงเหลือ " + fmt(Number(v))); reload();
  };

  /* ---------- item edit / new ---------- */
  function openEdit(id) {
    if (!canManageStock()) return;
    const it = id ? items.get(id) : { type: "", dept: "", opening: 0 };
    $("dEdit").dataset.id = id || ""; delete $("xSave").dataset.ok;
    $("edTitle").textContent = id ? "แก้ไขข้อมูลสินค้า" : "เพิ่มสินค้าใหม่";
    $("edSub").textContent = id ? itemName(it) : "สินค้าที่ยังไม่มีในรายการ";
    $("xCode").value = it.code || ""; $("xModel").value = it.model || ""; $("xSpec").value = it.spec || "";
    $("xType").value = it.type || ""; $("xDept").value = it.dept || ""; $("xLoc").value = it.loc || "";
    $("xOpen").value = it.opening ?? 0; $("xAvg").value = it.avg_month ?? ""; $("xRop").value = it.rop ?? ""; $("xRemark").value = it.remark || "";
    $("xOpen").disabled = !!id;
    $("xHint").textContent = id ? "ยอดยกมาแก้ไม่ได้ ถ้าคงเหลือไม่ตรง ให้ใช้ปรับยอดตามการนับ ซึ่งจะเก็บประวัติไว้" : "สินค้าใหม่ส่วนใหญ่ให้ยอดยกมาเป็น 0 แล้วบันทึกรับเข้าตามจริง";
    $("xMsg").textContent = ""; openDlg($("dEdit"));
  }
  $("newItemBtn").onclick = () => openEdit(null);
  $("xSave").onclick = async () => {
    if (!canManageStock()) return;
    const id = $("dEdit").dataset.id, numOrNull = v => v === "" ? null : Number(v);
    const data = { code: $("xCode").value.trim(), model: $("xModel").value.trim(), spec: $("xSpec").value.trim(),
      type: $("xType").value.trim() || "ไม่ระบุ", dept: $("xDept").value.trim() || "ไม่ระบุ", loc: $("xLoc").value.trim(),
      avg_month: numOrNull($("xAvg").value), rop: numOrNull($("xRop").value), remark: $("xRemark").value.trim() };
    if (!data.code && !data.model && !data.spec) { $("xMsg").textContent = "ใส่รหัส รุ่น หรือสเปกอย่างน้อยหนึ่งช่อง"; return; }
    if (data.code) {
      let dup = null; items.forEach((it, k) => { if (k !== id && it.code && it.code.toUpperCase() === data.code.toUpperCase()) dup = it; });
      if (dup && !$("xSave").dataset.ok) { $("xMsg").textContent = `รหัสนี้ใช้กับ ${itemName(dup)} แล้ว กดบันทึกอีกครั้งถ้าตั้งใจใช้ซ้ำ`; $("xSave").dataset.ok = "1"; return; }
    }
    $("xSave").disabled = true;
    let error;
    if (id) ({ error } = await sb.from("items").update(data).eq("id", id));
    else {
      let max = 0; items.forEach(it => { if ((it.sort_order || 0) > max) max = it.sort_order; });
      ({ error } = await sb.from("items").insert({ ...data, opening: Number($("xOpen").value) || 0, sort_order: max + 1, source: "app" }));
    }
    $("xSave").disabled = false;
    if (error) { $("xMsg").textContent = dbErr(error); return; }
    delete $("xSave").dataset.ok;
    $("dEdit").close(); toast(id ? "บันทึกข้อมูลสินค้าแล้ว" : "เพิ่มสินค้าแล้ว"); reload();
  };

  /* ---------- delete (soft) ---------- */
  function confirmDelete(eid) {
    const e = entries.find(x => x.id === eid); if (!canDeleteEntry(e)) return;
    $("dConfirm").dataset.eid = eid;
    $("kTitle").textContent = `ลบรายการ${e.kind === "in" ? "รับเข้า" : "ส่งออก"} ${fmt(e.qty)} ชิ้น`;
    $("kSub").textContent = `${thDate(e.date)}  ${[e.customer, e.doc_no].filter(Boolean).join(" / ")}  ยอดคงเหลือของสินค้านี้จะเปลี่ยนตาม ระบบเก็บประวัติการลบไว้`;
    $("kMsg").textContent = ""; openDlg($("dConfirm"));
  }
  $("kOk").onclick = async () => {
    const eid = $("dConfirm").dataset.eid;
    if (!canDeleteEntry(entries.find(e => e.id === eid))) { $("kMsg").textContent = "บัญชีนี้ไม่มีสิทธิ์ลบรายการนี้"; return; }
    $("kOk").disabled = true;
    const { error } = await sb.from("movements").update({ deleted_at: new Date().toISOString() }).eq("id", eid);
    $("kOk").disabled = false;
    if (error) { $("kMsg").textContent = dbErr(error); return; }
    $("dConfirm").close(); toast("ลบรายการแล้ว"); reload();
  };

  /* ---------- export ---------- */
  $("exportBtn").onclick = () => {
    if (!canManageStock()) return;
    $("menuPop").hidden = true;
    if (typeof XLSX === "undefined") { toast("โหลดตัวสร้างไฟล์ Excel ไม่สำเร็จ"); return; }
    const its = [...items.entries()].sort((a, b) => (a[1].sort_order || 0) - (b[1].sort_order || 0));
    const s1 = [locale === "en-GB"
      ? ["No.", "LED types", "Department", "Lot No.", "Model No.", "Specifications", "Opening balance", "STOCK IN", "SOLD", "BALANCE", "Location", "Remark", "Average sales/month", "Reorder point (ROP)", "Status"]
      : ["No.", "LED types", "Department", "Lot No.", "Model No.", "Specifications", "ยอดยกมา", "STOCK IN", "SOLD", "BALANCE", "Location", "Remark", "ขายเฉลี่ย/เดือน", "จุดสั่งผลิต (ROP)", "สถานะ"]];
    its.forEach(([id, it], i) => { const c = calc.get(id); s1.push([i + 1, it.type, it.dept, it.code, it.model, it.spec, Number(it.opening) || 0, c.inQ, c.out, c.bal, it.loc, it.remark, it.avg_month, it.rop, c.status ? (locale === "en-GB" ? window.SWEEO_I18N.translate(statusLabel[c.status]) : statusLabel[c.status]) : ""]); });
    const s2 = [["Date", "Customer / Source", "INV No.", "Department", "Sale", "Model name", "Model No.", "Quantity (out)", "STOCK IN", "Note", "Recorded by"]];
    [...entries].sort(olderFirst).forEach(e => {
      const it = items.get(e.item_id);
      s2.push([e.date || "", e.customer, e.doc_no, e.dept, e.sale, it ? (it.model || e.model) : e.model, it ? (it.code || e.code) : e.code, e.kind === "out" ? e.qty : "", e.kind === "in" ? e.qty : "", e.note, recorderLabel(e.created_by, e.source)]);
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), "Stock");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), "Movements");
    XLSX.writeFile(wb, `SWEEO_stock_${today()}.xlsx`);
  };

  /* ---------- boot ---------- */
  const cfg = window.SWEEO_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || /YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY)) {
    fatal("ยังไม่ได้ตั้งค่าการเชื่อมต่อ", "ใส่ SUPABASE_URL และ SUPABASE_ANON_KEY ในไฟล์ config.js ตามคู่มือ README");
    $("loginBtn").hidden = true;
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  let lastUser;
  sb.auth.onAuthStateChange((event, s) => {
    const uid = s ? s.user.id : null;
    if (event === "TOKEN_REFRESHED" || (event === "INITIAL_SESSION" && lastUser !== undefined)) { session = s; return; }
    if (uid === lastUser && event !== "INITIAL_SESSION") { session = s; return; }
    lastUser = uid;
    setTimeout(() => applySession(s), 0);   // อย่าเรียก Supabase ภายใน callback โดยตรง
  });
})();
