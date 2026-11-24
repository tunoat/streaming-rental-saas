import {test,expect} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appServer} from '../../apps/api/server.mjs';
import {pool} from '../../apps/api/db.mjs';
import {WorkerClient} from '../../packages/shared/worker-client.mts';
import {runOnce} from '../../apps/mock-worker/worker.mjs';
import pg from 'pg';

test('one-time bootstrap and Thai mock rental walkthrough on mobile',async({page},info)=>{
  test.setTimeout(60000);
  const username='root-'+randomUUID();
  const password='Disposable-Browser-2026!';
  const storeName='ร้านทดสอบ '+randomUUID().slice(0,8);
  if(!process.env.TEST_DATABASE_URL || !process.env.DATABASE_URL) throw new Error('Use a fresh disposable PostgreSQL database');
  const exec=promisify(execFile);
  const bootstrap=()=>exec(process.execPath,['apps/api/cli.mjs','bootstrap'],{env:{
    ...process.env,MIGRATION_DATABASE_URL:process.env.TEST_DATABASE_URL,BOOTSTRAP_USERNAME:username,BOOTSTRAP_PASSWORD:password
  }});
  const app=await appServer();
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  try {
    const reuse=process.env.BROWSER_REUSE_ADMIN==='yes';
    const attempts=await Promise.allSettled([bootstrap(),bootstrap()]);
    expect(attempts.map(a=>a.status).sort()).toEqual(reuse?['rejected','rejected']:['fulfilled','rejected']);
    const existing=reuse?(await db.query(`SELECT u.username FROM users u JOIN admin_audit a ON a.subject_id=u.id
      WHERE a.action='ADMIN_BOOTSTRAPPED' AND u.active`)).rows[0]?.username:username;
    expect(existing).toBeTruthy();
    const base=await app.listen({port:0,host:'127.0.0.1'});
    const fill=async(fields,root=page)=>{
      for(const [label,value] of Object.entries(fields)) await root.getByLabel(label,{exact:true}).fill(value);
    };
    const button=(name,root=page)=>root.getByRole('button',{name,exact:true});
    const login=async(loginName)=>{
      await fill({'ชื่อผู้ใช้':loginName,'รหัสผ่าน':password});
      await button('เข้าสู่ระบบ').click();
    };
    await page.goto(base);
    await expect(page.getByText('ข้อมูลจำลอง / โหมดทดสอบ')).toBeVisible();
    await login(existing);
    await button('ตั้งค่า Super Admin').click();
    const adminForm=page.locator('form').filter({has:button('เพิ่มผู้ใช้')});
    await fill({'ชื่อผู้ใช้':'second-'+username,'รหัสผ่านเริ่มต้น':password,'รหัสผ่านปัจจุบัน':password},adminForm);
    await adminForm.getByLabel('ระดับผู้ใช้').selectOption('ADMIN');
    await button('เพิ่มผู้ใช้',adminForm).click();
    await expect(page.getByText('บันทึกสำเร็จ',{exact:true})).toBeVisible();
    await button('ผู้ดูแลระบบ').click();
    await expect(page.getByText('second-'+username+' · ใช้งานได้ · Admin')).toBeVisible();
    await button('ตั้งค่า Super Admin').click();
    await fill({'ชื่อผู้ใช้':'owner-'+username,'รหัสผ่านเริ่มต้น':password,'รหัสผ่านปัจจุบัน':password},adminForm);
    await adminForm.getByLabel('ระดับผู้ใช้').selectOption('OWNER');
    await button('เพิ่มผู้ใช้',adminForm).click();
    await expect(page.getByText('บันทึกสำเร็จ',{exact:true})).toBeVisible();
    await button('ร้านค้า').click();
    const createStore=page.locator('form').filter({has:page.getByLabel('เจ้าของร้าน',{exact:true})});
    await fill({'ชื่อร้าน':storeName,'รหัสผ่านปัจจุบัน':password},createStore);
    await createStore.getByLabel('เจ้าของร้าน',{exact:true}).selectOption({label:'owner-'+username});
    await button('บันทึก').click();
    await expect(page.getByText(storeName+' · เปิดใช้งาน')).toBeVisible();
    await page.getByText(storeName+' · เปิดใช้งาน').click();
    await expect(page.getByRole('heading',{name:'ยอดขายตามออเดอร์'})).toBeVisible();
    await button('ออกจากระบบ').click();
    await login('owner-'+username);
    await expect(page.getByRole('heading',{name:'เริ่มต้นใช้งานร้าน'})).toBeVisible();
    await expect(button('ผู้ดูแลระบบ')).toHaveCount(0);
    const picker=page.getByLabel('ร้าน',{exact:true});
    await button('ตั้งค่า Owner').click();
    await fill({'ชื่อร้าน':storeName+' สาขา'});
    await button('ส่งคำขอเพิ่มร้าน').click();
    await expect(page.getByText(storeName+' สาขา · รออนุมัติ')).toBeVisible();
    await expect(picker.locator('option')).toHaveCount(1);
    await button('ลูกค้า').click();
    await fill({'ชื่อลูกค้า':'ลูกค้าจำลอง'});
    await button('บันทึก').click();
    await expect(page.getByText('ลูกค้าจำลอง · เครดิต ฿0.00')).toBeVisible();
    const {rows:[store]}=await db.query('SELECT id FROM stores WHERE name=$1',[storeName]);
    const workerToken=randomBytes(32).toString('base64url');
    const workerId='browser-'+randomUUID();
    await exec(process.execPath,['apps/api/cli.mjs','worker',workerId,store.id],{env:{
      ...process.env,MIGRATION_DATABASE_URL:process.env.TEST_DATABASE_URL,BOT_WORKER_TOKEN:workerToken
    }});
    const worker=new WorkerClient(base,workerToken,workerId);
    const form=index=>page.locator('#view form').nth(index);
    const streamingEmail='inventory-'+username+'@example.invalid';
    await button('อีเมลบัญชีสตรีมมิง').click();
    await fill({'อีเมลบัญชีจำลอง':streamingEmail,'รหัสผ่านอีเมล':'Demo-Mail-Only!'},form(0));
    await button('เพิ่มอีเมล').click();
    await expect(page.getByText(streamingEmail+' · ยังไม่ได้ผูกบัญชี')).toBeVisible();
    await button('บัญชีสตรีมมิง').click();
    const platform=page.getByRole('combobox',{name:'แพลตฟอร์ม',exact:true});
    await expect(platform.getByRole('option')).toHaveText(['Netflix']);
    await expect(platform).toHaveValue('netflix');
    await expect(page.getByLabel('จำนวนโปรไฟล์',{exact:true})).toHaveValue('5');
    await page.getByLabel('อีเมลบัญชีสตรีมมิง',{exact:true}).selectOption({label:streamingEmail});
    await expect(form(0).locator('input[type=password]')).toHaveCount(0);
    await fill({'จำนวนโปรไฟล์':'3','OTP จำลอง':'123456'});
    await button('Bind บัญชี',form(0)).click();
    await page.getByRole('button',{name:/Netflix · i•••@example.invalid/}).click();
    await expect(page.getByText('profile3',{exact:true})).toBeVisible();
    await expect(page.getByText('Account ID',{exact:true})).toHaveCount(0);
    const addProfile=page.locator('#view form').filter({has:button('เพิ่มโปรไฟล์')});
    await fill({'ชื่อโปรไฟล์':'โปรไฟล์ทดสอบ'},addProfile);
    await button('เพิ่มโปรไฟล์',addProfile).click();
    await expect(page.getByText('โปรไฟล์ทดสอบ',{exact:true})).toBeVisible();
    await expect(button('ตรวจสอบสมาชิก')).toHaveCount(0);
    const signedIn=await page.request.post(base+'/v1/login',{data:{username:'owner-'+username,password}});
    expect(signedIn.ok()).toBeTruthy();
    const {token}=await signedIn.json();
    const {rows:[account]}=await db.query('SELECT id FROM accounts WHERE store_id=$1',[store.id]);
    const queued=await page.request.post(base+'/v1/stores/'+store.id+'/bot-jobs',{
      headers:{authorization:'Bearer '+token,'idempotency-key':randomUUID(),'x-request-id':randomUUID()},
      data:{type:'VERIFY_SUBSCRIPTION',account_id:account.id,reason:'Browser fixture verification'}
    });
    expect(queued.status()).toBe(201);
    expect((await runOnce(worker))?.type).toBe('VERIFY_SUBSCRIPTION');
    await button('การเงิน').click();
    await fill({'จำนวนเงิน (บาท)':'100'},form(0));
    await button('บันทึก',form(0)).click();
    await fill({'จำนวนเงิน (บาท)':'100','รหัสหลักฐานจำลองขึ้นต้นด้วย mock-':'mock-browser-transfer'},form(1));
    await button('บันทึก',form(1)).click();
    await page.getByLabel('ตรวจสอบยอดและยืนยันเพิ่มเครดิต').check();
    await button('บันทึก',form(2)).click();
    await expect(page.getByRole('heading',{name:'ตรวจสอบและอนุมัติเครดิตจำลอง'})).toHaveCount(0);
    await button('ตั้งค่า').click();
    await fill({'ชื่อแพ็กเกจ':'Netflix รายสัปดาห์','ราคา (บาท)':'50'},form(0));
    await form(0).getByLabel('จำนวนวัน',{exact:true}).selectOption('7');
    await button('เพิ่มแพ็กเกจ',form(0)).click();
    await expect(page.getByText('Netflix · Netflix รายสัปดาห์ · 7 วัน · ฿50.00')).toBeVisible();
    await button('ออเดอร์').click();
    const packagePicker=page.getByLabel('ราคาแพ็กเกจ',{exact:true});
    await expect(packagePicker).toBeDisabled();
    await page.getByLabel('บริการสตรีมมิง',{exact:true}).selectOption('netflix');
    await packagePicker.selectOption({label:'Netflix รายสัปดาห์ · 7 วัน · ฿50.00'});
    await page.getByLabel('ยืนยันการใช้เครดิตตามราคาแพ็กเกจ').check();
    await button('สร้างออเดอร์',form(0)).click();
    await expect(page.getByText('50.00 บาท · รอจัดสรร')).toBeVisible();
    const search=page.getByRole('searchbox',{name:'ค้นหาบัญชีสตรีมมิง'});
    await search.fill('missing-account');
    await expect(page.getByText('ไม่พบบัญชีที่ตรงกับคำค้น')).toBeVisible();
    await search.fill('Netflix');
    await page.getByRole('radio',{name:/Netflix .*พร้อมจัดสรร/}).check();
    await button('จัดสรรและส่งงาน').click();
    await expect(page.getByText('50.00 บาท · กำลังส่งมอบ')).toBeVisible();
    expect((await runOnce(worker))?.type).toBe('DELIVER_ACCESS');
    await expect(page.getByText('ไม่มีออเดอร์ที่ต้องส่งมอบ')).toBeVisible({timeout:10000});
    await expect(page.getByText('50.00 บาท · ส่งมอบแล้ว')).toHaveCount(0);
    await button('การเช่า').click();
    await expect(page.getByText(/กำลังใช้งาน · ถึง/)).toBeVisible();
    await button('ลูกค้า').click();
    await expect(page.getByText('เหลือ 7 วัน',{exact:true})).toBeVisible();
    await expect(page.getByText(/Netflix รายสัปดาห์ · 7 วัน/)).toBeVisible();
    await page.screenshot({path:info.outputPath('thai-owner-mobile.png'),fullPage:true});
  } finally { await app.close(); await pool.end(); await db.end(); }
});

