# SWEEO Stock

เว็บแอปจัดการสต็อกสินค้า SWEEO บน GitHub Pages + Supabase

| สิทธิ์ | ทำอะไรได้ |
|---|---|
| ผู้เยี่ยมชม / ผู้ดูอย่างเดียว | ค้นหาสินค้าและดูยอดคงเหลือเท่านั้น ไม่เห็นประวัติ ลูกค้า ที่เก็บ หรือหมายเหตุ |
| ผู้แก้ไขสต็อก | บันทึกรับเข้า/ส่งออก ปรับยอดตามการนับ แก้ไข/เพิ่มสินค้า ดูประวัติ ส่งออก Excel |
| Foundator | สิทธิ์ผู้แก้ไขทั้งหมด พร้อมเชิญผู้ใช้และเปลี่ยนสิทธิ์สมาชิกทีมในเว็บ |

สิทธิ์ถูกบังคับที่ฐานข้อมูล (Row Level Security) ไม่ใช่แค่ซ่อนปุ่มในหน้าเว็บ

## ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html`, `style.css`, `app.js` | หน้าเว็บ |
| `config.js` | ที่อยู่และ publishable key ของโปรเจกต์ Supabase |
| `supabase/01_schema.sql` | สร้างตาราง สิทธิ์ และฟังก์ชัน |
| `supabase/04_user_roles.sql` | อัปเกรดฐานข้อมูลที่ใช้งานอยู่ให้มีบทบาท Foundator / Editor / Viewer |
| `supabase/functions/manage-users/index.ts` | Edge Function สำหรับจัดการผู้ใช้โดย Foundator |

ไฟล์ข้อมูลตั้งต้น (`02_seed_items.sql`, `03_seed_movements.sql`) อยู่นอกโฟลเดอร์นี้โดยตั้งใจ
**ห้ามอัปโหลดขึ้น GitHub** เพราะมีชื่อลูกค้าและประวัติการส่งของ ใช้รันใน Supabase เท่านั้น

> **สถานะการย้ายข้อมูล (24 ก.ย. 2026):** นำเข้าข้อมูลที่ตรวจเทียบกับ Google Sheet ล่าสุดแล้ว
> มีสินค้า 471 รายการ ประวัติ 652 รายการ ยอดคงเหลือรวม 203,525 ชิ้น ตรงกับชีต
> ประวัติ 370 แถวไม่มีวันที่ทั้งสองช่องและเก็บเป็นค่าว่างตามต้นฉบับ
> ประวัติอีก 2 แถวไม่มีสินค้าที่ตรงกัน จึงไม่นับในยอดคงเหลือ

---

## ขั้นตอนติดตั้ง

### 1. สร้างโปรเจกต์ Supabase
1. สมัคร/เข้าสู่ระบบที่ https://supabase.com แล้วกด **New project**
2. ตั้งชื่อ เช่น `sweeo-stock` เลือก Region **Southeast Asia (Singapore)** ตั้งรหัสผ่านฐานข้อมูลแล้วเก็บไว้
3. รอจนโปรเจกต์สร้างเสร็จ (1–2 นาที)

### 2. สร้างตารางและนำเข้าข้อมูล
เปิดเมนู **SQL Editor** แล้วรัน `01_schema.sql` ก่อน
ใช้ไฟล์ส่งออก Google Sheet ล่าสุดสร้างชุดข้อมูลส่วนตัวด้วย Python ที่มี `openpyxl`:
```bash
python tools/prepare_migration.py --xlsx latest-stock.xlsx --zip sweeo-stock-github.zip
```
สคริปต์จะหยุดหากรายการหรือยอดไม่ตรงกับไฟล์ ZIP และจะเก็บ SQL/CSV ที่สร้างใน `migration/private/` ซึ่ง Git ไม่ติดตาม
สำหรับฐานข้อมูลใหม่ นำเข้าตามลำดับนี้ (เลือก SQL Editor หรือ Table Editor → Import CSV อย่างใดอย่างหนึ่งสำหรับข้อมูลแต่ละตาราง)
1. `01_schema.sql`
2. `migration/private/02_seed_items.sql` หรือ `02_seed_items.csv` → ตาราง `items`
3. `migration/private/03_seed_movements.sql` หรือ `03_seed_movements.csv` → ตาราง `movements`

เมื่อใช้ CSV ให้ตั้ง **Set empty cells as NULL** เฉพาะ `avg_month`, `rop` สำหรับสินค้า และเฉพาะ `item_id`, `date` สำหรับประวัติ เพื่อรักษาข้อความว่างเดิมไว้ในช่องอื่น

ตรวจผลด้วยคำสั่งนี้ ต้องได้ `471` และ `652`
```sql
select (select count(*) from items) as items, (select count(*) from movements) as movements;
```

### 3. ปิดการสมัครสมาชิกเอง
เมนู **Authentication → Sign In / Providers** (หรือ Settings) ปิด **Allow new users to sign up**
ให้ผู้ดูแลเป็นคนสร้างบัญชีเท่านั้น ส่วน Email provider ต้องเปิดอยู่

### 4. ตั้งบัญชี Foundator และจัดการสมาชิกในเว็บ
1. ตั้งค่า **Authentication → URL Configuration → Site URL** ให้เป็น URL เว็บจริง
2. เชิญบัญชีผู้ก่อตั้งครั้งแรกจาก **Authentication → Users → Add user → Send invitation**
3. สำหรับฐานข้อมูลที่มี `staff` อยู่แล้ว ให้รัน `supabase/04_user_roles.sql` ใน SQL Editor โดยต้องมีบัญชี `is_admin=true` เพียงบัญชีเดียว บัญชีนั้นจะเป็น Foundator
4. สำหรับฐานข้อมูลใหม่ ให้เพิ่ม Foundator ครั้งแรกใน SQL Editor (แก้อีเมลให้ตรงบัญชี Auth)
```sql
insert into staff (user_id, email, name, role, is_admin)
select id, lower(email), 'ชื่อผู้ก่อตั้ง', 'founder', true
from auth.users where email = 'founder@example.com';
```
5. ไปที่ **Edge Functions → Deploy a new function → Via Editor** ตั้งชื่อ `manage-users` แล้ววางโค้ดจาก `supabase/functions/manage-users/index.ts` และ Deploy จากนั้นปิด **Verify JWT with legacy secret** ใน Settings เพราะฟังก์ชันตรวจ JWT ผ่าน Supabase Auth เองและตรวจบทบาทใน `staff` ทุกครั้ง
6. Foundator เข้าสู่ระบบเว็บ กด **บัญชี → จัดการผู้ใช้** เพื่อเชิญสมาชิกและเลือกสิทธิ์ ผู้รับคำเชิญเปิดลิงก์ในอีเมลแล้วตั้งรหัสผ่านในหน้าที่เว็บแสดง

การปิดใช้งานหรือเปลี่ยนสิทธิ์ทำได้ในหน้าเดียวกัน บัญชีที่ล็อกอินได้แต่ไม่อยู่ใน `staff` จะเห็นเหมือนผู้เยี่ยมชม อ่านรายละเอียดสิทธิ์ที่ [docs/user-access.md](docs/user-access.md)

### 5. ค่าเชื่อมต่อใน `config.js`
ไฟล์นี้ตั้งค่า URL โปรเจกต์และ **publishable key** แล้ว คีย์ชนิดนี้เปิดเผยในเบราว์เซอร์ได้เพราะ RLS บังคับสิทธิ์ที่ฐานข้อมูล
หากย้ายโปรเจกต์ ให้คัดลอก Project URL และ publishable key จาก Project Settings → API Keys แล้วแก้ไฟล์
```js
window.SWEEO_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_..."
};
```
**ห้ามใช้ secret หรือ service_role key ในไฟล์นี้เด็ดขาด**

### 6. อัปโหลดขึ้น GitHub
1. ที่ https://github.com กด **New repository** ตั้งชื่อ เช่น `sweeo-stock`
   - GitHub Pages แบบฟรีต้องเป็น repository **Public** (โค้ดเห็นได้ แต่ข้อมูลอยู่ใน Supabase และถูกป้องกันด้วยสิทธิ์)
2. ในหน้า repository กด **Add file → Upload files** ลากไฟล์ทั้งหมดในโฟลเดอร์นี้ (รวมโฟลเดอร์ `supabase`) แล้วกด **Commit changes**
3. ไปที่ **Settings → Pages** เลือก Source: **Deploy from a branch**, Branch: **main**, Folder: **/ (root)** แล้วกด Save
4. รอ 1–2 นาที เว็บจะอยู่ที่ `https://<ชื่อผู้ใช้>.github.io/sweeo-stock/`

### 7. ตั้งค่า URL ใน Supabase
เมนู **Authentication → URL Configuration** ใส่ **Site URL** เป็นที่อยู่เว็บจากขั้นที่ 6

---

## การดูแลระบบ

- **สำรองข้อมูล**: ล็อกอินแล้วกด บัญชี → ส่งออก Excel อย่างน้อยสัปดาห์ละครั้ง (แผนฟรีของ Supabase ไม่มีสำรองข้อมูลอัตโนมัติให้ดาวน์โหลด)
- **แผนฟรีของ Supabase จะหยุดโปรเจกต์ชั่วคราวถ้าไม่มีการใช้งาน 7 วัน** ถ้าหยุดแล้ว เข้า Dashboard แล้วกด Restore project
- **แก้รายการที่บันทึกผิด**: ระบบไม่ให้แก้ตัวเลขย้อนหลัง ให้ลบรายการเดิม (ระบบเก็บประวัติการลบ) แล้วบันทึกใหม่
- **ยอดคงเหลือ** = ยอดยกมา + รับเข้า − ส่งออก (ไม่นับรายการที่ถูกลบ)
- **ดูรายการที่ถูกลบ**:
```sql
select date, kind, qty, customer, doc_no, deleted_at from movements where deleted_at is not null order by deleted_at desc;
```
