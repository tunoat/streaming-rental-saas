# ตั้งค่า Gmail Bot ในเครื่อง

## โหมดจำลอง

เปิด PostgreSQL และรัน `npm.cmd run migrate` ตาม README จากนั้นเริ่มเว็บด้วย `npm.cmd start` ค่าเริ่มต้น `GMAIL_ADAPTER=mock` ใช้งานได้โดยไม่ต้องมี Google Cloud project

ลงทะเบียน worker โดยกำหนด `MIGRATION_DATABASE_URL` ในเทอร์มินัลผู้ดูแลฐานข้อมูล ใช้ Store ID จาก `GET /v1/me` ของ Owner และชื่อ worker ใหม่ที่ยังไม่เคยใช้

```powershell
$env:GMAIL_ADAPTER='mock'
$env:BOT_API_URL='http://127.0.0.1:3000'
$env:BOT_WORKER_ID='gmail-mock-local'
$env:GMAIL_WORKER_STORE_ID='<store UUID>'
$env:BOT_WORKER_TOKEN=node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npm.cmd run gmail-worker:register -- $env:BOT_WORKER_ID $env:GMAIL_WORKER_STORE_ID
npm.cmd run gmail-worker
```

สิทธิ์ worker ทดสอบมีอายุ 24 ชั่วโมงตามกลไกเดิม ลงทะเบียนชื่อและโทเคนใหม่เมื่อหมดอายุ สำหรับ Docker ใช้โปรไฟล์ `gmail-test` หลังลงทะเบียนกับฐานข้อมูลของ Compose แล้ว ส่ง `GMAIL_WORKER_ID`, `GMAIL_WORKER_TOKEN` และ `GMAIL_WORKER_STORE_ID` ผ่าน environment ของ Compose

ในเว็บให้เข้า **อีเมลบัญชีสตรีมมิง** เลือกอีเมล กด **เชื่อม Gmail** แล้วกด **Allow** ในหน้าต่างจำลอง ปิดหน้าต่างแล้วรอสถานะ **โหมด Gmail จำลอง · เชื่อม Gmail แล้ว** เมื่อต้องการถอนการเชื่อม ให้กด **ยกเลิกการเชื่อม Gmail** และยืนยัน

## ทดสอบด้วยบัญชี Google ที่ยินยอม

1. สร้าง Google Cloud project เปิด Gmail API ตั้ง OAuth consent สำหรับการทดสอบ และเพิ่มอีเมลที่ยินยอมใน Test users
2. สร้าง OAuth client ประเภท Web application กำหนด Authorized redirect URI เป็น `http://127.0.0.1:3000/v1/oauth/google/callback` เมื่อใช้พอร์ตเริ่มต้น เปิดเว็บด้วย host และพอร์ตเดียวกับ redirect
3. ตั้งค่าฝั่ง API ในไฟล์ environment ส่วนตัวที่ Git ข้าม ใช้ `NODE_ENV=development`, `HOST=127.0.0.1`, `GMAIL_ADAPTER=live`, `GMAIL_LIVE_TEST_ENABLED=true`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `EMAIL_TOKEN_ENCRYPTION_KEY` และ `EMAIL_TOKEN_KEY_VERSION=1` สร้างคีย์แบบ hex สุ่ม 32 ไบต์และเก็บนอก Git/ฐานข้อมูล
4. ลงทะเบียน worker ใหม่ในโหมด `live` และเปิด worker ด้วยโหมดเดียวกับ API ให้ชี้ `BOT_API_URL` มาที่ loopback ฝั่ง worker ใช้โทเคน worker เท่านั้น
5. เลือกอีเมลในเว็บให้ตรงกับบัญชี Google ที่ยินยอมทุกตัวอักษรตามที่ Google คืนมา ระบบไม่รวม alias, จุด หรือ plus address อัตโนมัติ

สิทธิ์ `gmail.readonly` เป็น restricted scope และอาจต้องผ่านการตรวจสอบแอป การประเมินความปลอดภัย นโยบายความเป็นส่วนตัว และ Limited Use ก่อนเปิดให้ใช้งานจริง โทเคนของ OAuth project ที่อยู่ในสถานะ Testing อาจหมดอายุตามนโยบาย Google ถ้าขึ้น **ต้องอนุญาต Gmail ใหม่** ให้เชื่อมใหม่จากอีเมลเดิม การยกเลิกในแอปลบสิทธิ์ในเครื่องก่อน และอาจต้องเพิกถอนจากบัญชี Google เองหากแอปแจ้งว่าเพิกถอนที่ Google ไม่สำเร็จ การถอน grant ฝั่ง Google อาจกระทบสิทธิ์อื่นของ OAuth client เดียวกัน

อ้างอิง [Google OAuth สำหรับเว็บ](https://developers.google.com/identity/protocols/oauth2/web-server), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [สิทธิ์ Gmail API](https://developers.google.com/workspace/gmail/api/auth/scopes) และ [อายุ refresh token ในโหมดทดสอบ](https://developers.google.com/identity/protocols/oauth2#expiration)
