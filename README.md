# Streaming Rental SaaS · Phase 1 demo

ระบบแอดมินภาษาไทยสำหรับทดลองขั้นตอนจากลูกค้าไปถึงการเช่า มี Super Admin, Owner และ Staff กับ mock worker ที่เรียก API แยกจากแอป ใช้ข้อมูลสมมติเท่านั้น การเริ่มระบบในโหมด production ถูกปฏิเสธ

## เริ่มใช้งานบนเครื่อง

```powershell
docker compose up -d --build
```

เปิด http://localhost:3000 และตรวจ http://localhost:3000/ready ตัว migrator ใน Compose ทำงานก่อน API หากต้องการรัน API ด้วย Node 24 และ PostgreSQL จาก Compose ให้ใช้ PowerShell ต่อไปนี้

```powershell
npm.cmd ci
docker compose up -d --wait postgres
$env:MIGRATION_DATABASE_URL='postgres://postgres:local_migration_only@127.0.0.1:55432/postgres'
$env:DATABASE_URL='postgres://stream_app:local_runtime_only@127.0.0.1:55432/postgres'
npm.cmd run migrate
npm.cmd start
```

สำหรับฐานข้อมูลทดสอบใหม่ ให้ตั้ง `BOOTSTRAP_USERNAME` และฉีด `BOOTSTRAP_PASSWORD` ผ่าน environment secret ของเทอร์มินัล รหัสผ่านต้องมี 12–128 อักขระ จากนั้นรันคำสั่งเหล่านี้ในเทอร์มินัลที่ตั้ง migration URL

```powershell
npm.cmd run bootstrap:super-admin
Remove-Item Env:BOOTSTRAP_PASSWORD
```

คำสั่ง seed เป็นทางเลือกสำหรับร้านตัวอย่างสองร้าน โดยรัน `$env:ALLOW_DEMO_SEED='yes'` และ `npm.cmd run seed` ในฐานข้อมูลทดสอบ ชื่อผู้ใช้คือ `owner-a` และ `owner-b` รหัสผ่าน `Local-Demo-Owner-2026!` ไอคอนรูปคนมุมขวาบนเปิดหน้าตั้งค่า Owner สำหรับเปลี่ยนรหัสผ่านหรือส่งคำขอเพิ่มร้าน เมื่อ Super Admin อนุมัติจากเมนู **คำขอเพิ่มร้านค้า** ร้านจะอยู่ในรายการสลับร้านของ Owner

## ทดลองตั้งแต่ Super Admin ถึงการเช่า

1. ล็อกอินด้วย Super Admin ที่ bootstrap ไว้ กดไอคอนรูปคนเพื่อเพิ่มผู้ใช้ระดับ **Admin** หรือ **Owner** จากนั้นสร้างร้านโดยเลือก Owner ที่มีอยู่ในหน้า **ร้านค้า** การเพิ่มผู้ใช้และสร้างร้านต้องยืนยันรหัสผ่านปัจจุบัน

   Admin เพิ่มผู้ใช้ได้เฉพาะระดับ Owner และอนุมัติคำขอเปิดร้านจากเมนู **คำขอเพิ่มร้านค้า** ส่วน Owner ที่ยังไม่มีร้านส่งคำขอร้านแรกได้ทันทีหลังเข้าสู่ระบบ
2. ล็อกอินด้วย Owner เปิด **ภาพรวม** เพื่อตรวจรายการเริ่มต้น เพิ่มลูกค้า บัญชีสตรีมมิงจำลอง และโปรไฟล์
3. ดู Store ID จาก `GET /v1/me` โดยใช้ session token ของ Owner หรือจากตาราง `stores` ด้วยเครื่องมือฐานข้อมูลในเครื่อง ตั้งค่า worker ดังนี้

```powershell
$env:BOT_WORKER_ID='mock-local'
$env:BOT_WORKER_TOKEN=node --input-type=module -e "import {randomBytes} from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))"
npm.cmd run worker:register -- mock-local YOUR_STORE_UUID
npm.cmd run worker
```

4. กดตรวจสอบสมาชิกจำลองในหน้าบัญชีสตรีมมิง รอ worker ประมวลผล แล้วเปิดหน้า **การเงิน** เพื่อสร้างคำขอ บันทึกยอดโอนด้วยรหัสที่ขึ้นต้น `mock-` และยืนยันเพิ่มเครดิตจำลอง
5. เปิดหน้า **ออเดอร์** เลือกลูกค้า ยืนยันใช้เครดิตจำลอง และจัดสรรโปรไฟล์ เมื่อ mock worker ส่งผลกลับมา เปิดรายการออเดอร์เพื่อดูการเช่าจำลอง

## ตรวจสอบ

ในฐานข้อมูล PostgreSQL ทดสอบที่ผ่าน migration แล้ว ให้ตั้ง `DATABASE_URL` สำหรับ runtime และ `TEST_DATABASE_URL` สำหรับสร้าง fixtures อย่าใช้ฐานข้อมูลที่มีข้อมูลจริง ทำ browser test ก่อน integration test เมื่อใช้ DB ใหม่ร่วมกัน เพราะ browser test ตรวจ bootstrap ครั้งแรก

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run contract:lint
npm.cmd audit --audit-level=high
npx.cmd playwright install chromium
npm.cmd run test:browser
npm.cmd test
```

อ่าน [ผลทดสอบ](docs/TEST_REPORT.md), [จุดสำหรับทำงานต่อ](docs/PROGRESS.md), [ข้อที่ยังขาด](docs/KNOWN_GAPS.md) และ [Bot API handoff](docs/BOT_API.md)

