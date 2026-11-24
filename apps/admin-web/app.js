import { t, getLanguage, setLanguage, locale } from './i18n.js';

const byId=id=>document.getElementById(id);
const view=byId('view');
let session,identity,store,role,selectedAccount,orderPoll,page='home',renderId=0;
let adminOwnerId,adminShopId;
const ownerDirectory={page:0,query:''}, shopDirectory={page:0,query:''};
const errors={
  get USE_ACTIVE_STORE(){return t('กรุณาเลือกหนึ่งในร้านที่เปิดใช้งานก่อนขอเพิ่มร้าน');},
  get OWNER_UNAVAILABLE(){return t('กรุณาเลือก Owner ที่ยังใช้งานได้');},
  get STREAMING_EMAIL_BOUND(){return t('อีเมลนี้ผูกกับบัญชีแล้ว จึงยังเปลี่ยนที่อยู่อีเมลไม่ได้');},
  get PROFILE_IN_USE(){return t('โปรไฟล์นี้มีการใช้งานหรืองานค้าง จึงยังทำรายการไม่ได้');},
  get INVALID_PROFILE_PIN(){return t('กรุณากรอก PIN จำลองเป็นตัวเลข 4 หลัก');},
  get STORE_SETTINGS_CHANGED(){return t('ข้อมูลร้านเปลี่ยนแล้วหรือร้านปิดแล้ว กรุณาเปิดหน้าร้านค้าใหม่');},
  get INVALID_EXPIRY(){return t('กรุณาเลือกวันหมดอายุที่ถูกต้อง');},
  get INVALID_CUSTOMER_URL(){return t('กรุณากรอก URL ที่ขึ้นต้นด้วย https:// หรือ http://');},
  get RENTAL_CHANGED(){return t('วันหมดอายุเปลี่ยนแล้ว กรุณาเปิดหน้าออเดอร์ใหม่และตรวจสอบอีกครั้ง');},
  get ORIGINAL_PACKAGE_REQUIRED(){return t('การต่ออายุต้องใช้แพ็กเกจเดิมของรายการเช่า');},
  get RENTAL_EXTENSION_UNAVAILABLE(){return t('เพิ่มวันไม่ได้ กรุณาตรวจสอบสถานะการเช่าและอายุสมาชิกของบัญชีสตรีมมิง');},
  get PACKAGE_PRICE_CHANGED(){return t('ราคาหรือจำนวนวันของแพ็กเกจเปลี่ยนแล้ว กรุณาเปิดหน้าออเดอร์ใหม่และตรวจสอบก่อนยืนยัน');},
  get INVALID_DURATION(){return t('กรุณาระบุจำนวนวันเป็นจำนวนเต็มตั้งแต่ 1 ถึง 365');},
  get STORE_REQUEST_PENDING(){return t('มีคำขอชื่อร้านนี้รออนุมัติอยู่แล้ว');},
  get STORE_REQUEST_REVIEWED(){return t('คำขอนี้ได้รับการพิจารณาแล้ว');},
  get REQUESTER_INACTIVE(){return t('บัญชีผู้ขอปิดใช้งานอยู่');},
  get PASSWORD_UNCHANGED(){return t('กรุณาใช้รหัสผ่านใหม่ที่ต่างจากเดิม');},
  get PASSWORD_POLICY(){return t('รหัสผ่านต้องมี 12–128 ตัวอักษร');},
  get UNSUPPORTED_STREAMING_PLATFORM(){return t('ขณะนี้เลือกได้เฉพาะ Netflix');},
  get MOCK_BIND_INVALID(){return t('กรุณาตรวจ OTP จำลอง');},
  get STREAMING_EMAIL_PASSWORD_REQUIRED(){return t('กรุณาตั้งรหัสผ่านในหน้าอีเมลบัญชีสตรีมมิงก่อน Bind');},
  get INVALID_PROFILE_COUNT(){return t('กรุณาระบุจำนวนโปรไฟล์เป็นจำนวนเต็มตั้งแต่ 1 ถึง 100');},
  get INVALID_USERNAME(){return t('ชื่อผู้ใช้ต้องมี 3–64 ตัว ใช้อักษรอังกฤษ ตัวเลข จุด ขีดกลาง หรือขีดล่าง');},
  get UNAUTHORIZED(){return t('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือเซสชันหมดอายุ');},
  get INSUFFICIENT_CREDIT(){return t('เครดิตไม่เพียงพอ กรุณาตรวจสอบยอดของลูกค้า');},
  get NO_ELIGIBLE_ALLOCATION(){return t('ยังไม่มีออเดอร์และโปรไฟล์ที่พร้อมจัดสรร กรุณาตรวจสอบบัญชีและอายุสมาชิก');},
  get FORBIDDEN(){return t('บัญชีของคุณไม่มีสิทธิ์ดำเนินการ');},get REAUTH_REQUIRED(){return t('กรุณาตรวจสอบรหัสผ่านปัจจุบัน');},
  get LAST_ACTIVE_ADMIN(){return t('ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อยหนึ่งคน');}
};
const status={get PAID_WAITING(){return t('รอจัดสรร');},get DELIVERING(){return t('กำลังส่งมอบ');},get FULFILLED(){return t('ส่งมอบแล้ว');},get REVOCATION_PENDING(){return t('รอยืนยันถอนสิทธิ์');},
  get ACTIVE(){return t('กำลังใช้งาน');},get CLOSED(){return t('ปิดแล้ว');},get QUEUED(){return t('รอดำเนินการ');},get RUNNING(){return t('กำลังตรวจสอบ');},get SUCCEEDED(){return t('สำเร็จ');},
  get BLOCKED(){return t('ต้องตรวจสอบ');},get HEALTHY(){return t('พร้อมใช้งาน');},get UNKNOWN(){return t('ยังไม่ยืนยัน');}};
const requestStatus={get PENDING(){return t('รออนุมัติ');},get APPROVED(){return t('อนุมัติแล้ว');},get REJECTED(){return t('ไม่อนุมัติ');}};
const storeStatus={get ACTIVE(){return t('เปิดใช้งาน');},get SUSPENDED(){return t('ระงับใช้งาน');},get CLOSED(){return t('ปิดแล้ว');}};
let baht,storeDate;
const userLevels={OWNER:'Owner',HEAD_STAFF:'Head Staff',STAFF:'Staff'};
const storeDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'});
const streamingPlatforms=[['netflix','Netflix']];
const platformName=platform=>streamingPlatforms.find(([id])=>id===platform)?.[1]??platform;
const accountLabel=account=>platformName(account.platform)+' · '+account.email.replace(/^(.).*(@.*)$/,'$1•••$2');
const profileStatus={get AVAILABLE(){return t('พร้อมใช้งาน');},get RESERVED(){return t('รอส่งมอบ');},get OCCUPIED(){return t('กำลังใช้งาน');},get HELD(){return t('พักการใช้งาน');}};
const customerLabel=customer=>customer.name+(customer.alias?' ('+customer.alias+')':'');
const customerContactFields=(customer={})=>[
  ['url','URL',{type:'url',required:false,maxLength:2048,value:customer.url??''}],
  ['alias',t('ชื่อเรียก (Alias)'),{type:'text',required:false,maxLength:150,value:customer.alias??''}]
];
const daysLabel=days=>days+(getLanguage()==='en'?(Number(days)===1?' day':' days'):' วัน');
const packageLabel=row=>platformName(row.platform)+' · '+row.name+' · '+daysLabel(row.days)+' · '+baht.format(row.amount);
const workerJobLabels={
  VERIFY_SUBSCRIPTION:'ตรวจสอบสมาชิก',VERIFY_LOGIN:'ตรวจสอบการล็อกอิน',VERIFY_PROFILE_READINESS:'ตรวจความพร้อมโปรไฟล์',
  DELIVER_ACCESS:'ส่งมอบสิทธิ์',REVOKE_ACCESS:'ถอนสิทธิ์',RECONCILE_DELIVERY:'กระทบยอดการส่งมอบ',
  RECONCILE_REVOCATION:'กระทบยอดการถอนสิทธิ์',RECOVERY_VERIFICATION:'ตรวจสอบการกู้คืน',HEALTH_CHECK:'ตรวจสุขภาพบัญชี'
};
const workerStatusLabels={LEASED:'จองงานแล้ว',FAILED:'ล้มเหลว',RETRY_WAIT:'รอลองใหม่',RECONCILING:'กำลังตรวจสอบผล',
  CANCELLED:'ยกเลิกแล้ว',DEAD_LETTER:'หยุดลองใหม่'};
function packageFields(entry={}) {
  const selectedDays=entry.days??30;
  const durations=[...new Set([1,7,30,selectedDays])].sort((a,b)=>a-b);
  return [
    ['name',t('ชื่อแพ็กเกจ'),{type:'text',value:entry.name??''}],
    ['days',t('จำนวนวัน'),'',durations.map(days=>[String(days),daysLabel(days),days===selectedDays])],
    ['amount',t('ราคา (บาท)'),{type:'number',min:0.01,step:0.01,value:entry.amount??''}]
  ];
}
const notice=message=>{byId('notice').textContent=message;};
function element(tag,text,parent=view) {
  const node=document.createElement(tag);
  if(text!==undefined) node.textContent=text;
  parent.append(node);
  return node;
}
async function request(path,body) {
  const headers={};
  if(session) headers.authorization='Bearer '+session;
  if(body) Object.assign(headers,{'content-type':'application/json','x-request-id':crypto.randomUUID(),'idempotency-key':crypto.randomUUID()});
  const res=await fetch('/v1/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  const data=await res.json();
  if(!res.ok) throw new Error(errors[data.code]??t('ทำรายการไม่สำเร็จ กรุณาตรวจสอบข้อมูลแล้วลองอีกครั้ง'));
  return data;
}
const shop=(path,body)=>request('stores/'+store+'/'+path,body);
function list(rows,description,parent=view) {
  if(!rows.length) return element('p',t('ยังไม่มีรายการ'),parent);
  const ul=element('ul',undefined,parent);
  for(const row of rows) element('li',description(row),ul);
}
function form(title,fields,submit,parent=view,buttonText=t('บันทึก')) {
  element('h2',title,parent);
  const node=element('form',undefined,parent);
  for(const [name,title,type='text',options] of fields){
    const label=element('label',title,node);
    const input=element(options?'select':'input',undefined,label);
    input.name=name;
    input.required=true;
    if(options) for(const [value,text,selected=false] of options){
      const option=element('option',text,input);
      option.value=value;
      if(selected) option.selected=true;
    }
    else if(typeof type==='object') Object.assign(input,type);
    else input.type=type;
  }
  const button=element('button',buttonText,node);
  node.addEventListener('submit',async event=>{
    event.preventDefault();
    button.disabled=true;
    notice(t('กำลังบันทึก…'));
    const data=Object.fromEntries(Array.from(new FormData(node),([name,value])=>[name,node.elements.namedItem(name)?.type==='checkbox'?true:value]));
    try { await submit(data); await render(); notice(t('บันทึกสำเร็จ')); }
    catch(error){ notice(error.message); }
    finally { button.disabled=false; }
  });
  return node;
}
const choices=(rows,format)=>rows.map(row=>[row.id,format(row)]);
function passwordForm(submit) {
  form(t('เปลี่ยนรหัสผ่าน'),[
    ['current_password',t('รหัสผ่านปัจจุบัน'),{type:'password',autocomplete:'current-password'}],
    ['new_password',t('รหัสผ่านใหม่'),{type:'password',autocomplete:'new-password',minLength:12,maxLength:128}],
    ['confirm_password',t('ยืนยันรหัสผ่านใหม่'),{type:'password',autocomplete:'new-password'}]
  ],({confirm_password,...data})=>{
    if(confirm_password!==data.new_password) throw new Error(t('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน'));
    return submit(data);
  },view,t('เปลี่ยนรหัสผ่าน'));
}
function summaryTable(parent,columns,rows) {
  const scroll=element('div',undefined,parent);
  scroll.className='sales-table';
  const table=element('table',undefined,scroll);
  const headings=element('tr',undefined,element('thead',undefined,table));
  for(const title of columns) element('th',title,headings).scope='col';
  const body=element('tbody',undefined,table);
  for(const row of rows){
    const line=element('tr',undefined,body);
    for(const cell of row) element('td',String(cell),line);
  }
}
function packageSalesTable(parent,packages) {
  if(!packages.length) return element('p',t('ยังไม่มีแพ็กเกจหรือยอดขาย'),parent);
  summaryTable(parent,[t('บริการ'),t('แพ็กเกจ'),t('ระยะเวลา'),t('ราคาต่อรายการ'),t('ขายได้'),t('ยอดขาย')],
    packages.map(row=>[platformName(row.platform)??'—',row.package_id?row.name:t('ออเดอร์เดิม'),daysLabel(row.days),baht.format(row.unit_price),row.sold,baht.format(row.total)]));
}
function financialMetrics(parent,values){
  const metrics=element('div',undefined,parent);
  metrics.className='sales-metrics overview-finance';
  for(const [label,value] of values){
    const metric=element('div',undefined,metrics);
    element('span',label,metric);
    element('strong',String(value),metric);
  }
}
function monthlyAccountCost(parent,cost){
  const month=new Intl.DateTimeFormat(locale(),{month:'long',year:'numeric',timeZone:'Asia/Bangkok'});
  element('p',month.format(new Date(cost.month+'-01T00:00:00Z')),parent);
  financialMetrics(parent,[
    [t('ยอดขายเดือนนี้'),baht.format(cost.income)],
    [t('ต้นทุนคงที่รวม'),baht.format(cost.total)],
    [t('บัญชีที่ตั้งต้นทุนแล้ว'),cost.configured],
    [t('บัญชีที่ยังไม่ได้ตั้งต้นทุน'),cost.unconfigured]
  ]);
}
function accountCostFields(cost={}){
  return [
    ['broker_amount',t('ค่าโบรกเกอร์ต่อเดือน (บาท)'),{type:'number',min:0,step:0.01,value:cost.broker_amount??'0.00'}],
    ['subscription_amount',t('ค่าบริการสตรีมมิงต่อเดือน (บาท)'),{type:'number',min:0,step:0.01,value:cost.subscription_amount??'',placeholder:'419.00'}]
  ];
}
function dailySalesReport(parent,days){
  const date=new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeZone:'Asia/Bangkok'});
  const dateLabel=day=>date.format(new Date(day+'T00:00:00Z'));
  const currency=value=>value===null?'—':baht.format(value);
  element('h2',t('ยอดขายและกำไรรายวัน'),parent);
  element('p',t('จัดกลุ่มตามวันที่ซื้อในเวลาไทย กำไรจะคำนวณเมื่อส่งมอบแล้วและมีข้อมูลต้นทุน'),parent);
  summaryTable(parent,[t('วันที่'),t('แพ็กเกจขายได้'),t('ยอดขาย'),t('ต้นทุนออเดอร์'),t('กำไรหลังหักต้นทุนบัญชี'),t('รอสรุปกำไร')],
    days.map(row=>[dateLabel(row.day),row.sold,currency(row.sales),currency(row.cost),currency(row.profit),row.pending]));
  const active=days.filter(row=>row.orders>0);
  if(!active.length) return;
  const label=element('label',t('เลือกวันเพื่อดูรายละเอียดออเดอร์'),parent);
  const picker=element('select',undefined,label);
  picker.replaceChildren(new Option(t('เลือกวันที่'),''),
    ...active.map(row=>new Option(dateLabel(row.day),row.day)));
  const details=element('div',undefined,parent);
  let selection=0;
  picker.onchange=async()=>{
    const latest=++selection;
    details.replaceChildren();
    if(!picker.value) return;
    element('p',t('กำลังโหลด…'),details);
    try {
      const rows=await shop('monthly-sales/'+picker.value);
      if(latest!==selection||!details.isConnected) return;
      details.replaceChildren();
      summaryTable(details,[t('เลขอ้างอิงออเดอร์'),t('ชื่อลูกค้า'),t('แพ็กเกจ'),t('สถานะ'),t('ยอดขาย'),t('ต้นทุนออเดอร์'),t('กำไรหลังหักต้นทุนบัญชี')],
        rows.map(row=>[row.order_id.slice(0,8),customerLabel({name:row.customer_name,alias:row.alias}),
          row.kind==='COMPENSATION'?t('ชดเชย'):row.package_name??t('ออเดอร์เดิม'),
          status[row.status]??row.status,currency(row.price),currency(row.cost),currency(row.profit)]));
    } catch(error){
      if(latest!==selection||!details.isConnected) return;
      details.replaceChildren();
      element('p',error.message,details);
    }
  };
}
function directoryButtons(parent,rows,state,select,format,searchLabel){
  const pageSize=8;
  const label=element('label',searchLabel,parent);
  label.className='directory-search';
  const search=element('input',undefined,label);
  Object.assign(search,{type:'search',value:state.query});
  const panel=element('div',undefined,parent);
  function draw(){
    panel.replaceChildren();
    const visible=rows.filter(row=>format(row)[0].toLowerCase().includes(state.query.trim().toLowerCase()));
    const pages=Math.max(1,Math.ceil(visible.length/pageSize));
    const current=state.page=Math.min(state.page,pages-1);
    const grid=element('div',undefined,panel);
    grid.className='directory-grid';
    for(const row of visible.slice(current*pageSize,(current+1)*pageSize)){
      const button=element('button',undefined,grid);
      button.className='inventory-account';
      const [name,details]=format(row);
      const caption=element('span',undefined,button);
      element('strong',name,caption);
      element('small',details,caption);
      button.onclick=()=>select(row);
    }
    if(!visible.length) element('p',t('ยังไม่มีรายการ'),panel);
    if(pages<=1) return;
    const pagination=element('div',undefined,panel);
    pagination.className='directory-pagination';
    const previous=element('button',t('ก่อนหน้า'),pagination);
    previous.disabled=current===0;
    previous.onclick=()=>{state.page=current-1;draw();};
    element('span',t('หน้า ')+(current+1)+' / '+pages,pagination);
    const next=element('button',t('ถัดไป'),pagination);
    next.disabled=current===pages-1;
    next.onclick=()=>{state.page=current+1;draw();};
  }
  search.oninput=()=>{state.query=search.value;state.page=0;draw();};
  draw();
}
async function adminStoreDirectory(current){
  const owners=await request('admin/owners');
  if(!current()) return;
  const owner=owners.find(row=>row.id===adminOwnerId);
  if(!owner){
    element('h1',t('ร้านค้า'));
    element('h2',t('เลือก Owner'));
    if(!owners.length) element('p',t('เพิ่มผู้ใช้ระดับ Owner จากไอคอนรูปคนก่อนสร้างร้าน'));
    else directoryButtons(view,owners,ownerDirectory,row=>{
      adminOwnerId=row.id;adminShopId=undefined;shopDirectory.page=0;shopDirectory.query='';render();
    },row=>[row.username,t('จำนวนร้าน: ')+row.store_count],t('ค้นหา Owner'));
    return;
  }
  const [overview,stores]=await Promise.all([
    request('admin/owners/'+owner.id+'/overview'),request('admin/stores?owner_id='+owner.id)
  ]);
  if(!current()) return;
  const selected=stores.find(row=>row.id===adminShopId);
  if(!selected){
    const back=element('button',t('กลับไปรายชื่อ Owner'));
    back.onclick=()=>{adminOwnerId=undefined;render();};
    element('h1','Owner · '+overview.username);
    element('h2',t('ต้นทุนบัญชีรายเดือนรวมทุกร้าน'));
    monthlyAccountCost(view,overview.monthly_cost);
    element('h2',t('ร้านค้าของ Owner'));
    if(!stores.length) element('p',t('ยังไม่มีร้านค้า'));
    else directoryButtons(view,stores,shopDirectory,row=>{adminShopId=row.id;render();},
      row=>[row.name,storeStatus[row.status]],t('ค้นหาร้านค้า'));
    if(owner.active) form(t('สร้างร้านค้า'),[['name',t('ชื่อร้าน')],['current_password',t('รหัสผ่านปัจจุบัน'),'password']],
      data=>request('admin/stores',{...data,owner_id:owner.id}));
    return;
  }
  const path='admin/stores/'+selected.id+'/';
  const sales=await request(path+'sales');
  if(!current()) return;
  const back=element('button',t('กลับไปรายการร้าน'));
  back.onclick=()=>{adminShopId=undefined;render();};
  element('h1',selected.name);
  const end=new Date(Date.parse(selected.expires_at)-1);
  element('p',storeStatus[selected.status]+t(' · หมดอายุ ')+storeDate.format(end)+t(' น. (เวลาไทย)')+
    (Date.parse(selected.expires_at)<=Date.now()?t(' · หมดอายุแล้ว'):''));
  element('h2',t('ต้นทุนบัญชีรายเดือนของร้าน'));
  monthlyAccountCost(view,sales.monthly_cost);
  element('h2',t('ยอดขายตามออเดอร์'));
  financialMetrics(view,[
    [t('ยอดขายรวม'),baht.format(sales.total_sales)],[t('แพ็กเกจขายได้'),sales.packages_sold],
    [t('ออเดอร์ใหม่'),sales.purchase_count],[t('ต่ออายุ'),sales.renewal_count],[t('ชดเชย'),sales.compensation_count]
  ]);
  packageSalesTable(view,sales.packages);
  if(selected.status==='CLOSED') return;
  const states=['ACTIVE','SUSPENDED'].map(value=>[value,storeStatus[value],value===selected.status]);
  form(t('สถานะร้านค้า'),[['status',t('สถานะ'),'',states]],
    data=>request(path+'status',{...data,expected_status:selected.status}),view,t('บันทึกสถานะ'));
  form(t('วันหมดอายุ'),[['date',t('เลือกวันจากปฏิทิน'),{type:'date',value:storeDay.format(end)}]],
    data=>request(path+'expiry',{...data,mode:'CALENDAR',expected_expiry:selected.expires_at}),view,t('บันทึกวันหมดอายุ'));
  form(t('ปรับวันหมดอายุแบบเร็ว'),[],
    ()=>request(path+'expiry',{mode:'ADD_MONTH',expected_expiry:selected.expires_at}),view,t('+1 เดือน'));
}
function allocationForm(orders,customers,parent) {
  const names=new Map(customers.map(customer=>[customer.id,customerLabel(customer)]));
  const panel=form(t('จัดสรรโปรไฟล์และส่งงานจำลอง'),[
    ['order_id',t('ออเดอร์รอจัดสรร'),'',choices(orders,row=>[
      platformName(row.platform)??t('ออเดอร์เดิม'),names.get(row.customer_id),daysLabel(row.days),row.amount+t(' บาท'),row.id.slice(0,8)
    ].filter(Boolean).join(' · '))],
    ['query',t('ค้นหาบัญชีสตรีมมิง'),{type:'search',required:false,placeholder:t('ชื่อบริการหรืออีเมลบัญชี')}]
  ],({account_id,order_id})=>shop('allocate',{account_id,order_id}),parent,t('จัดสรรและส่งงาน'));
  const submit=panel.querySelector('button');
  const search=panel.elements.query;
  const order=panel.elements.order_id;
  let accounts=[],loadId=0;
  const field=element('fieldset',undefined,panel);
  field.className='allocation-accounts';
  const legend=element('legend',t('บัญชีสำหรับออเดอร์ที่เลือก'),field);
  const results=element('div',undefined,field);
  panel.insertBefore(field,submit);
  function showAccounts(){
    const selected=results.querySelector('input:checked')?.value;
    const query=search.value.trim().toLowerCase();
    const matches=accounts.filter(account=>(platformName(account.platform)+' '+account.email).toLowerCase().includes(query));
    results.replaceChildren();
    submit.disabled=true;
    if(!matches.length) element('p',query?t('ไม่พบบัญชีที่ตรงกับคำค้น'):t('ยังไม่มีบัญชีสตรีมมิง'),results);
    for(const account of matches){
      const eligible=account.available_profiles>0&&account.accepts_waiting_order;
      const label=element('label',undefined,results);
      const radio=element('input',undefined,label);
      Object.assign(radio,{type:'radio',name:'account_id',value:account.id,disabled:!eligible,required:eligible});
      radio.checked=eligible&&selected===account.id;
      if(radio.checked) submit.disabled=false;
      radio.onchange=()=>{submit.disabled=false;};
      const readiness=eligible?t('พร้อมจัดสรร'):account.available_profiles===0?t('ไม่มีโปรไฟล์ว่าง'):
        account.health!=='HEALTHY'?(status[account.health]??t('ต้องตรวจสอบ')):t('ยังไม่พร้อมสำหรับออเดอร์นี้');
      element('span',accountLabel(account)+t(' · ว่าง ')+account.available_profiles+t(' โปรไฟล์ · ')+readiness,label);
    }
  }
  async function loadAccounts(){
    const id=++loadId;
    const platform=orders.find(row=>row.id===order.value)?.platform;
    legend.textContent=platform?t('บัญชี ')+platformName(platform):t('บัญชีสำหรับออเดอร์ที่เลือก');
    accounts=[];
    submit.disabled=true;
    search.disabled=true;
    results.replaceChildren();
    element('p',t('กำลังโหลดบัญชี…'),results);
    try {
      const loaded=await shop('allocation-accounts?order_id='+encodeURIComponent(order.value));
      if(id!==loadId||!panel.isConnected) return;
      accounts=loaded;
      search.disabled=false;
      showAccounts();
    } catch(error){
      if(id!==loadId||!panel.isConnected) return;
      results.replaceChildren();
      element('p',error.message,results);
    }
  }
  search.addEventListener('input',showAccounts);
  order.addEventListener('change',loadAccounts);
  loadAccounts();
}
function nav() {
  const menus=identity.is_super?[['home',t('ร้านค้า')],['requests',t('คำขอเพิ่มร้านค้า')],['admins',t('ผู้ดูแลระบบ')]]:
    identity.is_admin?[['requests',t('คำขอเพิ่มร้านค้า')]]:!store?[]:
    [['home',t('ภาพรวม')],['orders',t('ออเดอร์')],['rentals',t('การเช่า')],['customers',t('ลูกค้า')],['inventory',t('บัญชีสตรีมมิง')],
      ...(role==='OWNER'?[['streaming-emails',t('อีเมลบัญชีสตรีมมิง')],['finance',t('การเงิน')],['settings',t('ตั้งค่า')]]:[])];
  const panel=byId('navigation');
  panel.replaceChildren();
  for(const [key,title] of menus){
    const button=element('button',title,panel);
    if(key===page) button.setAttribute('aria-current','page');
    button.onclick=()=>{page=key;render();};
  }
}
function ownerOverview(overview,renewals,dailySales) {
  const go=(parent,label,destination,style)=>{
    const button=element('button',label,parent);
    button.className=style;
    button.onclick=()=>{page=destination;render();};
  };
  const number=new Intl.NumberFormat(locale());
  const now=Date.now();
  const soon=renewals.flatMap(customer=>customer.rentals.map(rental=>({customer,rental})))
    .filter(({rental})=>Date.parse(rental.ends_at)>now&&Date.parse(rental.ends_at)<=now+3*86400000)
    .sort((a,b)=>Date.parse(a.rental.ends_at)-Date.parse(b.rental.ends_at));
  const waiting=overview.backlog.reduce((total,row)=>total+row.waiting,0);
  const delivering=overview.backlog.reduce((total,row)=>total+row.delivering,0);

  const hero=element('section');
  hero.className='overview-hero';
  element('p',t('ภาพรวมร้าน'),hero).className='overview-hero-label';
  element('h1',identity.stores.find(row=>row.id===store)?.name??t('ร้านของคุณ'),hero);
  const shortcuts=element('div',undefined,hero);
  shortcuts.className='overview-shortcuts';
  go(shortcuts,t('จัดการออเดอร์'),'orders','overview-primary');
  go(shortcuts,t('ดูรายชื่อลูกค้า'),'customers','overview-secondary');

  const tasks=element('section');
  tasks.className='overview-tasks';
  element('h2',t('สิ่งที่ต้องทำ'),tasks);
  const metrics=element('div',undefined,tasks);
  metrics.className='overview-metrics';
  for(const [label,value,meta,destination,tone] of [
    [t('ออเดอร์ค้าง'),waiting+delivering,t('รอจัดสรร ')+number.format(waiting)+t(' · ส่งมอบ ')+number.format(delivering),'orders','mint'],
    [t('รอตรวจยอดชำระ'),overview.payments_pending,t('ดูรายการชำระเงิน'),'finance','blue'],
    [t('สิทธิ์ใกล้หมดอายุ'),overview.expiring,t('ภายใน 3 วัน'),'customers','amber'],
    [t('เหตุการณ์ที่บันทึก'),overview.incident_count,t('ดูบัญชีสตรีมมิง'),'inventory','purple']
  ]){
    const tile=element('button',undefined,metrics);
    tile.className='overview-metric '+tone;
    element('span',label,tile);
    element('strong',number.format(value),tile);
    element('small',meta,tile);
    tile.onclick=()=>{page=destination;render();};
  }
  if(overview.backlog.length){
    const backlog=element('section');
    backlog.className='overview-panel';
    element('h2',t('ออเดอร์ค้างแยกตามแพ็กเกจ'),backlog);
    summaryTable(backlog,[t('บริการ'),t('แพ็กเกจ'),t('ระยะเวลา'),t('รอจัดสรร'),t('กำลังส่งมอบ'),t('รวม')],
      overview.backlog.map(row=>[platformName(row.platform)??'—',row.platform?row.name:t('ออเดอร์เดิม'),daysLabel(row.days),row.waiting,row.delivering,row.waiting+row.delivering]));
  }

  const finance=element('section');
  finance.className='overview-panel';
  element('h2',t('เครดิตเข้าและยอดขายแพ็กเกจ'),finance);
  const totals=element('div',undefined,finance);
  totals.className='sales-metrics overview-finance';
  for(const [label,value,help] of [
    [t('เครดิตเข้าที่อนุมัติแล้ว'),baht.format(overview.credits_in),t('ยอดสะสมจากการเติมเครดิต')],
    [t('ยอดซื้อแพ็กเกจทั้งหมด'),baht.format(overview.sales.package_sales),
      number.format(overview.sales.packages_sold)+t(' แพ็กเกจ · รวมต่ออายุ')]
  ]){
    const tile=element('div',undefined,totals);
    element('span',label,tile);
    element('strong',value,tile);
    element('small',help,tile);
  }
  packageSalesTable(finance,overview.sales.packages.filter(row=>row.package_id));
  element('h2',t('ต้นทุนบัญชีรายเดือนของร้าน'),finance);
  monthlyAccountCost(finance,overview.monthly_cost);
  const daily=element('section');
  daily.className='overview-panel';
  dailySalesReport(daily,dailySales);

  const columns=element('div');
  columns.className='overview-columns';
  const expiring=element('section',undefined,columns);
  expiring.className='overview-panel';
  const expiryHeading=element('div',undefined,expiring);
  expiryHeading.className='overview-panel-heading';
  element('h2',t('ติดต่อเพื่อต่ออายุ'),expiryHeading);
  go(expiryHeading,t('ดูลูกค้าทั้งหมด'),'customers','overview-text-button');
  if(!soon.length) element('p',t('ไม่มีรายการเช่าที่จะหมดอายุใน 3 วัน'),expiring).className='overview-empty';
  else {
    const items=element('ul',undefined,expiring);
    items.className='overview-expiry-list';
    for(const {customer,rental} of soon.slice(0,5)){
      const item=element('li',undefined,items);
      const description=element('div',undefined,item);
      element('strong',customerLabel(customer),description);
      element('small',[platformName(rental.platform),rental.package_name,rental.profile_label].filter(Boolean).join(' · '),description);
      const ends=new Date(rental.ends_at);
      const deadline=element('div',undefined,item);
      element('strong',t('เหลือ ')+daysLabel(Math.ceil((ends-now)/86400000)),deadline);
      element('small',storeDate.format(ends)+t(' น.'),deadline);
    }
  }

  const setup=element('section',undefined,columns);
  setup.className='overview-panel';
  element('h2',t('เริ่มต้นใช้งานร้าน'),setup);
  const steps=[
    [overview.setup.packages,t('ตั้งแพ็กเกจราคา'),'settings'],
    [overview.setup.accounts,t('เพิ่มและตรวจบัญชีสตรีมมิง'),'inventory'],
    [overview.setup.profiles,t('เพิ่มโปรไฟล์'),'inventory'],
    [overview.setup.customers,t('เพิ่มลูกค้า'),'customers'],
    [overview.setup.rentals,t('ทดลองเติมเครดิตและส่งมอบ'),'orders']
  ];
  const done=steps.filter(([completed])=>completed).length;
  const progress=element('progress',undefined,setup);
  Object.assign(progress,{value:done,max:steps.length});
  progress.setAttribute('aria-label',t('ความคืบหน้าการตั้งร้าน'));
  element('p',t('เสร็จแล้ว ')+done+t(' จาก ')+steps.length+t(' ขั้นตอน'),setup).className='overview-progress-text';
  const checklist=element('ul',undefined,setup);
  checklist.className='overview-checklist';
  for(const [completed,label,destination] of steps){
    const item=element('li',undefined,checklist);
    const mark=element('span',completed?'✓':'○',item);
    mark.className=completed?'done':'';
    mark.setAttribute('aria-label',completed?t('เสร็จแล้ว'):t('ยังไม่เสร็จ'));
    go(item,label,destination,'overview-step');
  }
}
async function render() {
  const id=++renderId;
  clearTimeout(orderPoll);
  const current=()=>id===renderId;
  nav();
  view.replaceChildren();
  view.classList.toggle('owner-overview',page==='home'&&role==='OWNER'&&!identity.is_super&&!identity.is_admin);
  view.classList.toggle('streaming-inventory',page==='inventory');
  notice(t('กำลังโหลด…'));
  try {
    if(identity.is_super||identity.is_admin){
      if(page==='home'){
        await adminStoreDirectory(current);
      } else if(page==='admin-settings'){
        element('h1',identity.is_super?t('ตั้งค่า Super Admin'):t('ตั้งค่า Admin'));
        passwordForm(data=>request('admin/password',data));
        form(t('เพิ่มผู้ใช้'),[
          ['username',t('ชื่อผู้ใช้')],['password',t('รหัสผ่านเริ่มต้น'),{type:'password',autocomplete:'new-password'}],
          ['role',t('ระดับผู้ใช้'),'',identity.is_super?[['',t('เลือกระดับผู้ใช้')],['ADMIN','Admin'],['OWNER','Owner']]:[['OWNER','Owner']]],
          ['current_password',t('รหัสผ่านปัจจุบัน'),{type:'password',autocomplete:'current-password'}]
        ],data=>request('admin/users',data),view,t('เพิ่มผู้ใช้'));
      } else if(page==='requests'){
        const requests=await request('admin/store-requests');
        if(!current()) return;
        element('h1',t('คำขอเพิ่มร้านค้า'));
        list(requests,row=>row.name+' · '+row.username+' · '+requestStatus[row.status]);
        const pending=requests.filter(row=>row.status==='PENDING');
        if(pending.length) form(t('พิจารณาคำขอ'),[
          ['id',t('คำขอ'),'',choices(pending,row=>row.name+' · '+row.username)],
          ['status',t('ผลการพิจารณา'),'',identity.is_super?
            [['',t('เลือกผลการพิจารณา')],['APPROVED',t('อนุมัติ')],['REJECTED',t('ไม่อนุมัติ')]]:[['APPROVED',t('อนุมัติ')]]],
          ['current_password',t('รหัสผ่านปัจจุบัน'),'password']
        ],({id,...data})=>request('admin/store-requests/'+id+'/review',data),view,t('บันทึกผล'));
      } else {
        const admins=await request('admin/admins');
        if(!current()) return;
        element('h1',t('ผู้ดูแลระบบ'));
        list(admins,row=>row.username+' · '+(row.active?t('ใช้งานได้'):t('ปิดใช้งาน'))+' · '+row.role);
        form(t('ยืนยันการเปลี่ยนสถานะผู้ดูแล'),[['id',t('ผู้ดูแลระบบ'),'',choices(admins,r=>r.username)],['active',t('สถานะ'),'',[['false',t('ปิดใช้งาน')],['true',t('เปิดใช้งาน')]]],
          ['current_password',t('รหัสผ่านปัจจุบัน'),'password'],['confirm',t('ตรวจสอบชื่อและยืนยันการเปลี่ยนสถานะ'),'checkbox']],
          ({id,active,current_password})=>request('admin/admins/'+id+'/status',{active:active==='true',current_password}));
      }
    } else if(page==='home'){
      if(role==='OWNER'){
        const [overview,renewals,dailySales]=await Promise.all([shop('owner-overview'),shop('customer-renewals'),shop('monthly-sales')]);
        if(!current()) return;
        ownerOverview(overview,renewals,dailySales);
        notice('');
        return;
      }
      const [orders,rentals,accounts,profiles,incidents]=await Promise.all([
        shop('orders?scope=active'),shop('rentals'),shop('accounts'),shop('profiles'),shop('incidents')]);
      if(!current()) return;
      element('h1',t('สิ่งที่ต้องทำ'));
      element('p',t('ออเดอร์รอจัดสรร ')+orders.filter(row=>row.status==='PAID_WAITING').length+t(' รายการ'));
      element('p',t('สิทธิ์ใกล้หมดอายุ ')+rentals.filter(row=>row.status==='ACTIVE'&&Date.parse(row.ends_at)<Date.now()+86400000).length+t(' รายการ'));
      element('p',t('เหตุการณ์ที่บันทึกไว้ ')+incidents.length+t(' รายการ'));
      element('h2',t('เริ่มต้นใช้งานร้าน'));
      list([
        [true,t('ตรวจข้อมูลร้าน')],[accounts.some(r=>r.health==='HEALTHY'),t('เพิ่มและตรวจบัญชีสตรีมมิง')],
        [profiles.length,t('เพิ่มโปรไฟล์')],[rentals.length,t('ทดลองเติมเครดิตและส่งมอบ')]
      ],([done,label])=>(done?t('เสร็จแล้ว · '):t('ยังไม่เสร็จ · '))+label);
      element('p',t('การขาย การเติมเครดิต และการส่งมอบในหน้านี้เป็นข้อมูลจำลอง'));
    } else if(page==='customers'){
      const rows=await shop('customer-renewals');
      if(!current()) return;
      element('h1',t('ลูกค้า'));
      if(role==='OWNER') form(t('เพิ่มลูกค้า'),[['name',t('ชื่อลูกค้า')],...customerContactFields()],data=>shop('customers',data));
      if(!rows.length) element('p',t('ยังไม่มีรายการ'));
      const now=Date.now();
      for(const row of rows){
        const card=element('section');
        card.className='customer-card';
        element('h2',customerLabel(row)+(row.balance!==undefined?t(' · เครดิต ฿')+row.balance:''),card);
        if(row.url && /^https?:\/\//i.test(row.url)){
          const link=element('a',t('เปิด URL ของลูกค้า'),card);
          Object.assign(link,{href:row.url,target:'_blank',rel:'noopener noreferrer'});
        }
        if(!row.rentals.length) element('p',t('ไม่มีแพ็กเกจที่ต้องติดตาม'),card);
        else {
          const listNode=element('ul',undefined,card);
          for(const rental of row.rentals){
            const item=element('li',undefined,listNode);
            const ends=new Date(rental.ends_at);
            const remaining=Math.max(0,Math.ceil((ends-now)/86400000));
            element('span',[accountLabel({platform:rental.platform,email:rental.account_email}),rental.profile_label,
              rental.package_name,daysLabel(rental.package_days)].filter(Boolean).join(' · '),item);
            const countdown=element('strong',remaining===0?t('หมดอายุแล้ว'):t('เหลือ ')+daysLabel(remaining),item);
            countdown.className=remaining<=3?'renewal-soon':'';
            element('small',t('หมดอายุ ')+storeDate.format(ends)+t(' น.')+(remaining>0&&remaining<=3?t(' · ควรติดต่อลูกค้าเรื่องต่ออายุ'):''),item);
          }
        }
        if(role==='OWNER'){
          const details=element('details',undefined,card);
          element('summary',t('แก้ไขข้อมูลลูกค้า'),details);
          form(t('แก้ไข URL และชื่อเรียก'),customerContactFields(row),data=>shop('customers/'+row.id+'/contact',data),details);
        }
      }
    } else if(page==='streaming-emails'){
      const emails=await shop('streaming-emails');
      if(!current()) return;
      element('h1',t('อีเมลบัญชีสตรีมมิง'));
      element('p',t('เพิ่มอีเมลและรหัสผ่านสมมติไว้เลือกตอน Bind บัญชี'));
      form(t('เพิ่มอีเมลบัญชีสตรีมมิง'),[
        ['email',t('อีเมลบัญชีจำลอง'),'email'],
        ['password',t('รหัสผ่านอีเมล'),{type:'password',minLength:12,maxLength:128,autocomplete:'new-password'}]
      ],data=>shop('streaming-emails',data),view,t('เพิ่มอีเมล'));
      for(const row of emails){
        const details=element('details');
        const bound=row.bound_platforms.length>0;
        element('summary',row.email+' · '+(bound?t('ผูกบัญชีแล้ว'):t('ยังไม่ได้ผูกบัญชี')),details);
        if(!row.password_set) element('p',t('ยังไม่ได้ตั้งรหัสผ่านอีเมล'),details);
        const fields=bound?[]:[['email',t('อีเมลบัญชีจำลอง'),{type:'email',value:row.email}]];
        fields.push(['password',t('รหัสผ่านอีเมลใหม่'),{type:'password',required:bound||!row.password_set,minLength:12,maxLength:128,autocomplete:'new-password'}]);
        form(t('แก้ไขข้อมูลอีเมล'),fields,data=>shop('streaming-emails/'+row.id,data),details);
      }
    } else if(page==='inventory'){
      const [accounts,profiles,jobs,emails]=await Promise.all([shop('accounts'),shop('profiles'),shop('bot-jobs'),shop('streaming-emails')]);
      if(!current()) return;
      const account=accounts.find(row=>row.id===selectedAccount);
      const heading=element('section');
      heading.className='inventory-heading';
      const headingText=element('div',undefined,heading);
      element('h1',account?accountLabel(account):t('บัญชีสตรีมมิง'),headingText);
      element('p',account?status[account.health]??account.health:accounts.length+t(' บัญชีที่ผูกไว้'),headingText);
      if(account){
        const back=element('button',t('กลับไปยังรายการบัญชี'),heading);
        back.className='inventory-back';
        back.onclick=()=>{selectedAccount=undefined;render();};
        if(role==='OWNER'){
          const path='accounts/'+account.id+'/cost';
          const cost=await shop(path);
          if(!current()) return;
          const costs=element('section');
          costs.className='inventory-panel';
          if(cost.amount!==null) financialMetrics(costs,[
            [t('ต้นทุนคงที่รวม'),baht.format(cost.amount)],
            [t('ต้นทุนต่อโปรไฟล์ต่อเดือน'),cost.profile_monthly_cost===null?'—':baht.format(cost.profile_monthly_cost)],
            [t('ต้นทุนต่อโปรไฟล์ต่อวัน'),cost.profile_daily_cost===null?'—':baht.format(cost.profile_daily_cost)]
          ]);
          form(t('ต้นทุนบัญชีสตรีมมิง'),accountCostFields(cost),data=>shop(path,data),costs,t('บันทึกต้นทุน'));
        }
        const entries=profiles.filter(profile=>profile.account_id===account.id);
        const panel=element('section');
        panel.className='inventory-panel';
        element('h2',t('โปรไฟล์'),panel);
        if(!entries.length) element('p',t('บัญชีนี้ยังไม่มีโปรไฟล์'),panel);
        for(const profile of entries){
          const details=element(role==='OWNER'?'details':'div',undefined,panel);
          details.className='inventory-profile';
          const summary=element(role==='OWNER'?'summary':'div',undefined,details);
          summary.className='inventory-profile-summary';
          element('strong',profile.label,summary);
          const info=element('span',profileStatus[profile.status]+(profile.pin_set?t(' · ตั้ง PIN แล้ว'):''),summary);
          info.className=profile.status==='AVAILABLE'?'inventory-status ready':'inventory-status';
          if(role!=='OWNER') continue;
          const actions=element('div',undefined,details);
          actions.className='inventory-profile-actions';
          const namePanel=element('div',undefined,actions);
          const path='accounts/'+account.id+'/profiles/'+profile.id+'/';
          form(t('แก้ไขชื่อโปรไฟล์'),[['label',t('ชื่อโปรไฟล์'),{type:'text',value:profile.label,maxLength:150}]],
            data=>shop(path+'rename',data),namePanel,t('บันทึกชื่อ'));
          if(profile.status==='AVAILABLE'){
            const pinPanel=element('div',undefined,actions);
            form(t('เปลี่ยน PIN จำลอง'),[
              ['pin',t('PIN ใหม่ (4 หลัก)'),{type:'password',inputMode:'numeric',minLength:4,maxLength:4,pattern:'[0-9]{4}',autocomplete:'new-password'}]
            ],data=>shop(path+'pin',data),pinPanel,t('บันทึก PIN'));
            const removePanel=element('div',undefined,actions);
            form(t('ลบโปรไฟล์'),[['confirm',t('ยืนยันลบ ')+profile.label,'checkbox']],
              data=>shop(path+'archive',data),removePanel,t('ลบโปรไฟล์'));
          } else element('p',t('เปลี่ยน PIN และลบได้เมื่อโปรไฟล์กลับมาพร้อมใช้งาน'),actions);
        }
        const add=element('section');
        add.className='inventory-panel';
        form(t('เพิ่มโปรไฟล์'),[['label',t('ชื่อโปรไฟล์')]],data=>shop('profiles',{...data,account_id:account.id}),add,t('เพิ่มโปรไฟล์'));
      } else {
        const columns=element('div');
        columns.className='inventory-columns';
        const accountPanel=element('section',undefined,columns);
        accountPanel.className='inventory-panel';
        element('h2',t('บัญชีที่ผูกแล้ว'),accountPanel);
        const buttons=element('div',undefined,accountPanel);
        buttons.className='account-list';
        for(const row of accounts){
          const open=element('button',undefined,buttons);
          open.className='inventory-account';
          const label=accountLabel(row), state=status[row.health]??row.health;
          open.setAttribute('aria-label',label+' · '+state);
          const caption=element('span',undefined,open);
          element('strong',label,caption);
          const matching=profiles.filter(profile=>profile.account_id===row.id);
          element('small',t('ว่าง ')+matching.filter(profile=>profile.status==='AVAILABLE').length+t(' จาก ')+matching.length+t(' โปรไฟล์'),caption);
          element('span',state,open).className=row.health==='HEALTHY'?'inventory-status ready':'inventory-status';
          open.onclick=()=>{selectedAccount=row.id;render();};
        }
        if(!accounts.length) element('p',t('ยังไม่มีบัญชีสตรีมมิง'),accountPanel).className='inventory-empty';
        const bindPanel=element('section',undefined,columns);
        bindPanel.className='inventory-panel';
        if(role==='OWNER'){
          const manage=element('button',t('ตั้งค่าอีเมลบัญชีสตรีมมิง'),bindPanel);
          manage.className='inventory-link';
          manage.onclick=()=>{page='streaming-emails';render();};
        }
        const bind=form(t('เพิ่มบัญชีสตรีมมิงจำลอง'),[
          ['platform',t('แพลตฟอร์ม'),'',streamingPlatforms],['email_id',t('อีเมลบัญชีสตรีมมิง'),'',[]],
          ['otp',t('OTP จำลอง'),{type:'text',inputMode:'numeric',maxLength:6,pattern:'[0-9]{6}',autocomplete:'off'}],
          ['profile_count',t('จำนวนโปรไฟล์'),{type:'number',min:1,max:100,step:1,value:5}],
          ...accountCostFields()
        ],data=>shop('accounts',{...data,profile_count:Number(data.profile_count)}),bindPanel,t('Bind บัญชี'));
        element('p',t('เลือกอีเมลที่ตั้งรหัสผ่านไว้ ใช้ OTP จำลอง 123456'),bindPanel).className='inventory-hint';
        const showEmails=()=>{
          const available=emails.filter(row=>row.password_set&&!row.bound_platforms.includes(bind.elements.platform.value));
          bind.elements.email_id.replaceChildren(new Option(available.length?t('เลือกอีเมล'):t('ไม่มีอีเมลพร้อมผูกบัญชี'),''),
            ...available.map(row=>new Option(row.email,row.id)));
          bind.elements.email_id.disabled=!available.length;
          bind.querySelector('button').disabled=!available.length;
        };
        bind.elements.platform.addEventListener('change',showEmails);
        showEmails();
      }
      const details=element('details');
      details.className='inventory-panel inventory-advanced';
      element('summary',t('รายละเอียดขั้นสูง'),details);
      list(jobs.items.filter(job=>!account||job.account_id===account.id),
        row=>t(workerJobLabels[row.type]??row.type)+' · '+(status[row.status]??t(workerStatusLabels[row.status]??row.status)),details);
    } else if(page==='finance'){
      const [customers,payments,transfers]=await Promise.all([shop('customers'),shop('payment-requests'),shop('transfers')]);
      if(!current()) return;
      element('h1',t('การเงินจำลอง'));
      if(customers.length) form(t('สร้างคำขอชำระเงิน'),[['customer_id',t('ลูกค้า'),'',choices(customers,customerLabel)],['amount',t('จำนวนเงิน (บาท)')]],data=>shop('payment-requests',data));
      if(payments.length) form(t('บันทึกยอดโอนจำลอง'),[['payment_id',t('คำขอชำระเงิน'),'',choices(payments,r=>r.amount+t(' บาท · ')+r.id.slice(0,8))],
        ['amount',t('จำนวนเงิน (บาท)')],['evidence',t('รหัสหลักฐานจำลองขึ้นต้นด้วย mock-')]],data=>shop('transfers',data));
      const pending=transfers.filter(row=>!row.approved_at);
      if(pending.length) form(t('ตรวจสอบและอนุมัติเครดิตจำลอง'),[['id',t('ยอดโอน'),'',choices(pending,r=>r.amount+t(' บาท · ')+r.id.slice(0,8))],
        ['confirm',t('ตรวจสอบยอดและยืนยันเพิ่มเครดิต'),'checkbox']],({id,confirm})=>shop('transfers/'+id+'/approve',{confirm}));
      if(!customers.length) element('p',t('เพิ่มลูกค้าก่อนสร้างคำขอชำระเงิน'));
    } else if(page==='orders'){
      const [orders,customers,packages]=await Promise.all([
        shop('orders?scope=active'),role==='OWNER'?shop('customers'):[],shop('packages')
      ]);
      if(!current()) return;
      element('h1',t('ออเดอร์'));
      const queue=element('div');
      if(customers.length){
        const orderForm=form(t('สร้างออเดอร์จำลอง'),[
          ['customer_id',t('ลูกค้าและยอดเครดิต'),'',choices(customers,r=>customerLabel(r)+' · '+baht.format(r.balance))],
          ['platform',t('บริการสตรีมมิง'),'',[['',t('เลือกบริการสตรีมมิง')],...streamingPlatforms]],
          ['package_id',t('ราคาแพ็กเกจ'),'',[]],
          ['confirm',t('ยืนยันการใช้เครดิตตามราคาแพ็กเกจ'),'checkbox']
        ],({platform,...data})=>{
          const selected=packages.find(row=>row.id===data.package_id&&row.platform===platform);
          if(!selected) throw new Error(t('กรุณาเลือกบริการและราคาแพ็กเกจ'));
          return shop('orders',{...data,amount:selected.amount,days:selected.days});
        },view,t('สร้างออเดอร์'));
        const service=orderForm.elements.platform;
        const packagePicker=orderForm.elements.package_id;
        const confirm=orderForm.elements.confirm;
        const submit=orderForm.querySelector('button');
        const updateConfirmation=()=>{
          confirm.checked=false;
          confirm.disabled=!packagePicker.value;
          submit.disabled=!packagePicker.value;
        };
        const showPackages=()=>{
          const options=packages.filter(row=>row.platform===service.value);
          const placeholder=!service.value?t('เลือกบริการสตรีมมิงก่อน'):
            options.length?t('เลือกราคาแพ็กเกจ'):t('ยังไม่มีแพ็กเกจ ไปที่ตั้งค่าเพื่อเพิ่ม');
          packagePicker.replaceChildren(new Option(placeholder,''),
            ...options.map(row=>new Option(row.name+' · '+daysLabel(row.days)+' · '+baht.format(row.amount),row.id)));
          packagePicker.disabled=!options.length;
          updateConfirmation();
        };
        service.addEventListener('change',showPackages);
        packagePicker.addEventListener('change',updateConfirmation);
        showPackages();
      }
      const allocation=element('div');
      let queueKey,waitingKey;
      function updateQueue(items){
        const signature=JSON.stringify(items.map(row=>[row.id,row.status]));
        if(signature!==queueKey){
          queueKey=signature;
          queue.replaceChildren();
          if(items.length) list(items,row=>row.amount+t(' บาท · ')+(status[row.status]??row.status),queue);
          else element('p',t('ไม่มีออเดอร์ที่ต้องส่งมอบ'),queue);
        }
        const waiting=items.filter(row=>row.status==='PAID_WAITING');
        const waitingIds=waiting.map(row=>row.id).join(',');
        if(waitingIds!==waitingKey){
          waitingKey=waitingIds;
          allocation.replaceChildren();
          if(waiting.length) allocationForm(waiting,customers,allocation);
        }
      }
      async function refreshOrders(){
        if(!current()) return;
        try {
          const active=await shop('orders?scope=active');
          if(current()) updateQueue(active);
        } catch {
          // Keep the existing queue visible during a transient API error.
        }
        if(current()) orderPoll=setTimeout(refreshOrders,3000);
      }
      updateQueue(orders);
      orderPoll=setTimeout(refreshOrders,3000);
    } else if(page==='rentals'){
      const [rentals,customers,packages]=await Promise.all([
        shop('rentals'),role==='OWNER'?shop('customers'):[],role==='OWNER'?shop('packages'):[]
      ]);
      if(!current()) return;
      element('h1',t('การเช่า'));
      list(rentals,row=>(status[row.status]??row.status)+t(' · ถึง ')+storeDate.format(new Date(row.ends_at)));
      if(role==='OWNER') for(const rental of rentals.filter(row=>row.status==='ACTIVE'&&Date.parse(row.ends_at)>Date.now())){
        const details=element('details');
        const original=packages.find(row=>row.id===rental.package_id);
        const customer=customers.find(row=>row.id===rental.customer_id);
        element('summary',(customer?customerLabel(customer)+' · ':'')+t('จัดการการเช่า · ถึง ')+storeDate.format(new Date(rental.ends_at)),details);
        const extend=(action,data)=>shop('rentals/'+rental.id+'/'+action,{...data,expected_ends_at:rental.ends_at});
        if(original) form(t('ต่ออายุด้วยแพ็กเกจเดิม'),[
          ['package_id',t('แพ็กเกจเดิม'),'',[['',t('เลือกแพ็กเกจเดิม')],[original.id,packageLabel(original)]]],
          ['confirm',t('ยืนยันการใช้เครดิตตามราคาแพ็กเกจ'),'checkbox']
        ],data=>extend('renew',{...data,amount:original.amount,days:original.days}),details,t('ต่ออายุ'));
        else element('p',t('รายการเช่านี้ไม่มีแพ็กเกจเดิมสำหรับต่ออายุ'),details);
        form(t('สร้างออเดอร์ชดเชย'),[
          ['days',t('จำนวนวันเพิ่ม'),{type:'number',min:1,max:365,step:1}],
          ['reason',t('เหตุผลการชดเชย')],
          ['confirm',t('ยืนยันชดเชยโดยไม่หักเครดิต'),'checkbox']
        ],data=>extend('compensate',{...data,days:Number(data.days)}),details,t('สร้างออเดอร์ชดเชย'));
      }
    } else if(page==='owner-settings'){
      const send=(path,data)=>store?shop(path,data):request('owner/'+path,data);
      const requests=await send('store-requests');
      if(!current()) return;
      element('h1',t('ตั้งค่า Owner'));
      passwordForm(data=>send(store?'owner-password':'password',data));
      form(store?t('ขอเพิ่มร้านค้า'):t('ขอเปิดร้านแรก'),[['name',t('ชื่อร้าน')]],data=>send('store-requests',data),view,t('ส่งคำขอเพิ่มร้าน'));
      element('h2',t('สถานะคำขอ'));
      list(requests,row=>row.name+' · '+requestStatus[row.status]);
    } else {
      const packages=await shop('packages');
      if(!current()) return;
      element('h1',t('ตั้งค่า'));
      form(t('เพิ่มแพ็กเกจสตรีมมิง'),[
        ['platform',t('แพลตฟอร์ม'),'',streamingPlatforms],...packageFields()
      ],data=>shop('packages',{...data,days:Number(data.days)}),view,t('เพิ่มแพ็กเกจ'));
      for(const entry of packages){
        const details=element('details');
        element('summary',packageLabel(entry),details);
        form(t('แก้ไขแพ็กเกจ'),packageFields(entry),
          data=>shop('packages/'+entry.id,{...data,days:Number(data.days)}),details);
      }
      form(t('เพิ่มพนักงานในเครื่องทดสอบ'),[['username',t('ชื่อผู้ใช้')],['password',t('รหัสผ่านเริ่มต้น'),'password'],
        ['role',t('สิทธิ์'),'',[['STAFF',t('พนักงาน')],['HEAD_STAFF',t('หัวหน้าพนักงาน')]]]],data=>shop('staff',data));
    }
    if(current()) notice('');
  } catch(error){ if(current()) notice(error.message); }
}
function selectStore(id) {
  if(store!==id) selectedAccount=undefined;
  store=id;
  role=identity.stores.find(row=>row.id===id)?.role;
  byId('user-level').textContent=identity.is_super?'Super Admin':identity.is_admin?'Admin':userLevels[role]??(identity.is_owner?'Owner':t('บัญชีผู้ใช้'));
  byId('store-control').hidden=!identity.stores.length||identity.is_super||identity.is_admin;
  const picker=byId('store');
  picker.replaceChildren(...identity.stores.map(row=>new Option(row.name,row.id)));
  if(id) picker.value=id;
  const profile=byId('owner-settings');
  profile.hidden=!identity.is_super&&!identity.is_admin&&role!=='OWNER'&&(Boolean(store)||!identity.is_owner);
  profile.title=identity.is_super?t('ตั้งค่า Super Admin'):identity.is_admin?t('ตั้งค่า Admin'):t('ตั้งค่า Owner');
  profile.setAttribute('aria-label',profile.title);
}
function syncLanguage() {
  document.documentElement.lang=getLanguage();
  baht=new Intl.NumberFormat(locale(),{style:'currency',currency:'THB',currencyDisplay:'narrowSymbol'});
  storeDate=new Intl.DateTimeFormat(locale(),{timeZone:'Asia/Bangkok',dateStyle:'medium',timeStyle:'short'});
  for(const node of document.querySelectorAll('[data-i18n]')) node.textContent=t(node.dataset.i18n);
  for(const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label',t(node.dataset.i18nLabel));
  const toggle=byId('language-switch');
  toggle.textContent=getLanguage()==='th'?'English':'ไทย';
  toggle.setAttribute('aria-label',t('เปลี่ยนภาษา')+' · '+toggle.textContent);
  if(session&&identity) selectStore(store);
  else byId('user-level').textContent=t('บัญชีผู้ใช้');
}
byId('language-switch').onclick=()=>{
  setLanguage(getLanguage()==='th'?'en':'th');
  syncLanguage();
  if(session&&identity) render();
  else notice('');
};
syncLanguage();
byId('credentials').onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button');
  button.disabled=true;
  try{
    session=(await request('login',Object.fromEntries(new FormData(form)))).token;
    identity=await request('me');
    if(!identity.is_super&&!identity.is_admin&&!identity.is_owner&&!identity.stores.length) throw new Error(t('บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าร้าน'));
    form.reset();
    selectStore(identity.stores[0]?.id);
    page=identity.is_super?'home':identity.is_admin?'requests':store?'home':'owner-settings';
    byId('login').hidden=true;
    byId('workspace').hidden=false;
    await render();
  }catch(error){session=undefined;notice(error.message);}
  finally{button.disabled=false;}
};
byId('store').onchange=event=>{
  selectStore(event.target.value);
  page='home';
  render();
};
byId('owner-settings').onclick=async()=>{
  try {
    if(identity.is_super||identity.is_admin){
      page='admin-settings';
      await render();
      return;
    }
    identity=await request('me');
    const previousStore=store;
    selectStore(store??identity.stores[0]?.id);
    page=!previousStore&&store?'home':'owner-settings';
    await render();
  } catch(error){ notice(error.message); }
};
byId('logout').onclick=async()=>{
  try {await request('logout',{});} catch(error){notice(error.message);return;}
  ++renderId;
  clearTimeout(orderPoll);
  session=undefined;
  selectedAccount=undefined;
  adminOwnerId=undefined;
  adminShopId=undefined;
  ownerDirectory.page=shopDirectory.page=0;
  ownerDirectory.query=shopDirectory.query='';
  byId('user-level').textContent=t('บัญชีผู้ใช้');
  byId('owner-settings').hidden=true;
  byId('workspace').hidden=true;
  byId('login').hidden=false;
  notice(t('ออกจากระบบแล้ว'));
  byId('credentials').elements.username.focus();
};

