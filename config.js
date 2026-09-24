// ตั้งค่าการเชื่อมต่อ Supabase (ดูขั้นตอนใน README.md)
// ค่า anon key เปิดเผยได้ตามการออกแบบของ Supabase เพราะสิทธิ์ถูกควบคุมด้วย Row Level Security
// ห้ามใส่ service_role key ในไฟล์นี้เด็ดขาด
window.SWEEO_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY"
};
