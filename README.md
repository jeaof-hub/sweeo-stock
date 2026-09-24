# SWEEO Stock

เว็บแอปจัดการสต็อกสินค้า SWEEO บน GitHub Pages + Supabase

| สิทธิ์ | ทำอะไรได้ |
|---|---|
| ผู้เยี่ยมชม (ไม่ล็อกอิน) | ค้นหาสินค้าและดูยอดคงเหลือเท่านั้น ไม่เห็นประวัติ ลูกค้า ที่เก็บ หรือหมายเหตุ |
| ผู้แก้ไข (ล็อกอิน + อยู่ในตาราง staff) | บันทึกรับเข้า/ส่งออก ปรับยอดตามการนับ แก้ไข/เพิ่มสินค้า ดูประวัติ ส่งออก Excel |

สิทธิ์ถูกบังคับที่ฐานข้อมูล (Row Level Security) ไม่ใช่แค่ซ่อนปุ่มในหน้าเว็บ

## ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html`, `style.css`, `app.js` | หน้าเว็บ |
| `config.js` | ที่อยู่และ anon key ของ Supabase (ต้องแก้ก่อนใช้งาน) |
| `supabase/01_schema.sql` | สร้างตาราง สิทธิ์ และฟังก์ชัน |

ไฟล์ข้อมูลตั้งต้น (`02_seed_items.sql`, `03_seed_movements.sql`) อยู่นอกโฟลเดอร์นี้โดยตั้งใจ
**ห้ามอัปโหลดขึ้น GitHub** เพราะมีชื่อลูกค้าและประวัติการส่งของ ใช้รันใน Supabase เท่านั้น

---

## ขั้นตอนติดตั้ง

### 1. สร้างโปรเจกต์ Supabase
1. สมัคร/เข้าสู่ระบบที่ https://supabase.com แล้วกด **New project**
2. ตั้งชื่อ เช่น `sweeo-stock` เลือก Region **Southeast Asia (Singapore)** ตั้งรหัสผ่านฐานข้อมูลแล้วเก็บไว้
3. รอจนโปรเจกต์สร้างเสร็จ (1–2 นาที)

### 2. สร้างตารางและนำเข้าข้อมูล
เปิดเมนู **SQL Editor** แล้วรันทีละไฟล์ตามลำดับ (เปิดไฟล์ คัดลอกทั้งหมด วาง แล้วกด Run)
1. `01_schema.sql`
2. `02_seed_items.sql`
3. `03_seed_movements.sql`

ตรวจผลด้วยคำสั่งนี้ ต้องได้ `471` และ `652`
```sql
select (select count(*) from items) as items, (select count(*) from movements) as movements;
```

### 3. ปิดการสมัครสมาชิกเอง
เมนู **Authentication → Sign In / Providers** (หรือ Settings) ปิด **Allow new users to sign up**
ให้ผู้ดูแลเป็นคนสร้างบัญชีเท่านั้น ส่วน Email provider ต้องเปิดอยู่

### 4. สร้างบัญชีผู้แก้ไข
1. เมนู **Authentication → Users → Add user → Create new user**
2. ใส่อีเมลและรหัสผ่านชั่วคราว ติ๊ก **Auto Confirm User** แล้วกดสร้าง
3. ไปที่ **SQL Editor** ให้สิทธิ์แก้ไขกับบัญชีนั้น (แก้อีเมลและชื่อ)
```sql
insert into staff (user_id, name)
select id, 'Aof' from auth.users where email = 'aof@example.com';
```
4. ทำซ้ำสำหรับพนักงานทุกคนที่ต้องบันทึกข้อมูล แจ้งให้เปลี่ยนรหัสผ่านที่เมนู "บัญชี" หลังเข้าใช้ครั้งแรก

ถอนสิทธิ์พนักงานที่ลาออก:
```sql
update staff set is_active = false
where user_id = (select id from auth.users where email = 'someone@example.com');
```
บัญชีที่ล็อกอินได้แต่ไม่อยู่ในตาราง `staff` จะเห็นเหมือนผู้เยี่ยมชม

### 5. ใส่ค่าเชื่อมต่อใน `config.js`
1. เมนู **Project Settings → API** (หรือ Data API / API Keys)
2. คัดลอก **Project URL** และ **anon public key**
3. แก้ไฟล์ `config.js`
```js
window.SWEEO_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi..."
};
```
anon key เปิดเผยได้ตามการออกแบบของ Supabase **ห้ามใช้ service_role key เด็ดขาด**

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
