const byId=id=>document.getElementById(id);
const view=byId('view');
let session,identity,store,role,selectedAccount,orderPoll,page='home',renderId=0;
const errors={
  USE_ACTIVE_STORE:'กรุณาเลือกหนึ่งในร้านที่เปิดใช้งานก่อนขอเพิ่มร้าน',
  OWNER_UNAVAILABLE:'กรุณาเลือก Owner ที่ยังใช้งานได้',
  STREAMING_EMAIL_BOUND:'อีเมลนี้ผูกกับบัญชีแล้ว จึงยังเปลี่ยนที่อยู่อีเมลไม่ได้',
  PROFILE_IN_USE:'โปรไฟล์นี้มีการใช้งานหรืองานค้าง จึงยังทำรายการไม่ได้',
  INVALID_PROFILE_PIN:'กรุณากรอก PIN จำลองเป็นตัวเลข 4 หลัก',
  STORE_SETTINGS_CHANGED:'ข้อมูลร้านเปลี่ยนแล้วหรือร้านปิดแล้ว กรุณาเปิดหน้าร้านค้าใหม่',
  INVALID_EXPIRY:'กรุณาเลือกวันหมดอายุที่ถูกต้อง',
  INVALID_CUSTOMER_URL:'กรุณากรอก URL ที่ขึ้นต้นด้วย https:// หรือ http://',
  RENTAL_CHANGED:'วันหมดอายุเปลี่ยนแล้ว กรุณาเปิดหน้าออเดอร์ใหม่และตรวจสอบอีกครั้ง',
  ORIGINAL_PACKAGE_REQUIRED:'การต่ออายุต้องใช้แพ็กเกจเดิมของรายการเช่า',
  RENTAL_EXTENSION_UNAVAILABLE:'เพิ่มวันไม่ได้ กรุณาตรวจสอบสถานะการเช่าและอายุสมาชิกของบัญชีสตรีมมิง',
  PACKAGE_PRICE_CHANGED:'ราคาหรือจำนวนวันของแพ็กเกจเปลี่ยนแล้ว กรุณาเปิดหน้าออเดอร์ใหม่และตรวจสอบก่อนยืนยัน',
  INVALID_DURATION:'กรุณาระบุจำนวนวันเป็นจำนวนเต็มตั้งแต่ 1 ถึง 365',
  STORE_REQUEST_PENDING:'มีคำขอชื่อร้านนี้รออนุมัติอยู่แล้ว',
  STORE_REQUEST_REVIEWED:'คำขอนี้ได้รับการพิจารณาแล้ว',
  REQUESTER_INACTIVE:'บัญชีผู้ขอปิดใช้งานอยู่',
  PASSWORD_UNCHANGED:'กรุณาใช้รหัสผ่านใหม่ที่ต่างจากเดิม',
  PASSWORD_POLICY:'รหัสผ่านต้องมี 12–128 ตัวอักษร',
  UNSUPPORTED_STREAMING_PLATFORM:'ขณะนี้เลือกได้เฉพาะ Netflix',
  MOCK_BIND_INVALID:'กรุณาตรวจ OTP จำลอง',
  STREAMING_EMAIL_PASSWORD_REQUIRED:'กรุณาตั้งรหัสผ่านในหน้าอีเมลบัญชีสตรีมมิงก่อน Bind',
  INVALID_PROFILE_COUNT:'กรุณาระบุจำนวนโปรไฟล์เป็นจำนวนเต็มตั้งแต่ 1 ถึง 100',
  INVALID_USERNAME:'ชื่อผู้ใช้ต้องมี 3–64 ตัว ใช้อักษรอังกฤษ ตัวเลข จุด ขีดกลาง หรือขีดล่าง',
  UNAUTHORIZED:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือเซสชันหมดอายุ',
  INSUFFICIENT_CREDIT:'เครดิตไม่เพียงพอ กรุณาตรวจสอบยอดของลูกค้า',
  NO_ELIGIBLE_ALLOCATION:'ยังไม่มีออเดอร์และโปรไฟล์ที่พร้อมจัดสรร กรุณาตรวจสอบบัญชีและอายุสมาชิก',
  FORBIDDEN:'บัญชีของคุณไม่มีสิทธิ์ดำเนินการ',REAUTH_REQUIRED:'กรุณาตรวจสอบรหัสผ่านปัจจุบัน',
  LAST_ACTIVE_ADMIN:'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อยหนึ่งคน'
};
const status={PAID_WAITING:'รอจัดสรร',DELIVERING:'กำลังส่งมอบ',FULFILLED:'ส่งมอบแล้ว',REVOCATION_PENDING:'รอยืนยันถอนสิทธิ์',
  ACTIVE:'กำลังใช้งาน',CLOSED:'ปิดแล้ว',QUEUED:'รอดำเนินการ',RUNNING:'กำลังตรวจสอบ',SUCCEEDED:'สำเร็จ',
  BLOCKED:'ต้องตรวจสอบ',HEALTHY:'พร้อมใช้งาน',UNKNOWN:'ยังไม่ยืนยัน'};
const requestStatus={PENDING:'รออนุมัติ',APPROVED:'อนุมัติแล้ว',REJECTED:'ไม่อนุมัติ'};
const storeStatus={ACTIVE:'เปิดใช้งาน',SUSPENDED:'ระงับใช้งาน',CLOSED:'ปิดแล้ว'};
const baht=new Intl.NumberFormat('th-TH',{style:'currency',currency:'THB'});
const userLevels={OWNER:'Owner',HEAD_STAFF:'Head Staff',STAFF:'Staff'};
const storeDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'});
const storeDate=new Intl.DateTimeFormat('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'medium',timeStyle:'short'});
const streamingPlatforms=[['netflix','Netflix']];
const platformName=platform=>streamingPlatforms.find(([id])=>id===platform)?.[1]??platform;
const accountLabel=account=>platformName(account.platform)+' · '+account.email.replace(/^(.).*(@.*)$/,'$1•••$2');
const profileStatus={AVAILABLE:'พร้อมใช้งาน',RESERVED:'รอส่งมอบ',OCCUPIED:'กำลังใช้งาน',HELD:'พักการใช้งาน'};
const customerLabel=customer=>customer.name+(customer.alias?' ('+customer.alias+')':'');
const customerContactFields=(customer={})=>[
  ['url','URL',{type:'url',required:false,maxLength:2048,value:customer.url??''}],
  ['alias','ชื่อเรียก (Alias)',{type:'text',required:false,maxLength:150,value:customer.alias??''}]
];
const packageLabel=row=>platformName(row.platform)+' · '+row.name+' · '+row.days+' วัน · ฿'+row.amount;
function packageFields(entry={}) {
  const selectedDays=entry.days??30;
  const durations=[...new Set([1,7,30,selectedDays])].sort((a,b)=>a-b);
  return [
    ['name','ชื่อแพ็กเกจ',{type:'text',value:entry.name??''}],
    ['days','จำนวนวัน','',durations.map(days=>[String(days),days+' วัน',days===selectedDays])],
    ['amount','ราคา (บาท)',{type:'number',min:0.01,step:0.01,value:entry.amount??''}]
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
  if(!res.ok) throw new Error(errors[data.code]??'ทำรายการไม่สำเร็จ กรุณาตรวจสอบข้อมูลแล้วลองอีกครั้ง');
  return data;
}
const shop=(path,body)=>request('stores/'+store+'/'+path,body);
function list(rows,description,parent=view) {
  if(!rows.length) return element('p','ยังไม่มีรายการ',parent);
  const ul=element('ul',undefined,parent);
  for(const row of rows) element('li',description(row),ul);
}
function form(title,fields,submit,parent=view,buttonText='บันทึก') {
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
    notice('กำลังบันทึก…');
    const data=Object.fromEntries(Array.from(new FormData(node),([name,value])=>[name,node.elements.namedItem(name)?.type==='checkbox'?true:value]));
    try { await submit(data); await render(); notice('บันทึกสำเร็จ'); }
    catch(error){ notice(error.message); }
    finally { button.disabled=false; }
  });
  return node;
}
const choices=(rows,format)=>rows.map(row=>[row.id,format(row)]);
function passwordForm(submit) {
  form('เปลี่ยนรหัสผ่าน',[
    ['current_password','รหัสผ่านปัจจุบัน',{type:'password',autocomplete:'current-password'}],
    ['new_password','รหัสผ่านใหม่',{type:'password',autocomplete:'new-password',minLength:12,maxLength:128}],
    ['confirm_password','ยืนยันรหัสผ่านใหม่',{type:'password',autocomplete:'new-password'}]
  ],({confirm_password,...data})=>{
    if(confirm_password!==data.new_password) throw new Error('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
    return submit(data);
  },view,'เปลี่ยนรหัสผ่าน');
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
  if(!packages.length) return element('p','ยังไม่มีแพ็กเกจหรือยอดขาย',parent);
  summaryTable(parent,['บริการ','แพ็กเกจ','ระยะเวลา','ราคาต่อรายการ','ขายได้','ยอดขาย'],
    packages.map(row=>[platformName(row.platform)??'—',row.name,row.days+' วัน',baht.format(row.unit_price),row.sold,baht.format(row.total)]));
}
function storeSales(details,path) {
  const panel=element('section',undefined,details);
  let loaded=false,loading=false;
  details.addEventListener('toggle',async()=>{
    if(!details.open||loaded||loading) return;
    loading=true;
    panel.replaceChildren();
    element('p','กำลังโหลดยอดขาย…',panel);
    try {
      const sales=await request(path+'sales');
      if(!panel.isConnected) return;
      panel.replaceChildren();
      element('h2','ยอดขายตามออเดอร์',panel);
      const metrics=element('div',undefined,panel);
      metrics.className='sales-metrics';
      for(const [label,value] of [
        ['ยอดขายรวม',baht.format(sales.total_sales)],['แพ็กเกจขายได้',sales.packages_sold],
        ['ออเดอร์ใหม่',sales.purchase_count],['ต่ออายุ',sales.renewal_count],['ชดเชย',sales.compensation_count]
      ]){
        const metric=element('div',undefined,metrics);
        element('span',label,metric);
        element('strong',String(value),metric);
      }
      packageSalesTable(panel,sales.packages);
      loaded=true;
    } catch(error){
      panel.replaceChildren();
      element('p',error.message,panel);
    } finally {loading=false;}
  });
}
function allocationForm(orders,customers,parent) {
  const names=new Map(customers.map(customer=>[customer.id,customerLabel(customer)]));
  const panel=form('จัดสรรโปรไฟล์และส่งงานจำลอง',[
    ['order_id','ออเดอร์รอจัดสรร','',choices(orders,row=>[
      platformName(row.platform)??'ออเดอร์เดิม',names.get(row.customer_id),row.days+' วัน',row.amount+' บาท',row.id.slice(0,8)
    ].filter(Boolean).join(' · '))],
    ['query','ค้นหาบัญชีสตรีมมิง',{type:'search',required:false,placeholder:'ชื่อบริการหรืออีเมลบัญชี'}]
  ],({account_id,order_id})=>shop('allocate',{account_id,order_id}),parent,'จัดสรรและส่งงาน');
  const submit=panel.querySelector('button');
  const search=panel.elements.query;
  const order=panel.elements.order_id;
  let accounts=[],loadId=0;
  const field=element('fieldset',undefined,panel);
  field.className='allocation-accounts';
  const legend=element('legend','บัญชีสำหรับออเดอร์ที่เลือก',field);
  const results=element('div',undefined,field);
  panel.insertBefore(field,submit);
  function showAccounts(){
    const selected=results.querySelector('input:checked')?.value;
    const query=search.value.trim().toLowerCase();
    const matches=accounts.filter(account=>(platformName(account.platform)+' '+account.email).toLowerCase().includes(query));
    results.replaceChildren();
    submit.disabled=true;
    if(!matches.length) element('p',query?'ไม่พบบัญชีที่ตรงกับคำค้น':'ยังไม่มีบัญชีสตรีมมิง',results);
    for(const account of matches){
      const eligible=account.available_profiles>0&&account.accepts_waiting_order;
      const label=element('label',undefined,results);
      const radio=element('input',undefined,label);
      Object.assign(radio,{type:'radio',name:'account_id',value:account.id,disabled:!eligible,required:eligible});
      radio.checked=eligible&&selected===account.id;
      if(radio.checked) submit.disabled=false;
      radio.onchange=()=>{submit.disabled=false;};
      const readiness=eligible?'พร้อมจัดสรร':account.available_profiles===0?'ไม่มีโปรไฟล์ว่าง':
        account.health!=='HEALTHY'?(status[account.health]??'ต้องตรวจสอบ'):'ยังไม่พร้อมสำหรับออเดอร์นี้';
      element('span',accountLabel(account)+' · ว่าง '+account.available_profiles+' โปรไฟล์ · '+readiness,label);
    }
  }
  async function loadAccounts(){
    const id=++loadId;
    const platform=orders.find(row=>row.id===order.value)?.platform;
    legend.textContent=platform?'บัญชี '+platformName(platform):'บัญชีสำหรับออเดอร์ที่เลือก';
    accounts=[];
    submit.disabled=true;
    search.disabled=true;
    results.replaceChildren();
    element('p','กำลังโหลดบัญชี…',results);
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
  const menus=identity.is_super?[['home','ร้านค้า'],['requests','คำขอเพิ่มร้านค้า'],['admins','ผู้ดูแลระบบ']]:
    identity.is_admin?[['requests','คำขอเพิ่มร้านค้า']]:!store?[]:
    [['home','ภาพรวม'],['orders','ออเดอร์'],['rentals','การเช่า'],['customers','ลูกค้า'],['inventory','บัญชีสตรีมมิง'],
      ...(role==='OWNER'?[['streaming-emails','อีเมลบัญชีสตรีมมิง'],['finance','การเงิน'],['settings','ตั้งค่า']]:[])];
  const panel=byId('navigation');
  panel.replaceChildren();
  for(const [key,title] of menus){
    const button=element('button',title,panel);
    if(key===page) button.setAttribute('aria-current','page');
    button.onclick=()=>{page=key;render();};
  }
}
function ownerOverview(overview,renewals) {
  const go=(parent,label,destination,style)=>{
    const button=element('button',label,parent);
    button.className=style;
    button.onclick=()=>{page=destination;render();};
  };
  const number=new Intl.NumberFormat('th-TH');
  const now=Date.now();
  const soon=renewals.flatMap(customer=>customer.rentals.map(rental=>({customer,rental})))
    .filter(({rental})=>Date.parse(rental.ends_at)>now&&Date.parse(rental.ends_at)<=now+3*86400000)
    .sort((a,b)=>Date.parse(a.rental.ends_at)-Date.parse(b.rental.ends_at));
  const waiting=overview.backlog.reduce((total,row)=>total+row.waiting,0);
  const delivering=overview.backlog.reduce((total,row)=>total+row.delivering,0);

  const hero=element('section');
  hero.className='overview-hero';
  element('p','ภาพรวมร้าน',hero).className='overview-hero-label';
  element('h1',identity.stores.find(row=>row.id===store)?.name??'ร้านของคุณ',hero);
  const shortcuts=element('div',undefined,hero);
  shortcuts.className='overview-shortcuts';
  go(shortcuts,'จัดการออเดอร์','orders','overview-primary');
  go(shortcuts,'ดูรายชื่อลูกค้า','customers','overview-secondary');

  const tasks=element('section');
  tasks.className='overview-tasks';
  element('h2','สิ่งที่ต้องทำ',tasks);
  const metrics=element('div',undefined,tasks);
  metrics.className='overview-metrics';
  for(const [label,value,meta,destination,tone] of [
    ['ออเดอร์ค้าง',waiting+delivering,'รอจัดสรร '+number.format(waiting)+' · ส่งมอบ '+number.format(delivering),'orders','mint'],
    ['รอตรวจยอดชำระ',overview.payments_pending,'ดูรายการชำระเงิน','finance','blue'],
    ['สิทธิ์ใกล้หมดอายุ',overview.expiring,'ภายใน 3 วัน','customers','amber'],
    ['เหตุการณ์ที่บันทึก',overview.incident_count,'ดูบัญชีสตรีมมิง','inventory','purple']
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
    element('h2','ออเดอร์ค้างแยกตามแพ็กเกจ',backlog);
    summaryTable(backlog,['บริการ','แพ็กเกจ','ระยะเวลา','รอจัดสรร','กำลังส่งมอบ','รวม'],
      overview.backlog.map(row=>[platformName(row.platform)??'—',row.name,row.days+' วัน',row.waiting,row.delivering,row.waiting+row.delivering]));
  }

  const finance=element('section');
  finance.className='overview-panel';
  element('h2','เครดิตเข้าและยอดขายแพ็กเกจ',finance);
  const totals=element('div',undefined,finance);
  totals.className='sales-metrics overview-finance';
  for(const [label,value,help] of [
    ['เครดิตเข้าที่อนุมัติแล้ว',baht.format(overview.credits_in),'ยอดสะสมจากการเติมเครดิต'],
    ['ยอดซื้อแพ็กเกจทั้งหมด',baht.format(overview.sales.package_sales),
      number.format(overview.sales.packages_sold)+' แพ็กเกจ · รวมต่ออายุ']
  ]){
    const tile=element('div',undefined,totals);
    element('span',label,tile);
    element('strong',value,tile);
    element('small',help,tile);
  }
  packageSalesTable(finance,overview.sales.packages.filter(row=>row.package_id));

  const columns=element('div');
  columns.className='overview-columns';
  const expiring=element('section',undefined,columns);
  expiring.className='overview-panel';
  const expiryHeading=element('div',undefined,expiring);
  expiryHeading.className='overview-panel-heading';
  element('h2','ติดต่อเพื่อต่ออายุ',expiryHeading);
  go(expiryHeading,'ดูลูกค้าทั้งหมด','customers','overview-text-button');
  if(!soon.length) element('p','ไม่มีรายการเช่าที่จะหมดอายุใน 3 วัน',expiring).className='overview-empty';
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
      element('strong','เหลือ '+Math.ceil((ends-now)/86400000)+' วัน',deadline);
      element('small',storeDate.format(ends)+' น.',deadline);
    }
  }

  const setup=element('section',undefined,columns);
  setup.className='overview-panel';
  element('h2','เริ่มต้นใช้งานร้าน',setup);
  const steps=[
    [overview.setup.packages,'ตั้งแพ็กเกจราคา','settings'],
    [overview.setup.accounts,'เพิ่มและตรวจบัญชีสตรีมมิง','inventory'],
    [overview.setup.profiles,'เพิ่มโปรไฟล์','inventory'],
    [overview.setup.customers,'เพิ่มลูกค้า','customers'],
    [overview.setup.rentals,'ทดลองเติมเครดิตและส่งมอบ','orders']
  ];
  const done=steps.filter(([completed])=>completed).length;
  const progress=element('progress',undefined,setup);
  Object.assign(progress,{value:done,max:steps.length});
  progress.setAttribute('aria-label','ความคืบหน้าการตั้งร้าน');
  element('p','เสร็จแล้ว '+done+' จาก '+steps.length+' ขั้นตอน',setup).className='overview-progress-text';
  const checklist=element('ul',undefined,setup);
  checklist.className='overview-checklist';
  for(const [completed,label,destination] of steps){
    const item=element('li',undefined,checklist);
    const mark=element('span',completed?'✓':'○',item);
    mark.className=completed?'done':'';
    mark.setAttribute('aria-label',completed?'เสร็จแล้ว':'ยังไม่เสร็จ');
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
  notice('กำลังโหลด…');
  try {
    if(identity.is_super||identity.is_admin){
      if(page==='home'){
        const [stores,owners]=await Promise.all([request('admin/stores'),request('admin/owners')]);
        if(!current()) return;
        element('h1','ร้านค้า');
        if(!stores.length) element('p','ยังไม่มีร้านค้า');
        for(const row of stores){
          const details=element('details');
          const end=new Date(Date.parse(row.expires_at)-1);
          const summary=element('summary',undefined,details);
          element('span',row.name+' · '+storeStatus[row.status],summary);
          element('span',' · หมดอายุ '+storeDate.format(end)+' น. (เวลาไทย)'+
            (Date.parse(row.expires_at)<=Date.now()?' · หมดอายุแล้ว':''),summary);
          const path='admin/stores/'+row.id+'/';
          storeSales(details,path);
          if(row.status==='CLOSED') continue;
          const selected=['ACTIVE','SUSPENDED'].map(value=>[value,storeStatus[value],value===row.status]);
          form('สถานะร้านค้า',[['status','สถานะ','',selected]],
            data=>request(path+'status',{...data,expected_status:row.status}),details,'บันทึกสถานะ');
          form('วันหมดอายุ',[['date','เลือกวันจากปฏิทิน',{type:'date',value:storeDay.format(end)}]],
            data=>request(path+'expiry',{...data,mode:'CALENDAR',expected_expiry:row.expires_at}),details,'บันทึกวันหมดอายุ');
          form('ปรับวันหมดอายุแบบเร็ว',[],
            ()=>request(path+'expiry',{mode:'ADD_MONTH',expected_expiry:row.expires_at}),details,'+1 เดือน');
        }
        if(owners.length) form('สร้างร้านค้า',[['name','ชื่อร้าน'],
          ['owner_id','เจ้าของร้าน','',[['','เลือก Owner'],...choices(owners,row=>row.username)]],
          ['current_password','รหัสผ่านปัจจุบัน','password']],data=>request('admin/stores',data));
        else element('p','เพิ่มผู้ใช้ระดับ Owner จากไอคอนรูปคนก่อนสร้างร้าน');
      } else if(page==='admin-settings'){
        element('h1',identity.is_super?'ตั้งค่า Super Admin':'ตั้งค่า Admin');
        passwordForm(data=>request('admin/password',data));
        form('เพิ่มผู้ใช้',[
          ['username','ชื่อผู้ใช้'],['password','รหัสผ่านเริ่มต้น',{type:'password',autocomplete:'new-password'}],
          ['role','ระดับผู้ใช้','',identity.is_super?[['','เลือกระดับผู้ใช้'],['ADMIN','Admin'],['OWNER','Owner']]:[['OWNER','Owner']]],
          ['current_password','รหัสผ่านปัจจุบัน',{type:'password',autocomplete:'current-password'}]
        ],data=>request('admin/users',data),view,'เพิ่มผู้ใช้');
      } else if(page==='requests'){
        const requests=await request('admin/store-requests');
        if(!current()) return;
        element('h1','คำขอเพิ่มร้านค้า');
        list(requests,row=>row.name+' · '+row.username+' · '+requestStatus[row.status]);
        const pending=requests.filter(row=>row.status==='PENDING');
        if(pending.length) form('พิจารณาคำขอ',[
          ['id','คำขอ','',choices(pending,row=>row.name+' · '+row.username)],
          ['status','ผลการพิจารณา','',identity.is_super?
            [['','เลือกผลการพิจารณา'],['APPROVED','อนุมัติ'],['REJECTED','ไม่อนุมัติ']]:[['APPROVED','อนุมัติ']]],
          ['current_password','รหัสผ่านปัจจุบัน','password']
        ],({id,...data})=>request('admin/store-requests/'+id+'/review',data),view,'บันทึกผล');
      } else {
        const admins=await request('admin/admins');
        if(!current()) return;
        element('h1','ผู้ดูแลระบบ');
        list(admins,row=>row.username+' · '+(row.active?'ใช้งานได้':'ปิดใช้งาน')+' · '+row.role);
        form('ยืนยันการเปลี่ยนสถานะผู้ดูแล',[['id','ผู้ดูแลระบบ','',choices(admins,r=>r.username)],['active','สถานะ','',[['false','ปิดใช้งาน'],['true','เปิดใช้งาน']]],
          ['current_password','รหัสผ่านปัจจุบัน','password'],['confirm','ตรวจสอบชื่อและยืนยันการเปลี่ยนสถานะ','checkbox']],
          ({id,active,current_password})=>request('admin/admins/'+id+'/status',{active:active==='true',current_password}));
      }
    } else if(page==='home'){
      if(role==='OWNER'){
        const [overview,renewals]=await Promise.all([shop('owner-overview'),shop('customer-renewals')]);
        if(!current()) return;
        ownerOverview(overview,renewals);
        notice('');
        return;
      }
      const [orders,rentals,accounts,profiles,incidents]=await Promise.all([
        shop('orders?scope=active'),shop('rentals'),shop('accounts'),shop('profiles'),shop('incidents')]);
      if(!current()) return;
      element('h1','สิ่งที่ต้องทำ');
      element('p','ออเดอร์รอจัดสรร '+orders.filter(row=>row.status==='PAID_WAITING').length+' รายการ');
      element('p','สิทธิ์ใกล้หมดอายุ '+rentals.filter(row=>row.status==='ACTIVE'&&Date.parse(row.ends_at)<Date.now()+86400000).length+' รายการ');
      element('p','เหตุการณ์ที่บันทึกไว้ '+incidents.length+' รายการ');
      element('h2','เริ่มต้นใช้งานร้าน');
      list([
        [true,'ตรวจข้อมูลร้าน'],[accounts.some(r=>r.health==='HEALTHY'),'เพิ่มและตรวจบัญชีสตรีมมิง'],
        [profiles.length,'เพิ่มโปรไฟล์'],[rentals.length,'ทดลองเติมเครดิตและส่งมอบ']
      ],([done,label])=>(done?'เสร็จแล้ว · ':'ยังไม่เสร็จ · ')+label);
      element('p','การขาย การเติมเครดิต และการส่งมอบในหน้านี้เป็นข้อมูลจำลอง');
    } else if(page==='customers'){
      const rows=await shop('customer-renewals');
      if(!current()) return;
      element('h1','ลูกค้า');
      if(role==='OWNER') form('เพิ่มลูกค้า',[['name','ชื่อลูกค้า'],...customerContactFields()],data=>shop('customers',data));
      if(!rows.length) element('p','ยังไม่มีรายการ');
      const now=Date.now();
      for(const row of rows){
        const card=element('section');
        card.className='customer-card';
        element('h2',customerLabel(row)+(row.balance!==undefined?' · เครดิต ฿'+row.balance:''),card);
        if(row.url && /^https?:\/\//i.test(row.url)){
          const link=element('a','เปิด URL ของลูกค้า',card);
          Object.assign(link,{href:row.url,target:'_blank',rel:'noopener noreferrer'});
        }
        if(!row.rentals.length) element('p','ไม่มีแพ็กเกจที่ต้องติดตาม',card);
        else {
          const listNode=element('ul',undefined,card);
          for(const rental of row.rentals){
            const item=element('li',undefined,listNode);
            const ends=new Date(rental.ends_at);
            const remaining=Math.max(0,Math.ceil((ends-now)/86400000));
            element('span',[accountLabel({platform:rental.platform,email:rental.account_email}),rental.profile_label,
              rental.package_name,rental.package_days+' วัน'].filter(Boolean).join(' · '),item);
            const countdown=element('strong',remaining===0?'หมดอายุแล้ว':'เหลือ '+remaining+' วัน',item);
            countdown.className=remaining<=3?'renewal-soon':'';
            element('small','หมดอายุ '+storeDate.format(ends)+' น.'+(remaining>0&&remaining<=3?' · ควรติดต่อลูกค้าเรื่องต่ออายุ':''),item);
          }
        }
        if(role==='OWNER'){
          const details=element('details',undefined,card);
          element('summary','แก้ไขข้อมูลลูกค้า',details);
          form('แก้ไข URL และชื่อเรียก',customerContactFields(row),data=>shop('customers/'+row.id+'/contact',data),details);
        }
      }
    } else if(page==='streaming-emails'){
      const emails=await shop('streaming-emails');
      if(!current()) return;
      element('h1','อีเมลบัญชีสตรีมมิง');
      element('p','เพิ่มอีเมลและรหัสผ่านสมมติไว้เลือกตอน Bind บัญชี');
      form('เพิ่มอีเมลบัญชีสตรีมมิง',[
        ['email','อีเมลบัญชีจำลอง','email'],
        ['password','รหัสผ่านอีเมล',{type:'password',minLength:12,maxLength:128,autocomplete:'new-password'}]
      ],data=>shop('streaming-emails',data),view,'เพิ่มอีเมล');
      for(const row of emails){
        const details=element('details');
        const bound=row.bound_platforms.length>0;
        element('summary',row.email+' · '+(bound?'ผูกบัญชีแล้ว':'ยังไม่ได้ผูกบัญชี'),details);
        if(!row.password_set) element('p','ยังไม่ได้ตั้งรหัสผ่านอีเมล',details);
        const fields=bound?[]:[['email','อีเมลบัญชีจำลอง',{type:'email',value:row.email}]];
        fields.push(['password','รหัสผ่านอีเมลใหม่',{type:'password',required:bound||!row.password_set,minLength:12,maxLength:128,autocomplete:'new-password'}]);
        form('แก้ไขข้อมูลอีเมล',fields,data=>shop('streaming-emails/'+row.id,data),details);
      }
    } else if(page==='inventory'){
      const [accounts,profiles,jobs,emails]=await Promise.all([shop('accounts'),shop('profiles'),shop('bot-jobs'),shop('streaming-emails')]);
      if(!current()) return;
      const account=accounts.find(row=>row.id===selectedAccount);
      const heading=element('section');
      heading.className='inventory-heading';
      const headingText=element('div',undefined,heading);
      element('h1',account?accountLabel(account):'บัญชีสตรีมมิง',headingText);
      element('p',account?status[account.health]??account.health:accounts.length+' บัญชีที่ผูกไว้',headingText);
      if(account){
        const back=element('button','กลับไปยังรายการบัญชี',heading);
        back.className='inventory-back';
        back.onclick=()=>{selectedAccount=undefined;render();};
        const entries=profiles.filter(profile=>profile.account_id===account.id);
        const panel=element('section');
        panel.className='inventory-panel';
        element('h2','โปรไฟล์',panel);
        if(!entries.length) element('p','บัญชีนี้ยังไม่มีโปรไฟล์',panel);
        for(const profile of entries){
          const details=element(role==='OWNER'?'details':'div',undefined,panel);
          details.className='inventory-profile';
          const summary=element(role==='OWNER'?'summary':'div',undefined,details);
          summary.className='inventory-profile-summary';
          element('strong',profile.label,summary);
          const info=element('span',profileStatus[profile.status]+(profile.pin_set?' · ตั้ง PIN แล้ว':''),summary);
          info.className=profile.status==='AVAILABLE'?'inventory-status ready':'inventory-status';
          if(role!=='OWNER') continue;
          const actions=element('div',undefined,details);
          actions.className='inventory-profile-actions';
          const namePanel=element('div',undefined,actions);
          const path='accounts/'+account.id+'/profiles/'+profile.id+'/';
          form('แก้ไขชื่อโปรไฟล์',[['label','ชื่อโปรไฟล์',{type:'text',value:profile.label,maxLength:150}]],
            data=>shop(path+'rename',data),namePanel,'บันทึกชื่อ');
          if(profile.status==='AVAILABLE'){
            const pinPanel=element('div',undefined,actions);
            form('เปลี่ยน PIN จำลอง',[
              ['pin','PIN ใหม่ (4 หลัก)',{type:'password',inputMode:'numeric',minLength:4,maxLength:4,pattern:'[0-9]{4}',autocomplete:'new-password'}]
            ],data=>shop(path+'pin',data),pinPanel,'บันทึก PIN');
            const removePanel=element('div',undefined,actions);
            form('ลบโปรไฟล์',[['confirm','ยืนยันลบ '+profile.label,'checkbox']],
              data=>shop(path+'archive',data),removePanel,'ลบโปรไฟล์');
          } else element('p','เปลี่ยน PIN และลบได้เมื่อโปรไฟล์กลับมาพร้อมใช้งาน',actions);
        }
        const add=element('section');
        add.className='inventory-panel';
        form('เพิ่มโปรไฟล์',[['label','ชื่อโปรไฟล์']],data=>shop('profiles',{...data,account_id:account.id}),add,'เพิ่มโปรไฟล์');
      } else {
        const columns=element('div');
        columns.className='inventory-columns';
        const accountPanel=element('section',undefined,columns);
        accountPanel.className='inventory-panel';
        element('h2','บัญชีที่ผูกแล้ว',accountPanel);
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
          element('small','ว่าง '+matching.filter(profile=>profile.status==='AVAILABLE').length+' จาก '+matching.length+' โปรไฟล์',caption);
          element('span',state,open).className=row.health==='HEALTHY'?'inventory-status ready':'inventory-status';
          open.onclick=()=>{selectedAccount=row.id;render();};
        }
        if(!accounts.length) element('p','ยังไม่มีบัญชีสตรีมมิง',accountPanel).className='inventory-empty';
        const bindPanel=element('section',undefined,columns);
        bindPanel.className='inventory-panel';
        if(role==='OWNER'){
          const manage=element('button','ตั้งค่าอีเมลบัญชีสตรีมมิง',bindPanel);
          manage.className='inventory-link';
          manage.onclick=()=>{page='streaming-emails';render();};
        }
        const bind=form('เพิ่มบัญชีสตรีมมิงจำลอง',[
          ['platform','แพลตฟอร์ม','',streamingPlatforms],['email_id','อีเมลบัญชีสตรีมมิง','',[]],
          ['otp','OTP จำลอง',{type:'text',inputMode:'numeric',maxLength:6,pattern:'[0-9]{6}',autocomplete:'off'}],
          ['profile_count','จำนวนโปรไฟล์',{type:'number',min:1,max:100,step:1,value:5}]
        ],data=>shop('accounts',{...data,profile_count:Number(data.profile_count)}),bindPanel,'Bind บัญชี');
        element('p','เลือกอีเมลที่ตั้งรหัสผ่านไว้ ใช้ OTP จำลอง 123456',bindPanel).className='inventory-hint';
        const showEmails=()=>{
          const available=emails.filter(row=>row.password_set&&!row.bound_platforms.includes(bind.elements.platform.value));
          bind.elements.email_id.replaceChildren(new Option(available.length?'เลือกอีเมล':'ไม่มีอีเมลพร้อมผูกบัญชี',''),
            ...available.map(row=>new Option(row.email,row.id)));
          bind.elements.email_id.disabled=!available.length;
          bind.querySelector('button').disabled=!available.length;
        };
        bind.elements.platform.addEventListener('change',showEmails);
        showEmails();
      }
      const details=element('details');
      details.className='inventory-panel inventory-advanced';
      element('summary','รายละเอียดขั้นสูง',details);
      list(jobs.items.filter(job=>!account||job.account_id===account.id),row=>row.type+' · '+(status[row.status]??row.status),details);
    } else if(page==='finance'){
      const [customers,payments,transfers]=await Promise.all([shop('customers'),shop('payment-requests'),shop('transfers')]);
      if(!current()) return;
      element('h1','การเงินจำลอง');
      if(customers.length) form('สร้างคำขอชำระเงิน',[['customer_id','ลูกค้า','',choices(customers,customerLabel)],['amount','จำนวนเงิน (บาท)']],data=>shop('payment-requests',data));
      if(payments.length) form('บันทึกยอดโอนจำลอง',[['payment_id','คำขอชำระเงิน','',choices(payments,r=>r.amount+' บาท · '+r.id.slice(0,8))],
        ['amount','จำนวนเงิน (บาท)'],['evidence','รหัสหลักฐานจำลองขึ้นต้นด้วย mock-']],data=>shop('transfers',data));
      const pending=transfers.filter(row=>!row.approved_at);
      if(pending.length) form('ตรวจสอบและอนุมัติเครดิตจำลอง',[['id','ยอดโอน','',choices(pending,r=>r.amount+' บาท · '+r.id.slice(0,8))],
        ['confirm','ตรวจสอบยอดและยืนยันเพิ่มเครดิต','checkbox']],({id,confirm})=>shop('transfers/'+id+'/approve',{confirm}));
      if(!customers.length) element('p','เพิ่มลูกค้าก่อนสร้างคำขอชำระเงิน');
    } else if(page==='orders'){
      const [orders,customers,packages]=await Promise.all([
        shop('orders?scope=active'),role==='OWNER'?shop('customers'):[],shop('packages')
      ]);
      if(!current()) return;
      element('h1','ออเดอร์');
      const queue=element('div');
      if(customers.length){
        const orderForm=form('สร้างออเดอร์จำลอง',[
          ['customer_id','ลูกค้าและยอดเครดิต','',choices(customers,r=>customerLabel(r)+' · ฿'+r.balance)],
          ['platform','บริการสตรีมมิง','',[['','เลือกบริการสตรีมมิง'],...streamingPlatforms]],
          ['package_id','ราคาแพ็กเกจ','',[]],
          ['confirm','ยืนยันการใช้เครดิตตามราคาแพ็กเกจ','checkbox']
        ],({platform,...data})=>{
          const selected=packages.find(row=>row.id===data.package_id&&row.platform===platform);
          if(!selected) throw new Error('กรุณาเลือกบริการและราคาแพ็กเกจ');
          return shop('orders',{...data,amount:selected.amount,days:selected.days});
        },view,'สร้างออเดอร์');
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
          const placeholder=!service.value?'เลือกบริการสตรีมมิงก่อน':
            options.length?'เลือกราคาแพ็กเกจ':'ยังไม่มีแพ็กเกจ ไปที่ตั้งค่าเพื่อเพิ่ม';
          packagePicker.replaceChildren(new Option(placeholder,''),
            ...options.map(row=>new Option(row.name+' · '+row.days+' วัน · ฿'+row.amount,row.id)));
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
          if(items.length) list(items,row=>row.amount+' บาท · '+(status[row.status]??row.status),queue);
          else element('p','ไม่มีออเดอร์ที่ต้องส่งมอบ',queue);
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
      element('h1','การเช่า');
      list(rentals,row=>(status[row.status]??row.status)+' · ถึง '+new Date(row.ends_at).toLocaleString('th-TH'));
      if(role==='OWNER') for(const rental of rentals.filter(row=>row.status==='ACTIVE'&&Date.parse(row.ends_at)>Date.now())){
        const details=element('details');
        const original=packages.find(row=>row.id===rental.package_id);
        const customer=customers.find(row=>row.id===rental.customer_id);
        element('summary',(customer?customerLabel(customer)+' · ':'')+'จัดการการเช่า · ถึง '+new Date(rental.ends_at).toLocaleString('th-TH'),details);
        const extend=(action,data)=>shop('rentals/'+rental.id+'/'+action,{...data,expected_ends_at:rental.ends_at});
        if(original) form('ต่ออายุด้วยแพ็กเกจเดิม',[
          ['package_id','แพ็กเกจเดิม','',[['','เลือกแพ็กเกจเดิม'],[original.id,packageLabel(original)]]],
          ['confirm','ยืนยันการใช้เครดิตตามราคาแพ็กเกจ','checkbox']
        ],data=>extend('renew',{...data,amount:original.amount,days:original.days}),details,'ต่ออายุ');
        else element('p','รายการเช่านี้ไม่มีแพ็กเกจเดิมสำหรับต่ออายุ',details);
        form('สร้างออเดอร์ชดเชย',[
          ['days','จำนวนวันเพิ่ม',{type:'number',min:1,max:365,step:1}],
          ['reason','เหตุผลการชดเชย'],
          ['confirm','ยืนยันชดเชยโดยไม่หักเครดิต','checkbox']
        ],data=>extend('compensate',{...data,days:Number(data.days)}),details,'สร้างออเดอร์ชดเชย');
      }
    } else if(page==='owner-settings'){
      const send=(path,data)=>store?shop(path,data):request('owner/'+path,data);
      const requests=await send('store-requests');
      if(!current()) return;
      element('h1','ตั้งค่า Owner');
      passwordForm(data=>send(store?'owner-password':'password',data));
      form(store?'ขอเพิ่มร้านค้า':'ขอเปิดร้านแรก',[['name','ชื่อร้าน']],data=>send('store-requests',data),view,'ส่งคำขอเพิ่มร้าน');
      element('h2','สถานะคำขอ');
      list(requests,row=>row.name+' · '+requestStatus[row.status]);
    } else {
      const packages=await shop('packages');
      if(!current()) return;
      element('h1','ตั้งค่า');
      form('เพิ่มแพ็กเกจสตรีมมิง',[
        ['platform','แพลตฟอร์ม','',streamingPlatforms],...packageFields()
      ],data=>shop('packages',{...data,days:Number(data.days)}),view,'เพิ่มแพ็กเกจ');
      for(const entry of packages){
        const details=element('details');
        element('summary',packageLabel(entry),details);
        form('แก้ไขแพ็กเกจ',packageFields(entry),
          data=>shop('packages/'+entry.id,{...data,days:Number(data.days)}),details);
      }
      form('เพิ่มพนักงานในเครื่องทดสอบ',[['username','ชื่อผู้ใช้'],['password','รหัสผ่านเริ่มต้น','password'],
        ['role','สิทธิ์','',[['STAFF','พนักงาน'],['HEAD_STAFF','หัวหน้าพนักงาน']]]],data=>shop('staff',data));
    }
    if(current()) notice('');
  } catch(error){ if(current()) notice(error.message); }
}
function selectStore(id) {
  if(store!==id) selectedAccount=undefined;
  store=id;
  role=identity.stores.find(row=>row.id===id)?.role;
  byId('user-level').textContent=identity.is_super?'Super Admin':identity.is_admin?'Admin':userLevels[role]??(identity.is_owner?'Owner':'บัญชีผู้ใช้');
  byId('store-control').hidden=!identity.stores.length||identity.is_super||identity.is_admin;
  const picker=byId('store');
  picker.replaceChildren(...identity.stores.map(row=>new Option(row.name,row.id)));
  if(id) picker.value=id;
  const profile=byId('owner-settings');
  profile.hidden=!identity.is_super&&!identity.is_admin&&role!=='OWNER'&&(Boolean(store)||!identity.is_owner);
  profile.title=identity.is_super?'ตั้งค่า Super Admin':identity.is_admin?'ตั้งค่า Admin':'ตั้งค่า Owner';
  profile.setAttribute('aria-label',profile.title);
}
byId('credentials').onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button');
  button.disabled=true;
  try{
    session=(await request('login',Object.fromEntries(new FormData(form)))).token;
    identity=await request('me');
    if(!identity.is_super&&!identity.is_admin&&!identity.is_owner&&!identity.stores.length) throw new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าร้าน');
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
  byId('user-level').textContent='บัญชีผู้ใช้';
  byId('owner-settings').hidden=true;
  byId('workspace').hidden=true;
  byId('login').hidden=false;
  notice('ออกจากระบบแล้ว');
  byId('credentials').elements.username.focus();
};

