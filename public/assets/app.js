const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const state = { user:null, selectedItem:null, selectedStock:null, selectedSerials:[], serialInfo:null, invoiceNumber:null, saleLines:[], stocks:null, mappings:null, selectedMapping:null };
const ROLE_PAGES = {
  admin: 'all',
  seller: ['dashboard','sale','proforma','proforma-list','stocks','cardex','turnover','customers','leads','reservations'],
  accounting: ['dashboard','sale','proforma','proforma-list','stocks','cardex','inv-sale','inv-buy','turnover','customers','leads','lead-audit','supplier-aging','seller-profit','reports'],
  warehouse: ['dashboard','sale','proforma','proforma-list','stocks','cardex','inv-sale','inv-buy','turnover','customers','leads','lead-audit','reports'],
  purchase: ['dashboard','sale','proforma','proforma-list','stocks','cardex','inv-sale','inv-buy','turnover','customers','leads','lead-audit','supplier-aging','seller-profit','reports'],
  seller_buyer: ['dashboard','sale','proforma','proforma-list','buy','stocks','cardex','turnover','customers','leads','reservations']
};
function userRole(){return (state.user&&state.user.role)||'guest'}
function canPage(page){const r=userRole(); if(r==='admin') return true; return (ROLE_PAGES[r]||[]).includes(page)}
function firstAllowedPage(){const r=userRole(); if(r==='admin') return 'dashboard'; return (ROLE_PAGES[r]||['dashboard'])[0] || 'dashboard'}
const ROLE_LABELS={admin:'مدیر سیستم',seller:'فروشنده',accounting:'حسابداری',warehouse:'انبار',purchase:'بازرگانی',seller_buyer:'فروشنده-خریدار'};
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function fmt(n){return Number(n||0).toLocaleString('fa-IR')}

function div(a,b){return ~~(a/b)}
function gregorianToJalali(gy,gm,gd){var g_d_m=[0,31,59,90,120,151,181,212,243,273,304,334];var jy=(gy<=1600)?0:979;gy-=(gy<=1600)?621:1600;var gy2=(gm>2)?(gy+1):gy;var days=(365*gy)+div(gy2+3,4)-div(gy2+99,100)+div(gy2+399,400)-80+gd+g_d_m[gm-1];jy+=33*div(days,12053);days%=12053;jy+=4*div(days,1461);days%=1461;if(days>365){jy+=div(days-1,365);days=(days-1)%365;}var jm=(days<186)?1+div(days,31):7+div(days-186,30);var jd=1+((days<186)?(days%31):((days-186)%30));return [jy,jm,jd]}
function toJalali8(d){if(!d)return '';let dt;if(/^\d{4}-\d{2}-\d{2}/.test(String(d))){const [y,m,da]=String(d).slice(0,10).split('-').map(Number);dt=new Date(y,m-1,da)}else if(/^\d{8}$/.test(String(d))&&String(d).startsWith('20')){const y=Number(String(d).slice(0,4)),m=Number(String(d).slice(4,6)),da=Number(String(d).slice(6,8));dt=new Date(y,m-1,da)}else if(/^\d{8}$/.test(String(d))&&String(d).startsWith('13')||/^\d{8}$/.test(String(d))&&String(d).startsWith('14')){return String(d)}else{dt=new Date(d)}if(isNaN(dt))return String(d||'');const [jy,jm,jd]=gregorianToJalali(dt.getFullYear(),dt.getMonth()+1,dt.getDate());return String(jy)+String(jm).padStart(2,'0')+String(jd).padStart(2,'0')}
function toJalaliDisplay(d){const x=toJalali8(d);return /^\d{8}$/.test(x)?`${x.slice(0,4)}/${x.slice(4,6)}/${x.slice(6,8)}`:x}
function todayJalali8(){return toJalali8(new Date())}
function cleanDate8(v){return String(v||'').replace(/[^0-9]/g,'').slice(0,8)}

async function api(url, opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opts});const j=await r.json().catch(()=>({ok:false,error:'bad json'}));if(!r.ok) throw new Error(j.error||r.statusText);return j}
function post(url, body){return api(url,{method:'POST',body:JSON.stringify(body||{})})}
const uiPageLifecycle=(()=>{
  let cleanups=[];
  function add(cleanup){if(typeof cleanup==='function')cleanups.push(cleanup);return cleanup}
  function cleanup(){const pending=cleanups;cleanups=[];pending.reverse().forEach(fn=>{try{fn()}catch{}})}
  return {add,cleanup};
})();

/* Admin backup + deterministic turnover/document/Kardex workflows. */
(function(){
  const invoiceTypes=window.MKCRMInvoiceTypes;
  const docTypeLabel=t=>invoiceTypes.getInvoiceTypeLabel(t);
  const invoiceNoOf=x=>String(x.InvNo??x.InvoiceNumber??x.DocumentNumber??'').trim();
  const invoiceTypeOf=x=>invoiceTypes.normalizeInvTyp(x.InvTyp??x.InvoiceType);
  function invoiceBody(inv){return Array.isArray(inv.Body)?inv.Body:(Array.isArray(inv.InvoiceBody)?inv.InvoiceBody:[])}
  function accountGuid(a){return a?.guId||a?.accountGuid||a?.AccountGuId||a?.raw?.GuId||''}
  function accountLabel(a){return `${a.accountNumber||''} - ${a.accountName||''}${a.moinNumber?' | معین '+a.moinNumber:''}`}

  window.openTypedTurnoverDocument=async function(identity,trigger=document.activeElement){
    const invNo=String(identity?.invNo||'').trim();let invType=invoiceTypes.normalizeInvTyp(identity?.invType);const isCurrent=typeof identity?.isCurrent==='function'?identity.isCurrent:()=>true;
    let modal=$('#turnoverDocumentModal');if(!modal){modal=document.createElement('div');modal.id='turnoverDocumentModal';modal.className='mk-modal';document.body.appendChild(modal);}
    modal.innerHTML=`<div class="mk-modal-backdrop"></div><div class="mk-modal-card"><div class="mk-modal-head"><h3 id="turnoverDocumentTitle">سند شماره ${esc(invNo)}</h3><button class="mini" id="closeTurnoverDocument">بستن</button></div><div id="turnoverDocumentBody"><div class="info">${invType?'در حال خواندن سند...':'در حال شناسایی و خواندن سند...'}</div></div></div>`;
    modal.style.display='block';uiModalController.open(modal,trigger);$('#closeTurnoverDocument').onclick=()=>uiModalController.close();modal.querySelector('.mk-modal-backdrop').onclick=()=>uiModalController.close();
    if(!/^\d+$/.test(invNo)){$('#turnoverDocumentBody').innerHTML='<div class="error">شماره سند معتبر نیست.</div>';return;}
    try{
      if(!invoiceTypes.isSupportedInvoiceType(invType)){
        const resolved=await api(`/api/invoices/${encodeURIComponent(invNo)}/resolve`);if(!isCurrent()){uiModalController.close({restoreFocus:false});return;}
        const candidates=resolved.candidates||[];
        if(!candidates.length){$('#turnoverDocumentBody').innerHTML=`<div class="warn">سند شماره ${esc(invNo)} در انواع اسناد پشتیبانی‌شده پیدا نشد.</div>`;return;}
        if(candidates.length>1){$('#turnoverDocumentBody').innerHTML=`<div class="warn">این شماره در چند نوع سند وجود دارد؛ نوع صحیح را انتخاب کنید.</div>${candidates.map((x,i)=>`<button class="btn resolve-invoice-choice" data-i="${i}">${esc(x.label)} شماره ${esc(x.invNo)}${x.invDate?' — '+esc(toJalaliDisplay(x.invDate)):''}${x.accountName?' — '+esc(x.accountName):''}</button>`).join('')}`;modal.querySelectorAll('.resolve-invoice-choice').forEach(b=>b.onclick=()=>openTypedTurnoverDocument({...identity,invType:candidates[Number(b.dataset.i)].invType},b));return;}
        invType=candidates[0].invType;
      }
      if(!isCurrent()){uiModalController.close({restoreFocus:false});return;}
      $('#turnoverDocumentTitle').textContent=`${docTypeLabel(invType)} شماره ${invNo}`;
      const r=await api(`/api/invoices/${encodeURIComponent(invNo)}?invType=${invType}`);if(!isCurrent()){uiModalController.close({restoreFocus:false});return;}const inv=(r.list||[]).find(x=>invoiceNoOf(x)===invNo&&invoiceTypeOf(x)===invType);if(!inv){$('#turnoverDocumentBody').innerHTML=`<div class="warn">${esc(docTypeLabel(invType))} شماره ${esc(invNo)} پیدا نشد.</div>`;return;}const lines=invoiceBody(inv),canKardex=[2,6].includes(invType),transferMeta=invoiceTypes.isWarehouseTransferType(invType)?` | انبار مبدأ: ${esc(inv.SourceStockName||inv.FromStockName||inv.StockName||'—')} | انبار مقصد: ${esc(inv.DestinationStockName||inv.ToStockName||inv.SecondStockName||'—')}`:'';$('#turnoverDocumentBody').innerHTML=`<div class="info">تاریخ: ${esc(toJalaliDisplay(inv.InvDate||''))} | حساب: ${esc(inv.AccountName||'')} | InvTyp=${invType}${transferMeta}</div><div class="table-scroll"><table class="table"><thead><tr><th>کد کالا</th><th>نام</th><th>تعداد</th><th>قیمت</th>${canKardex?'<th>کاردکس</th>':''}</tr></thead><tbody>${lines.map(x=>{const code=x.ItemNumber||x.ItemCode||'';return `<tr><td>${esc(code)}</td><td>${esc(x.ItemDescription||x.ItemDesc||'')}</td><td>${fmt(x.Quan||x.Quantity||0)}</td><td>${fmt(x.Price||0)}</td>${canKardex?`<td><button class="mini invoice-item-kardex" data-code="${esc(code)}">مشاهده کاردکس</button></td>`:''}</tr>`}).join('')}</tbody></table></div><div id="invoiceKardexPanel"></div>`;modal.querySelectorAll('.invoice-item-kardex').forEach(b=>b.onclick=async()=>{const panel=$('#invoiceKardexPanel'),code=b.dataset.code;panel.innerHTML='<div class="info">در حال خواندن کاردکس...</div>';try{const kr=await api(`/api/invoices/${encodeURIComponent(invNo)}/items/${encodeURIComponent(code)}/kardex?invType=${invType}`);if(!kr.ok){panel.innerHTML=`<div class="error">${esc(kr.error||'خطا')}</div>`;return;}panel.innerHTML=`<h4>کاردکس ${esc(code)}</h4>${(kr.rows||[]).length?`<table class="table"><thead><tr><th>تاریخ</th><th>نوع</th><th>سند</th><th>ورود</th><th>خروج</th><th>مانده</th><th>خرید/تمام‌شده</th><th>فروش</th></tr></thead><tbody>${kr.rows.map(x=>`<tr><td>${esc(toJalaliDisplay(x.date||''))}</td><td>${esc(docTypeLabel(x.invoiceType))}</td><td>${esc(x.invoiceNumber||'')}</td><td>${fmt(x.inQty)}</td><td>${fmt(x.outQty)}</td><td>${fmt(x.remainQty)}</td><td>${fmt(x.costPrice)}</td><td>${fmt(x.salePrice)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">ردیفی برای این کالا وجود ندارد.</div>'}`;}catch(e){panel.innerHTML=`<div class="error">${esc(e.message||e)}</div>`;}});}
    catch(e){$('#turnoverDocumentBody').innerHTML=`<div class="error">${esc(e.message||e)}</div>`;}
  };

  window.pageTurnover=async function(){
    setPage('گردش حساب',`<main class="main-content"><div class="card"><div class="card-header"><h5>گردش حساب</h5></div><div class="card-body"><div id="turnoverAccessMsg" class="small muted"></div><div class="row four"><div id="turnoverSelectWrap" class="form-group"><label>حساب‌های مجاز</label><div id="allowedAccountsBox" class="access-list"></div></div><div id="turnoverSearchWrap" class="form-group account-picker"><label>جستجوی حساب</label><input id="turnoverAccountSearch" placeholder="نام یا کد حساب" autocomplete="off"><div id="turnoverAccountResults" class="floating-list account-list popup-hidden"></div><input id="turnoverPicked" class="readonly mt6" readonly placeholder="حساب انتخاب‌شده"></div><div class="form-group"><label>از تاریخ شمسی</label><input id="turnoverFrom"></div><div class="form-group"><label>تا تاریخ شمسی</label><input id="turnoverTo"></div></div><button class="btn" id="loadTurnoverBtn">نمایش گردش</button><div id="turnoverOut" class="mt"></div></div></div></main>`);
    const access=await api('/api/account-access/my'),input=$('#turnoverAccountSearch'),box=$('#turnoverAccountResults'),allowed=$('#allowedAccountsBox');let selected=null,suggestions=[],searchSeq=0,turnoverSeq=0,documentGeneration=0,searchAbort=null,turnoverAbort=null;
    const closeSearch=()=>popupSuggestionController.close({restoreFocus:false});
    function invalidateSearch(){searchSeq++;searchAbort?.abort();searchAbort=null;}
    function selectAccount(a,source='search'){search.cancel();invalidateSearch();documentGeneration++;selected={accountNumber:String(a.accountNumber||''),accountName:a.accountName||'',moinNumber:a.moinNumber||'',accountGuid:accountGuid(a),source};input.value=accountLabel(selected);$('#turnoverPicked').value=accountLabel(selected);closeSearch();box.innerHTML='';}
    function renderSuggestions(list,seq){if(seq!==searchSeq)return;suggestions=list||[];box.innerHTML=suggestions.length?suggestions.map((a,i)=>`<div class="account-result" data-i="${i}"><b>${esc(a.accountName||'')}</b><span>${esc(a.accountNumber||'')}</span></div>`).join(''):'<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>';popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-result',onSelect:el=>selectAccount(suggestions[Number(el.dataset.i)]),onEscape:()=>{search.cancel();invalidateSearch();},restoreFocus:true});box.querySelectorAll('.account-result').forEach(el=>el.onclick=()=>selectAccount(suggestions[Number(el.dataset.i)]));}
    const search=debounce(async()=>{const q=input.value.trim(),seq=++searchSeq;selected=null;$('#turnoverPicked').value='';turnoverAbort?.abort();if(q.length<2){invalidateSearch();box.innerHTML='';closeSearch();return;}searchAbort?.abort();searchAbort=new AbortController();box.innerHTML='<div class="floating-empty">در حال جستجو...</div>';popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-result',onEscape:invalidateSearch});try{const r=await api(`/api/accounts/search?q=${encodeURIComponent(q)}&limit=120&pages=220&strict=1`,{signal:searchAbort.signal});renderSuggestions(r.list||[],seq);}catch(e){if(e.name!=='AbortError'&&seq===searchSeq){box.innerHTML=`<div class="floating-empty error">${esc(e.message||e)}</div>`;}}},300);
    if(access.fullAccess){$('#turnoverSelectWrap').style.display='none';input.addEventListener('input',()=>{documentGeneration++;search();});input.addEventListener('focus',()=>{if(suggestions.length&&!selected)renderSuggestions(suggestions,searchSeq);});}else{$('#turnoverSearchWrap').style.display='none';const list=access.list||[];allowed.innerHTML=list.map((a,i)=>`<button class="account-chip allowed-account" data-i="${i}">${esc(accountLabel(a))}</button>`).join('')||'<div class="warn">حساب مجاز تعریف نشده است.</div>';allowed.querySelectorAll('.allowed-account').forEach(b=>b.onclick=()=>selectAccount(list[Number(b.dataset.i)],'allowed'));if(list.length===1)selectAccount(list[0],'allowed-auto');}
    $('#loadTurnoverBtn').onclick=async()=>{if(!selected)return $('#turnoverOut').innerHTML='<div class="error">حساب را از لیست انتخاب کن.</div>';const identity={...selected},seq=++turnoverSeq,generation=++documentGeneration;turnoverAbort?.abort();turnoverAbort=new AbortController();const out=$('#turnoverOut');out.innerHTML='<div class="info">در حال دریافت گردش حساب...</div>';try{const tr=await api('/admin/accounting/getTurnover',{method:'POST',body:JSON.stringify({accountNumber:identity.accountNumber,accountName:identity.accountName,accountGuid:identity.accountGuid,dateFrom:cleanDate8($('#turnoverFrom').value),dateTo:cleanDate8($('#turnoverTo').value)}),signal:turnoverAbort.signal});if(seq!==turnoverSeq)return;const rows=tr.list||tr.result||[];if(!tr.ok){out.innerHTML=`<div class="error">${esc(tr.error||'خطا')}</div>`;return;}if(!rows.length){out.innerHTML='<div class="warn">نتیجه‌ای پیدا نشد.</div>';return;}out.innerHTML=`<div class="success">${rows.length} ردیف گردش برای ${esc(identity.accountName)}</div><table class="table"><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>سند</th></tr></thead><tbody>${rows.map(x=>{const no=invoiceNoOf(x),typ=invoiceTypeOf(x);return `<tr><td>${esc(toJalaliDisplay(x.Date||x.InvDate||''))}</td><td>${esc(x.RowDesc||x.Description||'')}</td><td>${fmt(x.DebitAmount||0)}</td><td>${fmt(x.CreditAmount||0)}</td><td>${fmt(x.RemainAccount||x.Remain||0)}</td><td>${no?`<button class="linklike turnover-document" data-no="${esc(no)}" data-type="${typ||''}">${typ?`${esc(docTypeLabel(typ))} `:''}${esc(no)}</button>`:`<span>${esc(x.DocumentNumber||'')}</span>`}</td></tr>`}).join('')}</tbody></table>`;out.querySelectorAll('.turnover-document').forEach(b=>b.onclick=async()=>{if(b.dataset.resolving==='1')return;b.dataset.resolving='1';b.disabled=true;const old=b.textContent;b.textContent='در حال شناسایی و خواندن سند...';try{await openTypedTurnoverDocument({invNo:b.dataset.no,invType:b.dataset.type,isCurrent:()=>generation===documentGeneration},b);}finally{if(b.isConnected){b.dataset.resolving='';b.disabled=false;b.textContent=old;}}});}catch(e){if(e.name!=='AbortError'&&seq===turnoverSeq)out.innerHTML=`<div class="error">${esc(e.message||e)}</div>`;}};
    uiPageLifecycle.add(()=>{search.cancel();invalidateSearch();turnoverSeq++;documentGeneration++;turnoverAbort?.abort();});
  };

  window.__stablePageTurnover=window.pageTurnover;
  window.pageBackupManagement=async function(){setPage('مدیریت پشتیبان‌گیری',`<main class="main-content"><div class="card"><div class="card-header"><h5>مدیریت پشتیبان‌گیری</h5></div><div class="card-body"><div id="backupConfig"></div><div class="row two"><div class="form-group"><label>محل مجاز</label><select id="backupDestination"></select></div><div class="form-group"><label>زیرپوشه اختیاری</label><input id="backupSubfolder" placeholder="مثلاً daily"></div></div><button class="btn red" id="startBackup">شروع پشتیبان‌گیری</button><button class="btn" id="refreshBackups">بروزرسانی</button><div id="backupMessage"></div><div id="backupHistory"></div></div></div></main>`);async function load(){const r=await api('/api/admin/backups/status');$('#backupConfig').innerHTML=r.configured?`<div class="info">Database: ${esc(r.database)} | فقط مقصدهای تنظیم‌شده سرور قابل انتخاب‌اند.</div>`:'<div class="error">MONGO_BACKUP_ALLOWED_ROOTS تنظیم نشده است.</div>';$('#backupDestination').innerHTML=(r.destinations||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');const rows=r.history||[];$('#backupHistory').innerHTML=rows.length?`<table class="table"><thead><tr><th>Database</th><th>مقصد</th><th>پوشه</th><th>شروع</th><th>مدت</th><th>وضعیت</th><th>اندازه</th><th>خطا</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.database)}</td><td>${esc(x.destination)}</td><td>${esc(x.folder)}</td><td>${esc(toJalaliDisplay(x.startedAt))}</td><td>${fmt(x.durationMs||0)} ms</td><td>${esc(x.status)}</td><td>${fmt(x.sizeBytes||0)}</td><td>${esc(x.error||'')}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">سابقه‌ای وجود ندارد.</div>';$('#startBackup').disabled=!r.configured||!!r.running;}$('#startBackup').onclick=async()=>{try{const r=await post('/api/admin/backups/start',{destinationId:$('#backupDestination').value,subfolder:$('#backupSubfolder').value});$('#backupMessage').innerHTML=`<div class="info">Job ثبت شد: ${esc(r.jobId)}</div>`;await load();}catch(e){$('#backupMessage').innerHTML=`<div class="error">${esc(e.message||e)}</div>`;}};$('#refreshBackups').onclick=load;await load();};
})();
const uiModalController=(()=>{
  let active=null;
  function close(opts={}){
    if(!active)return;
    const current=active;active=null;
    current.modal.style.display='none';
    current.modal.classList.remove('modal-open');
    current.modal.setAttribute('aria-hidden','true');
    document.body.classList.remove('modal-scroll-lock');
    const trigger=current.trigger;
    if(opts.restoreFocus!==false&&trigger&&trigger.isConnected&&!trigger.disabled&&typeof trigger.focus==='function'&&trigger.getClientRects().length)trigger.focus({preventScroll:true});
  }
  function open(modal,trigger=document.activeElement){
    if(!modal||!modal.isConnected)return;
    if(active&&active.modal!==modal)close({restoreFocus:false});
    active={modal,trigger};
    modal.classList.add('modal-open');modal.setAttribute('aria-hidden','false');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    document.body.classList.add('modal-scroll-lock');
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&active){e.preventDefault();e.stopPropagation();close();}},true);
  return {open,close,isOpen:modal=>!!active&&active.modal===modal};
})();
if(!window.__mkcrmSensitiveClickGuard){
  window.__mkcrmSensitiveClickGuard=true;
  document.addEventListener('click',e=>{
    const button=e.target.closest&&e.target.closest('#issueBtn,#convertPfBtn,[data-issue],#buySave,#pfSave,#announcePurchaseToBoard,#psReadSelected,#psBuildSelected,#saleSnapStart');
    if(!button)return;
    if(button.dataset.uiClickLocked==='1'){e.preventDefault();e.stopImmediatePropagation();return;}
    button.dataset.uiClickLocked='1';button.setAttribute('aria-busy','true');button.disabled=true;
    const unlock=setTimeout(()=>{if(button.isConnected&&!button.dataset.keepDisabled){button.disabled=false;button.removeAttribute('aria-busy');delete button.dataset.uiClickLocked;}},3000);
    uiPageLifecycle.add(()=>clearTimeout(unlock));
  },true);
}
function setPage(title, html){popupSuggestionController.close({restoreFocus:false});uiModalController.close({restoreFocus:false});uiPageLifecycle.cleanup();$('#pageTitle').textContent=title;$('#content').innerHTML=html;$$('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.page===location.hash.slice(1)))}
function loginScreen(){document.body.classList.add('login-mode');$('#app').innerHTML=`<div class="login-box"><h2>ورود به MKCRM</h2><p class="muted">نسخه داخلی مشهد کالا - اتصال جدید شایگان</p><label>نام کاربری</label><input id="loginUser" autocomplete="off" autocapitalize="off" spellcheck="false"><label>رمز عبور</label><input id="loginPass" type="password" autocomplete="new-password"><button class="btn red wide" id="loginBtn">ورود</button><div id="loginMsg"></div></div>`;$('#loginBtn').onclick=async()=>{const r=await post('/api/auth/login',{username:$('#loginUser').value,password:$('#loginPass').value});if(r.ok){localStorage.mkcrmUser=JSON.stringify(r.user);location.reload()}else $('#loginMsg').innerHTML=`<div class="error">${esc(r.error||'ورود ناموفق')}</div>`}}
function shell(){document.body.classList.remove('login-mode');$('#app').innerHTML=`<aside class="sidebar"><div class="brand brand-with-logo"><img class="brand-logo-img" src="/assets/mashhadkala-logo-wide.png" alt="مشهد کالا"><span class="brand-system">MKCRM</span></div><div class="sub">مشهد کالا - نسخه داخلی</div><div class="user-chip">${esc(state.user?.fullName||state.user?.username||'')}</div><nav id="menu"></nav></aside><main class="main"><header class="topbar"><div><b id="pageTitle">داشبورد</b><span id="pageHint"></span></div><div class="top-actions"><div class="status"><span id="healthText">checking...</span></div><button class="btn logout" id="logoutBtn">خروج</button></div></header><section id="content"></section></main>`;renderMenu();$('#logoutBtn').onclick=async()=>{try{await post('/api/auth/logout',{})}catch{} localStorage.removeItem('mkcrmUser');location.href='/login'};health();route()}
const menu = [['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا-تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها']]]];
function renderMenu(){let h='';const role=userRole();menu.forEach(([g,items])=>{const allowedItems=items.filter(([id])=>canPage(id));if(!allowedItems.length)return;h+=`<div class="menu-group">${g}</div>`;allowedItems.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`)});$('#menu').innerHTML=h;$$('.navbtn').forEach(b=>b.onclick=()=>{location.hash=b.dataset.page;route()});const chip=document.querySelector('.user-chip');if(chip)chip.innerHTML=`${esc(state.user?.fullName||state.user?.username||'')}<br><small>${esc(ROLE_LABELS[role]||role)}</small>`}
async function health(){try{const h=await api('/health');$('#healthText').textContent=`online | ${h.node}`;$('.status').classList.add('ok')}catch(e){$('#healthText').textContent=e.message;$('.status').classList.add('bad')}}
function debounce(fn, ms=350){let t;const wrapped=(...a)=>{clearTimeout(t);t=setTimeout(()=>{t=null;fn(...a)},ms)};wrapped.cancel=()=>{clearTimeout(t);t=null};uiPageLifecycle.add(wrapped.cancel);return wrapped}
const popupSuggestionController=(()=>{
  let active=null;
  function options(){return active?[...active.popup.querySelectorAll(active.optionSelector)].filter(el=>!el.hidden&&!el.disabled):[]}
  function mark(index){
    if(!active)return;
    const list=options();
    active.index=list.length?((index%list.length)+list.length)%list.length:-1;
    list.forEach((el,i)=>{const on=i===active.index;el.classList.toggle('popup-option-active',on);el.setAttribute('aria-selected',on?'true':'false');});
    if(active.index>=0)list[active.index].scrollIntoView({block:'nearest'});
  }
  function close(opts={}){
    if(!active)return;
    const current=active;active=null;
    document.removeEventListener('pointerdown',current.onOutside,true);
    document.removeEventListener('keydown',current.onKey,true);
    current.popup.classList.remove('popup-open');
    current.popup.classList.add('popup-hidden');
    current.popup.setAttribute('aria-hidden','true');
    current.trigger.setAttribute('aria-expanded','false');
    [...current.popup.querySelectorAll(current.optionSelector)].forEach(el=>{el.classList.remove('popup-option-active');el.removeAttribute('aria-selected')});
    const canRestoreFocus=current.trigger.isConnected&&!current.trigger.disabled&&typeof current.trigger.focus==='function'&&current.trigger.getClientRects().length>0;
    if(opts.restoreFocus!==false&&current.restoreFocus&&canRestoreFocus)current.trigger.focus({preventScroll:true});
  }
  function open({popup,trigger,optionSelector,onSelect,onEscape,restoreFocus=true}){
    if(!popup||!trigger||!popup.isConnected||!trigger.isConnected)return;
    if(active&&active.popup!==popup)close({restoreFocus:false});
    else if(active)close({restoreFocus:false});
    const current={popup,trigger,optionSelector,onSelect,onEscape,restoreFocus,index:-1};
    current.onOutside=e=>{if(!popup.contains(e.target)&&e.target!==trigger)close()};
    current.onKey=e=>{
      if(!active||active!==current)return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(current.onEscape)current.onEscape();close();return;}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        e.preventDefault();e.stopPropagation();
        const list=options(),direction=e.key==='ArrowDown'?1:-1;
        mark(current.index<0?(direction>0?0:list.length-1):current.index+direction);return;
      }
      if(e.key==='Enter'){
        const list=options();if(!list.length){e.preventDefault();e.stopPropagation();return;}
        e.preventDefault();e.stopPropagation();
        const el=list[current.index>=0?current.index:0];
        if(onSelect)onSelect(el);else el.click();
      }
    };
    active=current;
    popup.classList.remove('popup-hidden');popup.classList.add('popup-open');popup.setAttribute('aria-hidden','false');
    trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','true');popup.setAttribute('role','listbox');
    options().forEach(el=>el.setAttribute('role','option'));
    document.addEventListener('pointerdown',current.onOutside,true);
    document.addEventListener('keydown',current.onKey,true);
  }
  function isOpen(popup){return !!active&&active.popup===popup}
  return {open,close,isOpen};
})();
async function loadStocks(){if(state.stocks) return state.stocks;const r=await api('/api/stocks');state.stocks=(r.list||[]).sort((a,b)=>String(a.stockNumber).localeCompare(String(b.stockNumber),'fa'));return state.stocks}
async function fillStockFilter(prefix){const sel=$(`#${prefix}StockFilter`);if(!sel)return;const stocks=await loadStocks();sel.innerHTML='<option value="">همه انبارها</option>'+stocks.map(s=>`<option value="${esc(s.stockNumber)}">${esc(s.stockNumber)} - ${esc(s.stockName)}</option>`).join('')}
function getStockFilter(prefix){return $(`#${prefix}StockFilter`)?.value||''}
function stockFilterWidget(prefix){return `<div class="form-group stock-filter"><label>فیلتر انبار</label><select id="${prefix}StockFilter"><option value="">همه انبارها</option></select></div>`}
function itemSearchWidget(prefix, onPick, opts={}){return `<div class="legacy-search"><label>${opts.label||'قسمتی از نام کالا را وارد نمایید ...'}</label><input id="${prefix}Q" placeholder="مثلا nb msi یا katana؛ Enter = نمایش همه موجودی‌های منطبق" autocomplete="off"><div id="${prefix}Msg" class="small muted"></div><div id="${prefix}List" class="floating-list"></div><input id="${prefix}Selected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div>`}
function stockNoOf(r){return String(r.STNumber||r.stockNumber||'')}
function applyStockFilterRows(rows, stockNumber){if(!stockNumber)return rows||[];return (rows||[]).filter(r=>stockNoOf(r)===String(stockNumber))}
function groupStockRows(rows){const m=new Map();(rows||[]).forEach(r=>{const code=r.ItemCode||r.itemCode||'';const guid=r.ItemGuId||r.itemGuid||r.ItemGuid||'';if(!code)return;const key=(guid||'no-guid')+'|'+code;if(!m.has(key))m.set(key,{itemCode:code,itemDescription:r.ItemDesc||r.itemDescription||'',itemGuid:guid,rows:[],total:0});const g=m.get(key);g.rows.push(r);g.total+=Number(r.RemainQ||r.quantity||0)});return [...m.values()].sort((a,b)=>b.total-a.total||String(a.itemDescription).localeCompare(String(b.itemDescription),'fa'))}
async function searchStockRows(q,limit=1000,stockNumber='',requestOpts={}){return await api(`/api/legacy/stock/search?q=${encodeURIComponent(q)}&limit=${limit}${stockNumber?`&stockNumber=${encodeURIComponent(stockNumber)}`:''}`,requestOpts)}
async function searchAllItemsRows(q,limit=200,forceLive=false,requestOpts={}){return await api(`/api/items/search-all?q=${encodeURIComponent(q)}&limit=${limit}&pages=${forceLive?300:25}${forceLive?'&forceLive=1':''}`,requestOpts)}
async function searchInventoryRowsFull(q,stockNumber='',mainGroupCode=''){return await api(`/api/inventory/search?q=${encodeURIComponent(q||'')}&limit=0&pages=300${stockNumber?`&stockNumber=${encodeURIComponent(stockNumber)}`:''}${mainGroupCode?`&mainGroupCode=${encodeURIComponent(mainGroupCode)}`:''}`)}
async function loadStockInventory(stockNumber,mainGroupCode='',q=''){return await api(`/api/inventory/by-stock?stockNumber=${encodeURIComponent(stockNumber)}&limit=0&pages=300${mainGroupCode?`&mainGroupCode=${encodeURIComponent(mainGroupCode)}`:''}${q?`&q=${encodeURIComponent(q)}`:''}`)}
function renderStockGroupHtml(g, opts={}){const rows=(g.rows||[]).slice().sort((a,b)=>Number(b.RemainQ||b.quantity||0)-Number(a.RemainQ||a.quantity||0));const stockHtml=rows.map(r=>{const row=JSON.stringify(r).replace(/'/g,'&#39;');return `<div class="stock-line"><span class="stock-name">${esc(r.STNumber||r.stockNumber||'')} - ${esc(r.StDesc||r.stockName||'')}</span><span class="stock-qty">موجودی: ${fmt(r.RemainQ||r.quantity||0)}</span><span class="stock-price">قیمت پایه: ${fmt(r.Price||r.averageCost||0)}</span>${opts.selectStock?`<button class="mini choose-stock-row" data-row='${esc(row)}'>انتخاب این انبار</button>`:''}</div>`}).join('');return `<div class="floating-item stock-group" data-code="${esc(g.itemCode)}" data-desc="${esc(g.itemDescription)}" data-guid="${esc(g.itemGuid)}"><div class="item-title">${esc(g.itemDescription)}</div><div class="item-meta"><span class="pill">${esc(g.itemCode)}</span><span class="pill stock">جمع موجودی: ${fmt(g.total)}</span><span class="pill">${rows.length} انبار</span></div><div class="stock-lines">${stockHtml}</div></div>`}
function rawToItemStock(raw){const item={itemCode:raw.ItemCode||raw.itemCode,itemDescription:raw.ItemDesc||raw.itemDescription,itemGuid:raw.ItemGuId||raw.itemGuid};const stock={itemCode:item.itemCode,itemDescription:item.itemDescription,itemGuid:item.itemGuid,stockNumber:raw.STNumber||raw.stockNumber,stockName:raw.StDesc||raw.stockName,stockGuid:raw.STGuId||raw.stockGuid,quantity:Number(raw.RemainQ||raw.quantity||0),averageCost:Number(raw.Price||raw.averageCost||0)};return {item,stock}}
function bindItemSearch(prefix, onPick, opts={}){const q=$(`#${prefix}Q`), box=$(`#${prefix}List`), msg=$(`#${prefix}Msg`);let lastGroups=[];async function runSearch(showBox=true){const val=q.value.trim();if(val.length<2){box.innerHTML='';box.style.display='none';msg.textContent='';return []}msg.textContent='در حال جستجوی موجودی منطبق...';try{const r=await searchStockRows(val, opts.limit||200);let rows=applyStockFilterRows(r.list||[], opts.getStockFilter ? opts.getStockFilter() : '');const groups=groupStockRows(rows);lastGroups=groups;msg.textContent=`${groups.length} کالا | ${rows.length} ردیف انبار | ${r.source||''}${r.scannedPages?' | '+r.scannedPages+' صفحه':''}`;if(showBox){box.style.display='block';box.innerHTML=groups.map(g=>renderStockGroupHtml(g,opts)).join('') || '<div class="floating-empty">نتیجه‌ای پیدا نشد. فیلتر انبار یا متن جستجو را بررسی کنید.</div>';box.querySelectorAll('.stock-group').forEach(el=>el.onclick=(ev)=>{if(ev.target.classList.contains('choose-stock-row'))return;const item={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription}`;box.style.display='none';onPick(item, groups.find(g=>g.itemCode===item.itemCode))});box.querySelectorAll('.choose-stock-row').forEach(btn=>btn.onclick=(ev)=>{ev.stopPropagation();const raw=JSON.parse(btn.dataset.row);const {item,stock}=rawToItemStock(raw);$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription} | ${stock.stockNumber} - ${stock.stockName}`;box.style.display='none';if(opts.onStockPick) opts.onStockPick(item,stock); else onPick(item,{rows:[raw],total:stock.quantity})})}return groups}catch(e){msg.textContent='خطا در جستجو';box.style.display='block';box.innerHTML=`<div class="floating-empty">${esc(e.message)}</div>`;return []}}
const deb=debounce(()=>runSearch(true),350);q.addEventListener('input',deb);q.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();const groups=lastGroups.length?lastGroups:await runSearch(false);box.style.display='none';if(opts.onEnter) opts.onEnter(q.value.trim(),groups);else if(groups.length===1){const g=groups[0];onPick({itemCode:g.itemCode,itemDescription:g.itemDescription,itemGuid:g.itemGuid},g)}}});document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==q)box.style.display='none'});if(opts.filterElement){opts.filterElement.addEventListener('change',()=>{lastGroups=[];if(q.value.trim().length>=2)runSearch(true)})}}

function bindProductSearch(prefix, onPick, opts={}){const q=$(`#${prefix}Q`), box=$(`#${prefix}List`), msg=$(`#${prefix}Msg`);let lastItems=[];async function runSearch(showBox=true){const val=q.value.trim();if(val.length<2){box.innerHTML='';box.style.display='none';msg.textContent='';return []}msg.textContent='در حال جستجوی همه کالاها، بدون محدودیت موجودی...';try{const r=await searchAllItemsRows(val, opts.limit||200);lastItems=r.list||[];msg.textContent=`${lastItems.length} کالا | ${r.source||''}${r.cacheCount?' | کش: '+r.cacheCount:''}${r.scannedPages?' | '+r.scannedPages+' صفحه':''}${r.note?' | '+r.note:''}`;if(showBox){box.style.display='block';box.innerHTML=lastItems.map(x=>`<div class="product-row" data-code="${esc(x.ItemCode||x.itemCode)}" data-desc="${esc(x.ItemDesc||x.itemDescription)}" data-guid="${esc(x.ItemGuId||x.itemGuid||'')}"><b>${esc(x.ItemDesc||x.itemDescription)}</b><div class="small muted">کد: ${esc(x.ItemCode||x.itemCode)}</div></div>`).join('') || '<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>';box.querySelectorAll('.product-row').forEach(el=>el.onclick=()=>{const item={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription}`;box.style.display='none';onPick(item,lastItems)})}return lastItems}catch(e){msg.textContent='خطا در جستجوی کالا';box.style.display='block';box.innerHTML=`<div class="floating-empty">${esc(e.message)}</div>`;return []}}
const deb=debounce(()=>runSearch(true),350);q.addEventListener('input',deb);q.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();const items=lastItems.length?lastItems:await runSearch(false);box.style.display='none';if(opts.onEnter) opts.onEnter(q.value.trim(),items);else if(items.length===1){const x=items[0];onPick({itemCode:x.ItemCode||x.itemCode,itemDescription:x.ItemDesc||x.itemDescription,itemGuid:x.ItemGuId||x.itemGuid||''},items)}}});document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==q)box.style.display='none'})}

function renderInventoryRows(rows,target,selectable=false){let h='<table class="table"><thead><tr><th>کاردکس</th><th>نام کالا</th><th>کد کالا</th><th>انبار</th><th>موجودی</th><th>قیمت پایه</th><th>انتخاب</th></tr></thead><tbody>';h+=(rows||[]).map(x=>`<tr><td><button class="mini cardex-btn" data-code="${esc(x.itemCode||x.ItemCode)}">ⓘ</button></td><td>${esc(x.itemDescription||x.ItemDesc)}</td><td>${esc(x.itemCode||x.ItemCode)}</td><td>${esc(x.stockNumber||x.STNumber)} - ${esc(x.stockName||x.StDesc)}</td><td>${fmt(x.quantity||x.RemainQ)}</td><td>${fmt(x.averageCost||x.Price)}</td><td>${selectable?`<button class="btn green pick-stock-search" data-row='${esc(JSON.stringify(x))}'>انتخاب</button>`:''}</td></tr>`).join('');$(target).innerHTML=h+'</tbody></table>';$$('.cardex-btn').forEach(b=>b.onclick=()=>{location.hash='cardex';setTimeout(()=>{const input=$('#cardexQ');if(input){input.value=b.dataset.code;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))}},200)});if(selectable)$$('.pick-stock-search').forEach(b=>b.onclick=()=>{const raw=JSON.parse(b.dataset.row);const {item,stock}=rawToItemStock(raw);selectSaleStock(item,stock)})}
function renderGroupSelect(groups,prefix,target,rows,selectable){const box=$(`#${prefix}GroupBox`);if(!box)return;box.innerHTML='<label>فیلتر گروه اصلی</label><select id="'+prefix+'MainGroup"><option value="">همه گروه‌ها</option>'+(groups||[]).map(g=>`<option value="${esc(g.code)}">${esc(g.code)} - ${esc(g.name)} (${fmt(g.quantity)})</option>`).join('')+'</select>';const sel=$(`#${prefix}MainGroup`);sel.onchange=()=>{const code=sel.value;const filtered=code?(rows||[]).filter(r=>String((r.raw&& (r.raw.ItemMainGroupCode||r.raw.MainGroupCode))||String(r.itemCode||r.ItemCode||'').slice(0,2))===String(code)):rows;renderInventoryRows(filtered,target,selectable)}}
async function renderInventory(itemCode,target,selectable=false,stockNumber=''){$(target).innerHTML='در حال خواندن موجودی...';const r=await api(`/api/items/${encodeURIComponent(itemCode)}/inventory`);if(!r.ok)return $(target).innerHTML=`<div class="error">${esc(r.error)}</div>`;const rows=applyStockFilterRows(r.list||[],stockNumber);if(!rows.length)return $(target).innerHTML='<div class="warn">برای این کالا در انبار انتخاب‌شده موجودی پیدا نشد.</div>';renderInventoryRows(rows,target,selectable)}
async function renderInventorySearch(query,target,selectable=false,stockNumber=''){$(target).innerHTML='در حال خواندن همه موجودی‌های منطبق...';const r=await searchInventoryRowsFull(query,stockNumber);if(!r.ok)return $(target).innerHTML=`<div class="error">${esc(r.error)}</div>`;const rows=r.list||[];if(!rows.length)return $(target).innerHTML='<div class="warn">نتیجه‌ای برای این جستجو/انبار پیدا نشد.</div>';$(target).innerHTML=`<div class="small muted">${rows.length} ردیف انبار منطبق با «${esc(query)}» | ${r.scannedPages||0} صفحه بررسی شد</div><div id="stockGroupBox" class="form-group"></div><div id="stockRowsBox"></div>`;renderGroupSelect(r.groups||[],'stock','#stockRowsBox',rows,selectable);renderInventoryRows(rows,'#stockRowsBox',selectable)}
async function renderCardexMatches(query,items,target,stockNumber=''){if(!items||!items.length){items=(await searchAllItemsRows(query,300,false)).list||[]}const normalized=(items||[]).map(x=>({itemCode:x.ItemCode||x.itemCode,itemDescription:x.ItemDesc||x.itemDescription,itemGuid:x.ItemGuId||x.itemGuid||''})).filter(x=>x.itemCode);if(normalized.length===1)return renderKardex(normalized[0],target,stockNumber);let h=`<div class="small muted">${normalized.length} کالای منطبق بدون توجه به موجودی. برای نمایش کاردکس، یک کالا را انتخاب کنید.</div><table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>کاردکس</th></tr></thead><tbody>`;h+=normalized.map(g=>`<tr><td>${esc(g.itemCode)}</td><td>${esc(g.itemDescription)}</td><td><button class="btn show-kardex" data-code="${esc(g.itemCode)}" data-desc="${esc(g.itemDescription)}" data-guid="${esc(g.itemGuid)}">نمایش</button></td></tr>`).join('');$(target).innerHTML=h+'</tbody></table>';$$('.show-kardex').forEach(b=>b.onclick=()=>renderKardex({itemCode:b.dataset.code,itemDescription:b.dataset.desc,itemGuid:b.dataset.guid},target,stockNumber))}
async function renderKardex(item,target,stockNumber=''){$(target).innerHTML='در حال خواندن کاردکس...';const url=`/api/items/${encodeURIComponent(item.itemCode||item)}/kardex${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`;const r=await api(url);let h='<table class="table"><thead><tr><th>تاریخ</th><th>فاکتور</th><th>طرف حساب</th><th>ورود</th><th>خروج</th><th>مانده</th><th>قیمت خرید/تمام‌شده</th><th>قیمت فروش</th><th>سود</th></tr></thead><tbody>';h+=(r.rows||[]).map(x=>`<tr><td>${esc(x.date||'')}</td><td>${esc(x.invoiceNumber||'')}</td><td>${esc(x.accountName||'')}</td><td>${fmt(x.inQty)}</td><td>${fmt(x.outQty)}</td><td>${fmt(x.remainQty)}</td><td>${fmt(x.costPrice)}</td><td>${fmt(x.salePrice)}</td><td>${fmt(x.grossProfit)}</td></tr>`).join('');$(target).innerHTML=h+'</tbody></table>'}
function pageStocks(){setPage('موجودی انبارها',`<main class="main-content"><div class="card overflow-hidden"><div class="page-header"><h2>موجودی انبارها</h2><div class="row two">${itemSearchWidget('stock')}${stockFilterWidget('stock')}</div><div class="actions"><button class="btn" id="showStockAll">نمایش تمام موجودی انبار انتخابی</button></div></div><div class="card-body"><div id="stockResults"></div></div></div></main>`);fillStockFilter('stock');const filter=$('#stockStockFilter');bindItemSearch('stock',(item)=>renderInventory(item.itemCode,'#stockResults',false,getStockFilter('stock')),{showStocks:true,getStockFilter:()=>getStockFilter('stock'),filterElement:filter,onEnter:(q,groups)=>renderInventorySearch(q,'#stockResults',false,getStockFilter('stock'))});filter.onchange=()=>{const q=$('#stockQ')?.value?.trim();if(q)renderInventorySearch(q,'#stockResults',false,getStockFilter('stock'))};$('#showStockAll').onclick=async()=>{const sn=getStockFilter('stock');if(!sn)return alert('اول یک انبار را انتخاب کنید');$('#stockResults').innerHTML='در حال خواندن تمام موجودی انبار...';const r=await loadStockInventory(sn);if(!r.ok)return $('#stockResults').innerHTML=`<div class="error">${esc(r.error)}</div>`;const rows=r.list||[];$('#stockResults').innerHTML=`<div class="small muted">${rows.length} ردیف موجودی برای انبار ${esc(sn)} | ${r.scannedPages||0} صفحه بررسی شد</div><div id="stockGroupBox" class="form-group"></div><div id="stockRowsBox"></div>`;renderGroupSelect(r.groups||[],'stock','#stockRowsBox',rows,false);renderInventoryRows(rows,'#stockRowsBox',false)}}
function pageCardex(){setPage('کاردکس کالا',`<main class="main-content"><div class="card overflow-hidden"><div class="page-header"><h2>کاردکس کالا</h2><div class="row two">${itemSearchWidget('cardex')}${stockFilterWidget('cardex')}</div></div><div class="card-body"><div id="cardexResults"></div></div></div></main>`);fillStockFilter('cardex');const filter=$('#cardexStockFilter');bindProductSearch('cardex',(item)=>renderKardex(item,'#cardexResults',getStockFilter('cardex')),{limit:300,onEnter:(q,items)=>renderCardexMatches(q,items,'#cardexResults',getStockFilter('cardex'))});filter.onchange=()=>{const q=$('#cardexQ')?.value?.trim();if(q)renderCardexMatches(q,null,'#cardexResults',getStockFilter('cardex'))}}
function checkBelowCost(){if(!state.selectedStock)return;const p=Number($('#Price')?.value||0);const msg=$('#priceWarn');if(p && p<Number(state.selectedStock.averageCost||0))msg.innerHTML=`<div class="warn">قیمت فروش پایین‌تر از میانگین خرید است. میانگین: ${fmt(state.selectedStock.averageCost)} - فروش: ${fmt(p)}. اجازه ثبت برقرار است.</div>`;else msg.innerHTML=''}
async function loadSerialsForSelected(){const box=$('#serialBox');if(!box||!state.selectedItem||!state.selectedStock)return;state.selectedSerials=[];state.serialInfo=null;box.innerHTML='<div class="small muted">در حال بررسی سریال‌های کالا در انبار انتخاب‌شده...</div>';try{const url=`/api/items/${encodeURIComponent(state.selectedItem.itemCode)}/serials?stockNumber=${encodeURIComponent(state.selectedStock.stockNumber)}&stockGuid=${encodeURIComponent(state.selectedStock.stockGuid||'')}&itemGuid=${encodeURIComponent(state.selectedItem.itemGuid||'')}`;const r=await api(url);state.serialInfo=r;const list=r.list||[];if(list.length){box.innerHTML=`<div class="form-group"><label>سریال کالا در ${esc(state.selectedStock.stockNumber)} - ${esc(state.selectedStock.stockName)}</label><div class="serial-list">${list.map((x,i)=>`<label class="serial-option"><input type="checkbox" class="serial-check" data-i="${i}"> <span>${esc(x.serialNumber)}</span></label>`).join('')}</div><div class="small muted">اگر تعداد بیش از یک است، به تعداد فروش سریال انتخاب کن.</div></div>`;$$('.serial-check').forEach(ch=>ch.onchange=()=>{state.selectedSerials=$$('.serial-check').filter(x=>x.checked).map(x=>list[Number(x.dataset.i)])});}else{box.innerHTML=`<div class="form-group"><label>سریال کالا</label><input id="manualSerials" placeholder="اگر کالا سریال‌دار است، سریال‌ها را با کاما جدا وارد کن"><div class="small muted">${esc(r.note||'برای این کالا/انبار سریالی از شایگان برنگشت. در صورت نیاز سریال را دستی وارد کن تا در فاکتور شایگان داخل فیلد Serials ارسال شود.')}</div></div>`;}}catch(e){box.innerHTML=`<div class="form-group"><label>سریال کالا</label><input id="manualSerials" placeholder="خطا در خواندن سریال؛ در صورت نیاز دستی وارد کن"><div class="small error">${esc(e.message)}</div></div>`}}
function getLineSerials(){const manual=$('#manualSerials')?.value||'';const manualList=manual.split(/[،,\n]/).map(x=>x.trim()).filter(Boolean);return [...(state.selectedSerials||[]),...manualList.map(serialNumber=>({serialNumber}))]}

function selectSaleStock(item,stock){state.selectedItem=item;state.selectedStock=stock;state.selectedSerials=[];state.serialInfo=null;$('#STNumber').value=`${stock.stockNumber} - ${stock.stockName} (${stock.quantity})`;$('#saleInventory').innerHTML=`<div class="success">کالا و انبار انتخاب شد: ${esc(item.itemDescription)} | ${esc(stock.stockName)}</div>`;checkBelowCost();loadSerialsForSelected()}
function renderSaleLines(){const box=$('#saleLines');if(!box)return;if(!state.saleLines.length){box.innerHTML='<div class="small muted">هنوز ردیفی به فاکتور اضافه نشده است.</div>';return}let h='<table class="table"><thead><tr><th>ردیف</th><th>کالا</th><th>انبار</th><th>تعداد</th><th>سریال</th><th>قیمت</th><th>مبلغ</th><th>حذف</th></tr></thead><tbody>';h+=state.saleLines.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.itemCode)}<br>${esc(x.itemDescription)}</td><td>${esc(x.stockNumber)} - ${esc(x.stockName)}</td><td>${fmt(x.quantity)}</td><td>${(x.serials||[]).map(s=>esc(s.serialNumber||s)).join('<br>')||'<span class="muted">-</span>'}</td><td>${fmt(x.price)}</td><td>${fmt(x.quantity*x.price)}</td><td><button class="mini remove-line" data-i="${i}">حذف</button></td></tr>`).join('');box.innerHTML=h+'</tbody></table>';$$('.remove-line').forEach(b=>b.onclick=()=>{state.saleLines.splice(Number(b.dataset.i),1);renderSaleLines()})}
function clearSaleLineInputs(){state.selectedItem=null;state.selectedStock=null;state.selectedSerials=[];state.serialInfo=null;['saleQ','saleSelected','STNumber','Quan','Price','manualSerials'].forEach(id=>{const el=$('#'+id);if(el)el.value=id==='Quan'?'1':''});$('#saleInventory').innerHTML='';$('#priceWarn').innerHTML='';const sb=$('#serialBox');if(sb)sb.innerHTML='';setTimeout(()=>$('#saleQ')?.focus(),50)}
function addSaleLine(){if(!state.selectedItem||!state.selectedStock)return alert('اول کالا و انبار را از لیست انتخاب کنید');const quantity=Number($('#Quan').value||0);const price=Number($('#Price').value||0);if(quantity<=0)return alert('تعداد معتبر وارد کنید');if(price<=0)return alert('مبلغ فروش را وارد کنید');if(quantity>Number(state.selectedStock.quantity||0))return alert('تعداد از موجودی انبار بیشتر است');const serials=getLineSerials();if(serials.length && serials.length!==quantity){if(!confirm(`تعداد سریال انتخاب/وارد شده (${serials.length}) با تعداد فروش (${quantity}) برابر نیست. ادامه می‌دهی؟`))return;}state.saleLines.push({itemCode:state.selectedItem.itemCode,itemDescription:state.selectedItem.itemDescription,itemGuid:state.selectedItem.itemGuid,stockNumber:state.selectedStock.stockNumber,stockName:state.selectedStock.stockName,stockGuid:state.selectedStock.stockGuid,quantity,price,averageCost:state.selectedStock.averageCost,serials});renderSaleLines();clearSaleLineInputs()}
async function ensureMappings(){if(state.mappings)return state.mappings;const r=await api('/api/user-mappings');state.mappings=r.list||[];return state.mappings}
function mappingLabel(m){return `${m.fullName||m.username} | صندوق: ${m.cashboxAccountNumber||'-'} | نماینده: ${m.employeeAccountNumber||'-'} | ${m.storeName||''}`}
async function pageSale(){state.saleLines=[];setPage('فاکتور فروش جدید',`<main class="main-content"><div class="card"><div class="card-header danger"><h5>فاکتور فروش جدید</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>نام خریدار</label><input id="buyerName"></div><div class="form-group"><label>موبایل</label><input id="buyerMobile"></div><div class="form-group"><label>کد ملی</label><input id="buyerNational"></div><div class="form-group"><label>Lead ID</label><input id="leadId"></div></div><div id="sellerMappingBox" class="mapping-box"></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا</h5></div><div class="card-body">${itemSearchWidget('sale')}<div id="saleInventory" class="mt"></div><div class="row three mt"><div class="form-group"><label>انبار انتخاب‌شده</label><input id="STNumber" readonly></div><div class="form-group"><label>تعداد</label><input id="Quan" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="Price" type="number"></div></div><div id="priceWarn"></div><div id="serialBox" class="mt"></div><div class="actions"><button class="btn green" id="addLineBtn">افزودن ردیف و رفتن به کالای بعدی</button></div><div id="saleLines" class="mt"></div><div class="actions"><button class="btn red" id="issueBtn">صدور فاکتور</button><div class="muted">شماره قطعی فاکتور در لحظه صدور مستقیم از شایگان خوانده و کنترل می‌شود.</div></div><div id="saleOut"></div></div></div></main>`);
await renderSellerMappingBox();
bindItemSearch('sale',item=>{state.selectedItem=item;renderInventory(item.itemCode,'#saleInventory',true)},{showStocks:true,selectStock:true,onStockPick:(item,stock)=>selectSaleStock(item,stock),onEnter:(q)=>renderInventorySearch(q,'#saleInventory',true)});$('#Price').addEventListener('input',checkBelowCost);$('#addLineBtn').onclick=addSaleLine;renderSaleLines();const reserveBtn=$('#reserveBtn'); if(reserveBtn) reserveBtn.style.display='none';$('#issueBtn').onclick=issueSale}
async function renderSellerMappingBox(){const box=$('#sellerMappingBox');const mappings=await ensureMappings();if(state.user?.role==='admin'){state.selectedMapping=mappings.find(m=>m.username==='seller01')||mappings.find(m=>m.cashboxAccountNumber&&m.employeeAccountNumber)||mappings.find(m=>m.username==='admin')||null;box.innerHTML=`<div class="form-group"><label>فروشنده/صندوق صادرکننده</label><select id="sellerMappingSelect">${mappings.map(m=>`<option value="${esc(m.username)}" ${state.selectedMapping&&m.username===state.selectedMapping.username?'selected':''}>${esc(mappingLabel(m))}</option>`).join('')}</select><div class="small muted">فروشنده امکان تغییر صندوق ندارد؛ ادمین برای تست می‌تواند صادرکننده را انتخاب کند.</div></div>`;$('#sellerMappingSelect').onchange=()=>{state.selectedMapping=mappings.find(m=>m.username===$('#sellerMappingSelect').value)||null};}else{state.selectedMapping=mappings.find(m=>m.username===state.user?.username)||state.user?.mapping||null;if(!state.selectedMapping||!state.selectedMapping.cashboxAccountNumber||!state.selectedMapping.employeeAccountNumber){box.innerHTML=`<div class="error">اتصال صندوق/نماینده برای کاربر شما تعریف نشده است. مدیر باید در بخش تعریف صندوق/نماینده آن را تکمیل کند.</div>`}else{box.innerHTML=`<div class="success">${esc(mappingLabel(state.selectedMapping))}</div>`}}}
async function issueSale(){try{if(!state.saleLines.length){if(state.selectedItem&&state.selectedStock) addSaleLine();}if(!state.saleLines.length)return alert('هیچ ردیف کالایی در فاکتور نیست');if(!state.selectedMapping||!state.selectedMapping.cashboxAccountNumber||!state.selectedMapping.employeeAccountNumber)return alert('اتصال صندوق و نماینده فروش کامل نیست');const payload={customerName:$('#buyerName').value,mobile:$('#buyerMobile').value,nationalCode:$('#buyerNational').value,leadId:$('#leadId').value,mappingUsername:state.selectedMapping.username,sessionUsername:state.user?.username||'',username:state.user?.fullName||state.selectedMapping.fullName||'CRM',items:state.saleLines};const r=await post('/admin/accounting/putInvoice',payload);$('#saleOut').innerHTML=r.ok?`<div class="success">فاکتور ${esc(r.invoiceNumber||r.result?.Number||r.result?.InvNo||'')} با موفقیت صادر شد. فروشنده: ${esc(r.mapping?.fullName||'')}<br><b>فرم برای صدور فاکتور جدید آماده شد.</b></div><div class="actions"><a class="btn" target="_blank" href="${r.printUrl || ('/print/invoice/'+encodeURIComponent(r.invoiceNumber||r.result?.Number||state.invoiceNumber))}">چاپ فاکتور</a></div>`:`<div class="error">${esc(r.error||JSON.stringify(r.raw))}</div>`}catch(e){$('#saleOut').innerHTML=`<div class="error">${esc(e.message)}</div>`}}

async function pageAccountSet(){setPage('تعریف صندوق/نماینده',`<main class="main-content"><div class="card"><div class="card-header"><h5>اتصال کاربران CRM به حساب‌های شایگان</h5></div><div class="card-body"><p class="small muted">این بخش معادل اتصال فروشنده به صندوق و نماینده فروش در CRM قبلی است. صندوق و نماینده از شایگان جستجو و انتخاب می‌شود؛ فروشنده در فاکتور فروش حق تغییر دستی ندارد.</p><div class="row three"><div class="form-group"><label>کاربر CRM</label><select id="mapUser"></select></div><div class="form-group"><label>نام نمایشی / فروشگاه</label><input id="mapFullName" placeholder="نام فروشنده"><input id="mapStore" class="mt6" placeholder="فروشگاه"></div><div class="form-group"><label>وضعیت</label><select id="mapActive"><option value="1">فعال</option><option value="0">غیرفعال</option></select></div></div><div class="row two"><div class="form-group account-picker"><label>صندوق فروشنده در شایگان</label><input id="cashSearch" placeholder="نام یا کد صندوق را سرچ کن؛ مثل دهنوی یا 11001001"><div id="cashResults" class="floating-list account-list"></div><input id="cashSelected" readonly class="readonly" placeholder="صندوق انتخاب‌شده"></div><div class="form-group account-picker"><label>جاری کارکنان / نماینده فروش در شایگان</label><input id="repSearch" placeholder="نام یا کد نماینده را سرچ کن؛ مثل دهنوی یا 11701006"><div id="repResults" class="floating-list account-list"></div><input id="repSelected" readonly class="readonly" placeholder="نماینده انتخاب‌شده"></div></div><button class="btn green" id="saveMappingBtn">ذخیره اتصال</button><div id="mappingMsg"></div><hr><h5>دسترسی گردش حساب خاص</h5><p class="small muted">برای هر کاربر می‌توان یک یا چند حساب شایگان تعریف کرد تا فقط گردش همان حساب‌ها را ببیند. صندوق و جاری کارکنان از اتصال بالا خودکار مجاز هستند.</p><div class="row two"><div class="form-group account-picker"><label>جستجوی حساب برای افزودن دسترسی</label><input id="accessAccountSearch" placeholder="نام یا کد حساب"><div id="accessAccountResults" class="floating-list account-list"></div></div><div class="form-group"><label>حساب‌های مجاز این کاربر</label><div id="accessAccountsBox" class="access-list"></div></div></div><button class="btn" id="saveAccessBtn">ذخیره دسترسی گردش حساب</button><hr><div id="mappingList">در حال بارگذاری...</div></div></div></main>`);await initMappingPage()}
async function initMappingPage(){const users=(await api('/api/users')).list||[];const maps=(await api('/api/user-mappings')).list||[];state.mappings=maps;const sel=$('#mapUser');sel.innerHTML=users.map(u=>`<option value="${esc(u.username)}">${esc(u.fullName||u.username)} | ${esc(u.username)} | ${esc(u.role||'')}</option>`).join('');function loadUser(username){const u=users.find(x=>x.username===username)||{};const m=maps.find(x=>x.username===username)||{};$('#mapFullName').value=m.fullName||u.fullName||'';$('#mapStore').value=m.storeName||'';$('#mapActive').value=m.isActive===false?'0':'1';$('#cashSelected').value=m.cashboxAccountNumber?`${m.cashboxAccountNumber} - ${m.cashboxAccountName||''}`:'';$('#repSelected').value=m.employeeAccountNumber?`${m.employeeAccountNumber} - ${m.employeeAccountName||''}`:'';state.mapDraft={username,cashboxAccountNumber:m.cashboxAccountNumber||'',cashboxAccountName:m.cashboxAccountName||'',employeeAccountNumber:m.employeeAccountNumber||'',employeeAccountName:m.employeeAccountName||''}}
sel.onchange=()=>loadUser(sel.value);loadUser(sel.value);bindAccountPicker('cashSearch','cashResults',(acc)=>{state.mapDraft.cashboxAccountNumber=acc.accountNumber;state.mapDraft.cashboxAccountName=acc.accountName;$('#cashSelected').value=`${acc.accountNumber} - ${acc.accountName}`});bindAccountPicker('repSearch','repResults',(acc)=>{state.mapDraft.employeeAccountNumber=acc.accountNumber;state.mapDraft.employeeAccountName=acc.accountName;$('#repSelected').value=`${acc.accountNumber} - ${acc.accountName}`});
state.accessDraft=[];async function loadAccess(username){const r=await api('/api/user-account-access?username='+encodeURIComponent(username));state.accessDraft=r.list||[];renderAccessDraft()}
function renderAccessDraft(){const box=$('#accessAccountsBox');if(!box)return;box.innerHTML=state.accessDraft.length?state.accessDraft.map((a,i)=>`<div class="access-pill"><b>${esc(a.accountNumber)}</b> ${esc(a.accountName||'')} <button class="mini del-access" data-i="${i}">حذف</button></div>`).join(''):'<div class="small muted">حسابی انتخاب نشده است.</div>';$$('.del-access').forEach(b=>b.onclick=()=>{state.accessDraft.splice(Number(b.dataset.i),1);renderAccessDraft()})}
bindAccountPicker('accessAccountSearch','accessAccountResults',(acc)=>{if(!state.accessDraft.find(x=>x.accountNumber===acc.accountNumber))state.accessDraft.push(acc);renderAccessDraft()});
const oldLoadUser=loadUser;loadUser=(username)=>{oldLoadUser(username);loadAccess(username)};loadUser(sel.value);
$('#saveAccessBtn').onclick=async()=>{const r=await post('/api/user-account-access',{username:sel.value,accounts:state.accessDraft,updatedBy:state.user?.username||'admin'});$('#mappingMsg').innerHTML=r.ok?'<div class="success">دسترسی گردش حساب ذخیره شد</div>':`<div class="error">${esc(r.error||'خطا')}</div>`};
$('#saveMappingBtn').onclick=async()=>{const body={username:sel.value,fullName:$('#mapFullName').value,storeName:$('#mapStore').value,role:(users.find(u=>u.username===sel.value)||{}).role||'seller',cashboxAccountNumber:state.mapDraft.cashboxAccountNumber,cashboxAccountName:state.mapDraft.cashboxAccountName,employeeAccountNumber:state.mapDraft.employeeAccountNumber,employeeAccountName:state.mapDraft.employeeAccountName,isActive:$('#mapActive').value==='1',updatedBy:state.user?.username||'admin'};if(!body.cashboxAccountNumber||!body.employeeAccountNumber){if(!confirm('صندوق یا نماینده کامل انتخاب نشده است. ذخیره شود؟'))return;}const r=await post('/api/user-mappings',body);$('#mappingMsg').innerHTML=r.ok?'<div class="success">ذخیره شد</div>':`<div class="error">${esc(r.error||'خطا')}</div>`;state.mappings=null;await renderMappingsTable()};await renderMappingsTable()}
function accountText(a){return `${a.accountNumber||''} ${a.accountName||''} ${a.moinNumber||''}`}
function normClient(v=''){return String(v||'').toLowerCase().replace(/[ي]/g,'ی').replace(/[ك]/g,'ک').replace(/‌/g,' ').replace(/[_\-\/\|.,؛:()\[\]{}+]+/g,' ').replace(/\s+/g,' ').trim()}
function tokensClient(q=''){return normClient(q).split(/\s+/).map(x=>x.trim()).filter(Boolean)}
function accountMatchesClient(a,tokens){const hay=normClient(accountText(a));return tokens.every(t=>hay.includes(normClient(t)))}
function accountScoreClient(a,tokens){const hay=normClient(accountText(a));const num=normClient(a.accountNumber||'');const name=normClient(a.accountName||'');let score=0;for(const t of [...new Set(tokens.map(normClient))]){if(num===t)score+=10000;else if(num.startsWith(t))score+=5000;else if(num.includes(t))score+=2000;if(name.startsWith(t))score+=1600;else if(name.includes(t))score+=Math.max(100,900-name.indexOf(t));}score-=Math.min(hay.length,300)/30;return score}
function renderAccountResults(box,list,onPick,input){box.style.display='block';if(!list.length){box.innerHTML='<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>';popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-result'});return;}box.innerHTML=list.map((a,i)=>`<div class="account-result" data-i="${i}"><b>${esc(a.accountName||'')}</b><span>${esc(a.accountNumber||'')}</span><small>${esc(a.moinNumber||'')}</small></div>`).join('');box.querySelectorAll('.account-result').forEach(el=>el.onclick=()=>{const a=list[Number(el.dataset.i)];onPick({accountNumber:a.accountNumber,accountName:a.accountName,moinNumber:a.moinNumber,guId:a.guId||a.accountGuid||a.raw?.GuId||'',accountGuid:a.guId||a.accountGuid||a.raw?.GuId||'',raw:a.raw});popupSuggestionController.close();if(input)input.value=`${a.accountNumber} - ${a.accountName||''}`;});box._lastList=list;popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-result'});}
function bindAccountPicker(inputId,listId,onPick,opts={}){const input=$('#'+inputId), box=$('#'+listId);let cacheList=[];let cacheBase='';let requestSeq=0;const limit=Number(opts.limit||100);function filterLocal(q){const tokens=tokensClient(q);if(!tokens.length)return [];return cacheList.filter(a=>accountMatchesClient(a,tokens)).sort((a,b)=>accountScoreClient(b,tokens)-accountScoreClient(a,tokens)).slice(0,limit)}async function liveSearch(q){const seq=++requestSeq;box.style.display='block';box.innerHTML='<div class="floating-empty">در حال جستجو در شایگان...</div>';let r=await api(`/api/accounts/search?q=${encodeURIComponent(q)}&limit=${limit}&pages=${opts.pages||220}`);if(seq!==requestSeq)return;let list=r.list||[];cacheList=list;cacheBase=tokensClient(q)[0]||q;if(!list.length){const toks=tokensClient(q);for(const t of toks){r=await api(`/api/accounts/search?q=${encodeURIComponent(t)}&limit=${limit}&pages=${opts.pages||220}`);list=r.list||[];if(list.length){cacheList=list;cacheBase=t;break;}}}const filtered=filterLocal(q);renderAccountResults(box,filtered.length?filtered:list,onPick,input)}const search=debounce(async()=>{const q=input.value.trim();const tokens=tokensClient(q);if(q.length<2||!tokens.length){box.style.display='none';box.innerHTML='';return;}if(cacheList.length){const filtered=filterLocal(q);if(filtered.length){renderAccountResults(box,filtered,onPick,input);return;}}
await liveSearch(q);},250);input.addEventListener('input',search);input.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();const list=box._lastList&&box._lastList.length?box._lastList:filterLocal(input.value);if(list.length){const a=list[0];onPick({accountNumber:a.accountNumber,accountName:a.accountName,moinNumber:a.moinNumber,guId:a.guId||a.accountGuid||a.raw?.GuId||'',accountGuid:a.guId||a.accountGuid||a.raw?.GuId||'',raw:a.raw});box.style.display='none';input.value=`${a.accountNumber} - ${a.accountName||''}`;}else if(input.value.trim().length>=2){await liveSearch(input.value.trim());}}});document.addEventListener('click',e=>{if(input&&!input.contains(e.target)&&box&&!box.contains(e.target))box.style.display='none'});}
bindAccountPicker=function(inputId,listId,onPick,opts={}){
  const input=$('#'+inputId),box=$('#'+listId);if(!input||!box)return;
  let cacheList=[],requestSeq=0,requestController=null;const limit=Number(opts.limit||100);
  uiPageLifecycle.add(()=>{requestSeq++;requestController?.abort();requestController=null;});
  const filterLocal=q=>{const tokens=tokensClient(q);if(!tokens.length)return [];return cacheList.filter(a=>accountMatchesClient(a,tokens)).sort((a,b)=>accountScoreClient(b,tokens)-accountScoreClient(a,tokens)).slice(0,limit)};
  async function liveSearch(value){const seq=++requestSeq;requestController?.abort();requestController=new AbortController();box.innerHTML='<div class="floating-empty">در حال جستجو در شایگان...</div>';popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-result'});try{const r=await api(`/api/accounts/search?q=${encodeURIComponent(value)}&limit=${limit}&pages=${opts.pages||220}`,{signal:requestController.signal});if(seq!==requestSeq)return[];cacheList=r.list||[];const filtered=filterLocal(value),list=filtered.length?filtered:cacheList;renderAccountResults(box,list,onPick,input);return list;}catch(e){if(e.name==='AbortError')return[];popupSuggestionController.close({restoreFocus:false});box.innerHTML=`<div class="floating-empty">${esc(e.message||e)}</div>`;return[];}}
  const search=debounce(async()=>{const value=input.value.trim();if(value.length<2){requestSeq++;requestController?.abort();popupSuggestionController.close({restoreFocus:false});box.innerHTML='';return;}const filtered=filterLocal(value);if(filtered.length)return renderAccountResults(box,filtered,onPick,input);await liveSearch(value);},250);
  input.addEventListener('input',search);
  input.addEventListener('keydown',async e=>{if(e.key==='Enter'&&!popupSuggestionController.isOpen(box)){e.preventDefault();const list=box._lastList?.length?box._lastList:await liveSearch(input.value.trim());if(list?.length)box.querySelector('.account-result')?.click();}});
};
async function renderMappingsTable(){const r=await api('/api/user-mappings');state.mappings=r.list||[];let h='<table class="table"><thead><tr><th>کاربر</th><th>نام</th><th>گروه</th><th>فروشگاه</th><th>صندوق</th><th>نماینده</th><th>وضعیت</th></tr></thead><tbody>';h+=state.mappings.map(m=>`<tr><td>${esc(m.username)}</td><td>${esc(m.fullName||'')}</td><td>${esc(m.role||'')}</td><td>${esc(m.storeName||'')}</td><td>${esc(m.cashboxAccountNumber||'')}<br><small>${esc(m.cashboxAccountName||'')}</small></td><td>${esc(m.employeeAccountNumber||'')}<br><small>${esc(m.employeeAccountName||'')}</small></td><td>${m.isActive===false?'غیرفعال':'فعال'}</td></tr>`).join('');$('#mappingList').innerHTML=h+'</tbody></table>'}

async function pageUsers(){setPage('کاربران',`<main class="main-content"><div class="card"><div class="card-header"><h5>افزودن / ویرایش کاربر</h5></div><div class="card-body"><input type="hidden" id="uOriginalUsername"><div class="row three"><div class="form-group"><label>نام</label><input id="uFirst"></div><div class="form-group"><label>نام خانوادگی</label><input id="uLast"></div><div class="form-group"><label>نام کاربری</label><input id="uUsername"></div><div class="form-group"><label>رمز عبور</label><input id="uPass" type="password"></div><div class="form-group"><label>تکرار رمز عبور</label><input id="uPass2" type="password"></div><div class="form-group"><label>گروه کاربری</label><select id="uRole"><option value="admin">مدیر سیستم</option><option value="seller">فروشنده</option><option value="accounting">حسابداری</option><option value="warehouse">انبار</option><option value="purchase">بازرگانی</option></select></div><div class="form-group"><label>شماره موبایل</label><input id="uMobile"></div></div><button class="btn green" id="saveUserBtn">ذخیره کاربر</button><div id="userMsg"></div></div></div><div class="card"><div class="card-header"><h5>لیست کاربران</h5></div><div class="card-body"><div id="usersTable">در حال بارگذاری...</div></div></div></main>`);$('#saveUserBtn').onclick=saveUser;await renderUsersTable()}
async function saveUser(){const firstName=$('#uFirst').value.trim(), lastName=$('#uLast').value.trim(), username=$('#uUsername').value.trim(), password=$('#uPass').value, password2=$('#uPass2').value, role=$('#uRole').value, mobile=$('#uMobile').value.trim(), originalUsername=$('#uOriginalUsername').value.trim();if(!firstName||!lastName||!username||!role)return $('#userMsg').innerHTML='<div class="error">نام، نام خانوادگی، نام کاربری و گروه کاربری الزامی است.</div>';if(password!==password2)return $('#userMsg').innerHTML='<div class="error">رمز عبور و تکرار آن برابر نیست.</div>';const r=await post('/api/users',{firstName,lastName,username,password,role,mobile,originalUsername});$('#userMsg').innerHTML=r.ok?'<div class="success">کاربر ذخیره شد. حالا از بخش تعریف صندوق/نماینده به اکانت شایگان متصلش کن.</div>':`<div class="error">${esc(r.error||'خطا')}</div>`;if(r.ok){$('#uOriginalUsername').value=$('#uFirst').value=$('#uLast').value=$('#uUsername').value=$('#uPass').value=$('#uPass2').value=$('#uMobile').value='';await renderUsersTable()}}
async function renderUsersTable(){const r=await api('/api/users');const roles={admin:'مدیر سیستم',seller:'فروشنده',accounting:'حسابداری',warehouse:'انبار',purchase:'بازرگانی'};let h='<table class="table"><thead><tr><th>نام</th><th>نام کاربری</th><th>گروه کاربری</th><th>موبایل</th><th>وضعیت اتصال شایگان</th></tr></thead><tbody>';const maps=(await api('/api/user-mappings')).list||[];h+=(r.list||[]).map(u=>{const m=maps.find(x=>x.username===u.username);const payload=encodeURIComponent(JSON.stringify(u));return `<tr class="user-row" data-user="${payload}"><td><button class="linklike edit-user">${esc(u.fullName||((u.firstName||'')+' '+(u.lastName||'')))}</button></td><td>${esc(u.username)}</td><td>${esc(roles[u.role]||u.role||'')}</td><td>${esc(u.mobile||'')}</td><td>${m&&m.cashboxAccountNumber&&m.employeeAccountNumber?'<span class="oktext">متصل</span>':'<span class="warntext">نیازمند اتصال</span>'}</td></tr>`}).join('');$('#usersTable').innerHTML=h+'</tbody></table>';$$('.user-row').forEach(tr=>tr.onclick=()=>{const u=JSON.parse(decodeURIComponent(tr.dataset.user));$('#uOriginalUsername').value=u.username||'';$('#uFirst').value=u.firstName||'';$('#uLast').value=u.lastName||'';$('#uUsername').value=u.username||'';$('#uRole').value=u.role||'seller';$('#uMobile').value=u.mobile||'';$('#uPass').value='';$('#uPass2').value='';$('#userMsg').innerHTML='<div class="info">حالت ویرایش کاربر: رمز را فقط در صورت تغییر وارد کن.</div>';window.scrollTo({top:0,behavior:'smooth'});})}


async function pageTurnover(){setPage('گردش حساب',`<main class="main-content"><div class="card"><div class="card-header"><h5>گردش حساب</h5></div><div class="card-body"><div id="turnoverAccessMsg" class="small muted"></div><div class="row four"><div class="form-group"><label>حساب مجاز</label><select id="turnoverAccountSelect"><option value="">انتخاب حساب</option></select></div><div class="form-group account-picker"><label>جستجوی حساب، فقط مدیر سیستم</label><input id="turnoverAccountSearch" placeholder="نام یا کد حساب"><div id="turnoverAccountResults" class="floating-list account-list"></div></div><div class="form-group"><label>از تاریخ شمسی، ۸ رقمی</label><input id="turnoverFrom" placeholder="14030501"></div><div class="form-group"><label>تا تاریخ شمسی، ۸ رقمی</label><input id="turnoverTo" placeholder="14030531"></div></div><button class="btn" id="loadTurnoverBtn">نمایش گردش</button><div id="turnoverOut" class="mt"></div></div></div></main>`);const r=await api('/api/account-access/my');const sel=$('#turnoverAccountSelect');if(r.admin){$('#turnoverAccessMsg').textContent='مدیر سیستم می‌تواند هر حسابی را جستجو کند.';bindAccountPicker('turnoverAccountSearch','turnoverAccountResults',(acc)=>{sel.innerHTML=`<option value="${esc(acc.accountNumber)}">${esc(acc.accountNumber)} - ${esc(acc.accountName)}</option>`})}else{const list=r.list||[];$('#turnoverAccessMsg').textContent=list.length?'حساب‌های مجاز شما در لیست زیر آمده است.':'هیچ حسابی برای مشاهده گردش شما تعریف نشده است.';sel.innerHTML='<option value="">انتخاب حساب</option>'+list.map(a=>`<option value="${esc(a.accountNumber)}">${esc(a.accountNumber)} - ${esc(a.accountName||'')}</option>`).join('');$('#turnoverAccountSearch').disabled=true}$('#loadTurnoverBtn').onclick=async()=>{const accountNumber=sel.value;if(!accountNumber)return alert('حساب را انتخاب کن');const body={accountNumber,dateFrom:cleanDate8($('#turnoverFrom').value.trim()),dateTo:cleanDate8($('#turnoverTo').value.trim())};const tr=await post('/admin/accounting/getTurnover',body);const rows=tr.list||tr.result||[];let h='<table class="table"><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>سند/فاکتور</th></tr></thead><tbody>';h+=rows.map(x=>`<tr><td>${esc(toJalaliDisplay(x.Date||x.date||''))}</td><td>${esc(x.Comment||x.Description||x.Desc||'')}</td><td>${fmt(x.DebitAmount||x.Debit||0)}</td><td>${fmt(x.CreditAmount||x.Credit||0)}</td><td>${fmt(x.Remain||0)}</td><td>${esc(x.DocumentNumber||'')} / ${esc(x.InvNo||'')}</td></tr>`).join('');$('#turnoverOut').innerHTML=h+'</tbody></table>'}}

function proformaLineHtml(){return `<div id="proformaLines" class="mt"></div>`}
function renderProformaLines(){const box=$('#proformaLines');if(!box)return;if(!state.proformaLines)state.proformaLines=[];if(!state.proformaLines.length){box.innerHTML='<div class="small muted">هنوز ردیفی اضافه نشده است.</div>';return}let h='<table class="table"><thead><tr><th>ردیف</th><th>کالا</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th><th>حذف</th></tr></thead><tbody>';h+=state.proformaLines.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.itemCode)}<br>${esc(x.itemDescription)}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.price)}</td><td>${fmt(x.quantity*x.price)}</td><td><button class="mini proforma-del" data-i="${i}">حذف</button></td></tr>`).join('');box.innerHTML=h+'</tbody></table>';$$('.proforma-del').forEach(b=>b.onclick=()=>{state.proformaLines.splice(Number(b.dataset.i),1);renderProformaLines()})}
async function pageProforma(){state.proformaLines=[];state.proformaItem=null;setPage('پیش‌فاکتور',`<main class="main-content"><div class="card"><div class="card-header"><h5>صدور پیش‌فاکتور</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>نام خریدار</label><input id="pfCustomer"></div><div class="form-group"><label>موبایل</label><input id="pfMobile"></div><div class="form-group"><label>Lead ID</label><input id="pfLead"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا، بدون محدودیت موجودی</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="pfQ" placeholder="مثلا all in one یا nb msi"><div id="pfList" class="floating-list"></div><input id="pfSelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="pfQty" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="pfPrice" type="number"></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="pfAdd">افزودن ردیف</button></div></div>${proformaLineHtml()}<div class="actions"><button class="btn red" id="pfSave">ثبت پیش‌فاکتور</button></div><div id="pfOut"></div></div></div></main>`);const input=$('#pfQ'), list=$('#pfList');const doSearch=debounce(async()=>{const q=input.value.trim();if(q.length<2){list.style.display='none';return}list.style.display='block';list.innerHTML='<div class="floating-empty">در حال جستجو...</div>';const r=await api(`/api/items/search-all?q=${encodeURIComponent(q)}&limit=80&pages=300&forceLive=1`);const items=r.list||[];list.innerHTML=items.length?items.map(it=>`<div class="floating-item pf-item" data-code="${esc(it.itemCode)}" data-desc="${esc(it.itemDescription)}" data-guid="${esc(it.itemGuid||'')}"><div class="item-title">${esc(it.itemDescription)}</div><div class="item-meta"><span class="pill">${esc(it.itemCode)}</span></div></div>`).join(''):'<div class="floating-empty">نتیجه‌ای نبود</div>';$$('.pf-item').forEach(el=>el.onclick=()=>{state.proformaItem={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$('#pfSelected').value=`${el.dataset.code} - ${el.dataset.desc}`;list.style.display='none'})},300);input.addEventListener('input',doSearch);$('#pfAdd').onclick=()=>{if(!state.proformaItem)return alert('کالا را انتخاب کن');const quantity=Number($('#pfQty').value||0), price=Number($('#pfPrice').value||0);if(quantity<=0||price<=0)return alert('تعداد و قیمت معتبر وارد کن');state.proformaLines.push({...state.proformaItem,quantity,price});state.proformaItem=null;$('#pfSelected').value='';$('#pfQ').value='';$('#pfQty').value='1';$('#pfPrice').value='';renderProformaLines()};renderProformaLines();$('#pfSave').onclick=async()=>{if(!state.proformaLines.length)return alert('ردیفی وجود ندارد');const r=await post('/api/proformas',{customerName:$('#pfCustomer').value,mobile:$('#pfMobile').value,leadId:$('#pfLead').value,items:state.proformaLines});$('#pfOut').innerHTML=r.ok?`<div class="success">پیش‌فاکتور ثبت شد: ${r.proforma.proformaNo}</div><a class="btn" target="_blank" href="/print/proforma/${r.proforma.proformaNo}">چاپ پیش‌فاکتور</a>`:`<div class="error">${esc(r.error||'خطا')}</div>`}}

async function pageReports(){setPage('تست‌ها و گزارش',`<div class="card"><h3>ابزار کنترل‌شده</h3><div class="card-body"><button class="btn" id="h">Health</button><button class="btn" id="last">آخرین شماره فروش</button><button class="btn red" id="sync">Sync Inventory Catalog</button><button class="btn red" id="syncAll">Sync All Items Catalog برای کاردکس</button><button class="btn" id="testKatana">تست katana</button><button class="btn" id="testAllInOne">تست all in one</button><pre id="out"></pre></div></div>`);$('#h').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/shaygan/health'),null,2);$('#last').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/invoices/last-sale'),null,2);$('#sync').onclick=async()=>$('#out').textContent=JSON.stringify(await post('/api/catalog/sync?pages=300',{}),null,2);$('#syncAll').onclick=async()=>$('#out').textContent=JSON.stringify(await post('/api/catalog/sync-all-items?pages=all',{}),null,2);$('#testKatana').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/items/search?q=katana&limit=20&pages=250'),null,2);$('#testAllInOne').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/items/search-all?q=all%20in%20one&limit=50&pages=25'),null,2)}
async function pageCustomers(){setPage('مشتریان',`<div class="card"><h3>مشتری</h3><div class="card-body"><div class="row three"><input id="cn" placeholder="نام"><input id="cm" placeholder="موبایل"><input id="cc" placeholder="کد ملی"></div><button class="btn green" id="saveC">ذخیره</button><pre id="co"></pre></div></div>`);$('#saveC').onclick=async()=>$('#co').textContent=JSON.stringify(await post('/api/customers',{fullName:$('#cn').value,mobile:$('#cm').value,nationalCode:$('#cc').value}),null,2)}
function placeholder(t){setPage(t,`<div class="card"><h3>${esc(t)}</h3><div class="card-body"><p>این محیط از CRM قبلی حفظ شده و اتصال داده‌ای آن مرحله‌ای به WebService جدید منتقل می‌شود.</p></div></div>`)}
function dashboard(){setPage('داشبورد',`<div class="card"><h3>MKCRM Legacy Real UI Stage</h3><div class="card-body"><p>دسترسی منوها بر اساس گروه کاربری فعال شده است. مرحله فعلی روی فروش، موجودی، کاردکس و فاکتور چندردیفی تمرکز دارد.</p><p>برای تست سرچ: منوی موجودی انبارها → عبارت <b>katana</b> یا <b>nb msi</b>.</p></div></div>`)}
async function route(){let p=location.hash.slice(1)||firstAllowedPage();if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}if(p==='dashboard')return dashboard();if(p==='stocks')return pageStocks();if(p==='cardex')return pageCardex();if(p==='sale')return pageSale();if(p==='proforma')return pageProforma();if(p==='turnover')return pageTurnover();if(p==='account-set')return pageAccountSet();if(p==='users')return pageUsers();if(p==='seller-profit')return pageSellerProfit();if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();if(p==='customers')return pageCustomers();return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p)}
window.addEventListener('hashchange',route);(async()=>{
  try{state.user=JSON.parse(localStorage.mkcrmUser||'null')}catch{}
  try{
    const me=await api('/api/auth/me');
    if(me.ok && me.user){state.user=me.user;localStorage.mkcrmUser=JSON.stringify(me.user);return shell();}
  }catch(e){localStorage.removeItem('mkcrmUser');}
  return loginScreen();
})();

/* PATCH 0.6.1: proforma search, turnover access, user-specific allowed accounts */
function _itemCodeOf(x){return x.ItemCode||x.itemCode||x.ProductCode||x.productCode||''}
function _itemDescOf(x){return x.ItemDesc||x.itemDescription||x.ProductDesc||x.productDescription||''}
function _itemGuidOf(x){return x.ItemGuId||x.itemGuid||x.GuId||x.guId||''}
function _roleIsSeller(role){return role==='seller'||role==='seller_buyer'}
function _selectedUserForEdit(){return ($('#uOriginalUsername')?.value||$('#uUsername')?.value||'').trim()}
function _showUserAccessSection(){const box=$('#userAccessBox'); if(!box)return; const role=$('#uRole')?.value||''; box.style.display=_roleIsSeller(role)?'block':'none'}
function _renderUserAccessDraft(){const box=$('#userAccessList'); if(!box)return; const list=state.userAccessDraft||[]; if(!list.length){box.innerHTML='<div class="small muted">حساب مجاز اضافه نشده است.</div>';return;} box.innerHTML=list.map((a,i)=>`<div class="access-pill"><span>${esc(a.accountNumber)} - ${esc(a.accountName||'')}</span><button class="mini del-user-access" data-i="${i}">حذف</button></div>`).join(''); $$('.del-user-access').forEach(b=>b.onclick=()=>{state.userAccessDraft.splice(Number(b.dataset.i),1);_renderUserAccessDraft()})}
async function _loadUserAccess(username){state.userAccessDraft=[]; if(!username){_renderUserAccessDraft();return;} try{const r=await api('/api/user-account-access?username='+encodeURIComponent(username)); state.userAccessDraft=r.list||[];}catch{state.userAccessDraft=[];} _renderUserAccessDraft()}
async function _saveUserAccessIfNeeded(username, role){if(!_roleIsSeller(role)||!username)return {ok:true, skipped:true}; return await post('/api/user-account-access',{username,accounts:state.userAccessDraft||[],updatedBy:state.user?.username||'admin'});}

async function pageUsers(){state.userAccessDraft=[];setPage('کاربران',`<main class="main-content"><div class="card"><div class="card-header"><h5>افزودن / ویرایش کاربر</h5></div><div class="card-body"><input type="hidden" id="uOriginalUsername"><div class="row three"><div class="form-group"><label>نام</label><input id="uFirst"></div><div class="form-group"><label>نام خانوادگی</label><input id="uLast"></div><div class="form-group"><label>نام کاربری</label><input id="uUsername"></div><div class="form-group"><label>رمز ورود</label><input id="uPass" type="password" placeholder="فقط برای تغییر رمز پر شود"></div><div class="form-group"><label>تکرار رمز ورود</label><input id="uPass2" type="password"></div><div class="form-group"><label>گروه کاربری</label><select id="uRole"><option value="admin">مدیر سیستم</option><option value="seller">فروشنده</option><option value="accounting">حسابداری</option><option value="warehouse">انبار</option><option value="purchase">بازرگانی</option><option value="seller_buyer">فروشنده-خریدار</option></select></div><div class="form-group"><label>شماره موبایل</label><input id="uMobile"></div></div><div id="userAccessBox" class="mapping-box" style="display:none"><h4>حساب‌های مجاز گردش حساب برای این فروشنده</h4><p class="small muted">صندوق و جاری کارکنان از «تعریف صندوق/نماینده» به‌صورت خودکار مجاز می‌شوند. اینجا حساب‌های اضافی را اضافه کن.</p><div class="row two"><div class="form-group account-picker"><label>جستجوی حساب شایگان برای دسترسی مجاز</label><input id="uAccessSearch" placeholder="نام یا کد حساب"><div id="uAccessResults" class="floating-list account-list"></div></div><div><label>حساب‌های انتخاب‌شده</label><div id="userAccessList" class="access-list"></div></div></div></div><button class="btn green" id="saveUserBtn">ذخیره کاربر</button><button class="btn gray" id="newUserBtn">کاربر جدید</button><button class="btn" id="repairUserLinksBtn">اصلاح اتصال کاربران</button><div id="userMsg"></div></div></div><div class="card"><div class="card-header"><h5>لیست کاربران</h5></div><div class="card-body"><div id="usersTable">در حال بارگذاری...</div></div></div></main>`);$('#uRole').onchange=_showUserAccessSection;bindAccountPicker('uAccessSearch','uAccessResults',(acc)=>{if(!(state.userAccessDraft||[]).find(x=>String(x.accountNumber)===String(acc.accountNumber))){state.userAccessDraft.push({accountNumber:acc.accountNumber,accountName:acc.accountName,accountGuid:acc.guId||acc.accountGuid||'',guId:acc.guId||acc.accountGuid||'',accountKey:acc.accountKey||''});_renderUserAccessDraft();}});$('#newUserBtn').onclick=()=>{$('#uOriginalUsername').value=$('#uFirst').value=$('#uLast').value=$('#uUsername').value=$('#uPass').value=$('#uPass2').value=$('#uMobile').value='';$('#uRole').value='seller';state.userAccessDraft=[];_showUserAccessSection();_renderUserAccessDraft();$('#userMsg').innerHTML=''};$('#saveUserBtn').onclick=saveUser;_showUserAccessSection();_renderUserAccessDraft();await renderUsersTable()}
async function saveUser(){const firstName=$('#uFirst').value.trim(), lastName=$('#uLast').value.trim(), username=$('#uUsername').value.trim(), password=$('#uPass').value, password2=$('#uPass2').value, role=$('#uRole').value, mobile=$('#uMobile').value.trim(), originalUsername=$('#uOriginalUsername').value.trim();if(!firstName||!lastName||!username||!role)return $('#userMsg').innerHTML='<div class="error">نام، نام خانوادگی، نام کاربری و گروه کاربری الزامی است.</div>';if(password!==password2)return $('#userMsg').innerHTML='<div class="error">رمز ورود و تکرار آن برابر نیست.</div>';const r=await post('/api/users',{firstName,lastName,username,password,role,mobile,originalUsername,updatedBy:state.user?.username||'admin'});if(!r.ok)return $('#userMsg').innerHTML=`<div class="error">${esc(r.error||'خطا')}</div>`;const ar=await _saveUserAccessIfNeeded(username,role);$('#userMsg').innerHTML=`<div class="success">کاربر ذخیره شد${ar.skipped?'':' و حساب‌های مجاز گردش حساب هم ثبت شد'}.</div>`;$('#uOriginalUsername').value=username;await renderUsersTable()}
async function renderUsersTable(){const r=await api('/api/users');const roles={admin:'مدیر سیستم',seller:'فروشنده',accounting:'حسابداری',warehouse:'انبار',purchase:'بازرگانی',seller_buyer:'فروشنده-خریدار'};let h='<table class="table"><thead><tr><th>نام</th><th>نام کاربری</th><th>گروه کاربری</th><th>موبایل</th><th>وضعیت اتصال شایگان</th></tr></thead><tbody>';const maps=(await api('/api/user-mappings')).list||[];h+=(r.list||[]).map(u=>{const m=maps.find(x=>x.username===u.username);const payload=encodeURIComponent(JSON.stringify(u));return `<tr class="user-row" data-user="${payload}"><td><button class="linklike edit-user">${esc(u.fullName||((u.firstName||'')+' '+(u.lastName||'')))}</button></td><td>${esc(u.username)}</td><td>${esc(roles[u.role]||u.role||'')}</td><td>${esc(u.mobile||'')}</td><td>${m&&m.cashboxAccountNumber&&m.employeeAccountNumber?'<span class="oktext">متصل</span>':'<span class="warntext">نیازمند اتصال</span>'}</td></tr>`}).join('');$('#usersTable').innerHTML=h+'</tbody></table>';$$('.user-row').forEach(tr=>tr.onclick=async()=>{const u=JSON.parse(decodeURIComponent(tr.dataset.user));$('#uOriginalUsername').value=u.username||'';$('#uFirst').value=u.firstName||'';$('#uLast').value=u.lastName||'';$('#uUsername').value=u.username||'';$('#uRole').value=u.role||'seller';$('#uMobile').value=u.mobile||'';$('#uPass').value='';$('#uPass2').value='';_showUserAccessSection();await _loadUserAccess(u.username);$('#userMsg').innerHTML='<div class="info">حالت ویرایش کاربر: رمز را فقط در صورت تغییر وارد کن.</div>';window.scrollTo({top:0,behavior:'smooth'});})}

async function pageTurnover(){setPage('گردش حساب',`<main class="main-content"><div class="card"><div class="card-header"><h5>گردش حساب</h5></div><div class="card-body"><div id="turnoverAccessMsg" class="small muted"></div><div class="row four"><div id="turnoverSelectWrap" class="form-group"><label>حساب‌های مجاز</label><div id="allowedAccountsBox" class="access-list"></div><select id="turnoverAccountSelect" style="display:none"><option value="">انتخاب حساب</option></select></div><div id="turnoverSearchWrap" class="form-group account-picker"><label>جستجوی حساب</label><input id="turnoverAccountSearch" placeholder="نام یا کد حساب؛ مثلا موذنی ۶۰"><div id="turnoverAccountResults" class="floating-list account-list"></div><input id="turnoverPicked" class="readonly mt6" readonly placeholder="حساب انتخاب‌شده"></div><div class="form-group"><label>از تاریخ شمسی، ۸ رقمی</label><input id="turnoverFrom" placeholder="14030501"></div><div class="form-group"><label>تا تاریخ شمسی، ۸ رقمی</label><input id="turnoverTo" placeholder="14030531"></div></div><button class="btn" id="loadTurnoverBtn">نمایش گردش</button><div id="turnoverOut" class="mt"></div></div></div></main>`);const r=await api('/api/account-access/my');const sel=$('#turnoverAccountSelect');const allowedBox=$('#allowedAccountsBox');$('#turnoverFrom').value='';$('#turnoverTo').value='';let picked='';let pickedName='';let pickedGuid='';function setPicked(acc){picked=String(acc.accountNumber||'');pickedName=acc.accountName||'';pickedGuid=acc.guId||acc.accountGuid||acc.raw?.GuId||acc.raw?.GuID||'';$('#turnoverPicked').value=`${picked} - ${pickedName}`;sel.innerHTML=`<option value="${esc(picked)}">${esc(picked)} - ${esc(pickedName)}</option>`;sel.value=picked;$('#turnoverOut').innerHTML='';}
function renderAllowed(list){if(!list.length){allowedBox.innerHTML='<div class="warn">هیچ حسابی برای مشاهده گردش شما تعریف نشده است. مدیر باید در صفحه کاربران یا تعریف صندوق/نماینده، صندوق/جاری یا حساب‌های مجاز را ثبت کند.</div>';return;}allowedBox.innerHTML=list.map((a,i)=>`<button class="account-chip allowed-account" data-i="${i}"><b>${esc(a.accountNumber)}</b><span>${esc(a.accountName||'')}</span><small>${esc(a.source||'')}</small></button>`).join('');$$('.allowed-account').forEach(b=>b.onclick=()=>{const a=list[Number(b.dataset.i)];setPicked(a);$$('.allowed-account').forEach(x=>x.classList.remove('active'));b.classList.add('active');});if(list.length===1)setPicked(list[0]);}
if(r.fullAccess){$('#turnoverAccessMsg').textContent='این گروه کاربری دسترسی کامل گردش حساب دارد. حساب را جستجو و انتخاب کن. با Enter اولین نتیجه انتخاب می‌شود.';$('#turnoverSelectWrap').style.display='none';bindAccountPicker('turnoverAccountSearch','turnoverAccountResults',setPicked,{limit:120,pages:220});}else{const list=r.list||[];$('#turnoverSearchWrap').style.display='none';$('#turnoverAccessMsg').textContent=list.length?'حساب‌های مجاز شما: روی یک حساب کلیک کن و سپس فیلتر تاریخ را بزن.':'هیچ حسابی برای مشاهده گردش شما تعریف نشده است. مدیر باید از صفحه کاربران یا تعریف صندوق/نماینده حساب مجاز بدهد.';renderAllowed(list);}
$('#loadTurnoverBtn').onclick=async()=>{const accountNumber=picked||sel.value;if(!accountNumber){$('#turnoverOut').innerHTML='<div class="error">حساب را انتخاب کن.</div>';return;}$('#turnoverOut').innerHTML=`<div class="small muted">در حال دریافت گردش حساب ${esc(accountNumber)}...</div>`;const body={accountNumber,accountGuid:pickedGuid,dateFrom:cleanDate8($('#turnoverFrom').value.trim()),dateTo:cleanDate8($('#turnoverTo').value.trim())};const tr=await post('/admin/accounting/getTurnover',body);const rows=tr.list||tr.result||[];if(!tr.ok)return $('#turnoverOut').innerHTML=`<div class="error">${esc(tr.error||'خطا در خواندن گردش حساب')}</div><pre class="debug-pre">${esc(JSON.stringify(tr.diagnostics||tr.raw||{},null,2))}</pre>`;if(!rows.length)return $('#turnoverOut').innerHTML=`<div class="warn">گردشی برای ${esc(accountNumber)} ${pickedName?'- '+esc(pickedName):''} در این بازه پیدا نشد.</div><details><summary>جزئیات تست‌های شایگان</summary><pre class="debug-pre">${esc(JSON.stringify(tr.diagnostics||{},null,2))}</pre></details><div id="saleSellerDetailBox" class="mt"></div>`;let h=`<div class="success">${rows.length} ردیف گردش برای ${esc(accountNumber)} ${pickedName?'- '+esc(pickedName):''}</div><table class="table"><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>سند/فاکتور</th></tr></thead><tbody>`;h+=rows.map(x=>`<tr><td>${esc(toJalaliDisplay(x.Date||x.date||x.InvDate||x.DocDate||x.VouchDate||x.VoucherDate||''))}</td><td>${esc(x.Comment||x.Description||x.Desc||x.RowDescription||x.Detail||x.DetailDesc||'')}</td><td>${fmt(x.DebitAmount||x.Debit||x.Bedehkar||x.RialBed||0)}</td><td>${fmt(x.CreditAmount||x.Credit||x.Bestankar||x.RialBes||0)}</td><td>${fmt(x.Remain||x.Balance||x.total||0)}</td><td>${esc(x.DocumentNumber||x.DocNo||x.SanadNo||x.VouchNumber||'')} / ${esc(x.InvNo||x.InvoiceNumber||'')}</td></tr>`).join('');$('#turnoverOut').innerHTML=h+'</tbody></table>';}}
async function pageProforma(){state.proformaLines=[];state.proformaItem=null;setPage('پیش‌فاکتور',`<main class="main-content"><div class="card"><div class="card-header"><h5>صدور پیش‌فاکتور</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>نام خریدار</label><input id="pfCustomer"></div><div class="form-group"><label>موبایل</label><input id="pfMobile"></div><div class="form-group"><label>Lead ID</label><input id="pfLead"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا، بدون محدودیت موجودی</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="pfQ" placeholder="مثلا all in one یا nb msi"><div id="pfMsg" class="small muted"></div><div id="pfList" class="floating-list"></div><input id="pfSelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="pfQty" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="pfPrice" type="number"></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="pfAdd">افزودن ردیف</button></div></div>${proformaLineHtml()}<div class="actions"><button class="btn red" id="pfSave">ثبت پیش‌فاکتور</button></div><div id="pfOut"></div></div></div></main>`);bindProductSearch('pf',(item)=>{state.proformaItem=item;$('#pfSelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#pfQ').value=item.itemDescription;}, {limit:120});$('#pfAdd').onclick=()=>{if(!state.proformaItem)return alert('کالا را انتخاب کن');const quantity=Number($('#pfQty').value||0),price=Number($('#pfPrice').value||0);if(quantity<=0||price<=0)return alert('تعداد و قیمت معتبر وارد کن');state.proformaLines.push({...state.proformaItem,quantity,price});state.proformaItem=null;$('#pfSelected').value='';$('#pfQ').value='';$('#pfQty').value='1';$('#pfPrice').value='';renderProformaLines()};renderProformaLines();$('#pfSave').onclick=async()=>{if(!state.proformaLines.length)return alert('ردیفی وجود ندارد');const r=await post('/api/proformas',{customerName:$('#pfCustomer').value,mobile:$('#pfMobile').value,leadId:$('#pfLead').value,items:state.proformaLines});$('#pfOut').innerHTML=r.ok?`<div class="success">پیش‌فاکتور ثبت شد: ${r.proforma.proformaNo}</div><a class="btn" target="_blank" href="/print/proforma/${r.proforma.proformaNo}">چاپ پیش‌فاکتور</a>`:`<div class="error">${esc(r.error||'خطا')}</div>`}}

/* PATCH 0.6.6: stable account search + flattened Shaygan AccountStatement rendering */
function bindAccountPicker(inputId,listId,onPick,opts={}){
  const input=$('#'+inputId), box=$('#'+listId);
  let cacheList=[];
  let cacheBaseToken='';
  let requestSeq=0;
  const limit=Number(opts.limit||100);
  function firstToken(q){return (tokensClient(q)[0]||'').trim();}
  function filterLocal(q){
    const tokens=tokensClient(q);
    if(!tokens.length)return [];
    return cacheList
      .filter(a=>accountMatchesClient(a,tokens))
      .sort((a,b)=>accountScoreClient(b,tokens)-accountScoreClient(a,tokens))
      .slice(0,limit);
  }
  async function liveSearch(q){
    const seq=++requestSeq;
    box.style.display='block';
    box.innerHTML='<div class="floating-empty">در حال جستجو در شایگان...</div>';
    popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-result'});
    let r=await api(`/api/accounts/search?q=${encodeURIComponent(q)}&limit=${limit}&pages=${opts.pages||220}`);
    if(seq!==requestSeq)return;
    let list=r.list||[];
    if(!list.length){
      const toks=tokensClient(q).sort((a,b)=>b.length-a.length);
      for(const t of toks){
        r=await api(`/api/accounts/search?q=${encodeURIComponent(t)}&limit=${limit}&pages=${opts.pages||220}`);
        list=r.list||[];
        if(list.length)break;
      }
    }
    cacheList=list;
    cacheBaseToken=firstToken(q);
    const filtered=filterLocal(q);
    renderAccountResults(box,filtered.length?filtered:list,onPick,input);
  }
  const search=debounce(async()=>{
    const q=input.value.trim();
    const tokens=tokensClient(q);
    if(q.length<2||!tokens.length){popupSuggestionController.close({restoreFocus:false});box.innerHTML='';cacheList=[];cacheBaseToken='';return;}
    const ft=firstToken(q);
    if(cacheList.length && cacheBaseToken && ft===cacheBaseToken){
      // Do not rescan Shaygan when user extends the same search. Filter current dropdown locally.
      renderAccountResults(box,filterLocal(q),onPick,input);
      return;
    }
    if(cacheList.length && cacheBaseToken && ft!==cacheBaseToken){cacheList=[];cacheBaseToken='';}
    await liveSearch(q);
  },350);
  input.addEventListener('input',search);
  input.addEventListener('keydown',async e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      const list=(box._lastList&&box._lastList.length)?box._lastList:filterLocal(input.value);
      if(list.length){
        const a=list[0];
        onPick({accountNumber:a.accountNumber,accountName:a.accountName,moinNumber:a.moinNumber,guId:a.guId||a.accountGuid||a.raw?.GuId||'',accountGuid:a.guId||a.accountGuid||a.raw?.GuId||'',raw:a.raw});
        popupSuggestionController.close();
        input.value=`${a.accountNumber} - ${a.accountName||''}`;
      }else if(input.value.trim().length>=2){await liveSearch(input.value.trim());}
    }
  });
}

async function pageTurnover(){
  setPage('گردش حساب',`<main class="main-content"><div class="card"><div class="card-header"><h5>گردش حساب</h5></div><div class="card-body"><div id="turnoverAccessMsg" class="small muted"></div><div class="row four"><div id="turnoverSelectWrap" class="form-group"><label>حساب‌های مجاز</label><div id="allowedAccountsBox" class="access-list"></div><select id="turnoverAccountSelect" style="display:none"><option value="">انتخاب حساب</option></select></div><div id="turnoverSearchWrap" class="form-group account-picker"><label>جستجوی حساب</label><input id="turnoverAccountSearch" placeholder="نام یا کد حساب؛ مثلا موذنی ۶۰"><div id="turnoverAccountResults" class="floating-list account-list"></div><input id="turnoverPicked" class="readonly mt6" readonly placeholder="حساب انتخاب‌شده"></div><div class="form-group"><label>از تاریخ شمسی، ۸ رقمی</label><input id="turnoverFrom" placeholder="14030501"></div><div class="form-group"><label>تا تاریخ شمسی، ۸ رقمی</label><input id="turnoverTo" placeholder="14030531"></div></div><button class="btn" id="loadTurnoverBtn">نمایش گردش</button><div id="turnoverOut" class="mt"></div></div></div></main>`);
  const r=await api('/api/account-access/my');
  const sel=$('#turnoverAccountSelect');
  const allowedBox=$('#allowedAccountsBox');
    let picked=''; let pickedName=''; let pickedGuid='';
  function setPicked(acc){
    picked=String(acc.accountNumber||'');
    pickedName=acc.accountName||'';
    pickedGuid=acc.guId||acc.accountGuid||acc.raw?.GuId||acc.raw?.GuID||'';
    $('#turnoverPicked').value=`${picked} - ${pickedName}`;
    sel.innerHTML=`<option value="${esc(picked)}">${esc(picked)} - ${esc(pickedName)}</option>`;
    sel.value=picked;
    $('#turnoverOut').innerHTML='';
  }
  function renderAllowed(list){
    if(!list.length){allowedBox.innerHTML='<div class="warn">هیچ حسابی برای مشاهده گردش شما تعریف نشده است. مدیر باید در صفحه کاربران یا تعریف صندوق/نماینده حساب مجاز ثبت کند.</div>';return;}
    allowedBox.innerHTML=list.map((a,i)=>`<button class="account-chip allowed-account" data-i="${i}"><b>${esc(a.accountNumber)}</b><span>${esc(a.accountName||'')}</span><small>${esc(a.source||'')}</small></button>`).join('');
    $$('.allowed-account').forEach(b=>b.onclick=()=>{const a=list[Number(b.dataset.i)];setPicked(a);$$('.allowed-account').forEach(x=>x.classList.remove('active'));b.classList.add('active');});
    if(list.length===1)setPicked(list[0]);
  }
  if(r.fullAccess){
    $('#turnoverAccessMsg').textContent='این گروه کاربری دسترسی کامل گردش حساب دارد. حساب را جستجو و انتخاب کن. با Enter اولین نتیجه انتخاب می‌شود.';
    $('#turnoverSelectWrap').style.display='none';
    bindAccountPicker('turnoverAccountSearch','turnoverAccountResults',setPicked,{limit:120,pages:220});
  }else{
    const list=r.list||[];
    $('#turnoverSearchWrap').style.display='none';
    $('#turnoverAccessMsg').textContent=list.length?'حساب‌های مجاز شما: روی یک حساب کلیک کن و سپس فیلتر تاریخ را بزن.':'هیچ حسابی برای مشاهده گردش شما تعریف نشده است.';
    renderAllowed(list);
  }
  $('#loadTurnoverBtn').onclick=async()=>{
    const accountNumber=picked||sel.value;
    if(!accountNumber){$('#turnoverOut').innerHTML='<div class="error">حساب را انتخاب کن.</div>';return;}
    $('#turnoverOut').innerHTML=`<div class="small muted">در حال دریافت گردش حساب ${esc(accountNumber)}...</div>`;
    const body={accountNumber,accountGuid:pickedGuid,dateFrom:cleanDate8($('#turnoverFrom').value.trim()),dateTo:cleanDate8($('#turnoverTo').value.trim())};
    const tr=await post('/admin/accounting/getTurnover',body);
    const rows=tr.list||tr.result||[];
    if(!tr.ok)return $('#turnoverOut').innerHTML=`<div class="error">${esc(tr.error||'خطا در خواندن گردش حساب')}</div><pre class="debug-pre">${esc(JSON.stringify(tr.diagnostics||tr.raw||{},null,2))}</pre>`;
    if(!rows.length)return $('#turnoverOut').innerHTML=`<div class="warn">گردشی برای ${esc(accountNumber)} ${pickedName?'- '+esc(pickedName):''} در این بازه پیدا نشد.</div><details><summary>جزئیات تست‌های شایگان</summary><pre class="debug-pre">${esc(JSON.stringify(tr.diagnostics||{},null,2))}</pre></details><div id="saleSellerDetailBox" class="mt"></div>`;
    let h=`<div class="success">${rows.length} ردیف گردش برای ${esc(accountNumber)} ${pickedName?'- '+esc(pickedName):''}</div><table class="table"><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>سند/فاکتور</th></tr></thead><tbody>`;
    h+=rows.map(x=>`<tr><td>${esc(toJalaliDisplay(x.Date||x.date||x.InvDate||x.DocDate||x.VouchDate||x.VoucherDate||''))}</td><td>${esc(x.RowDesc||x.Comment||x.Description||x.Desc||x.RowDescription||x.Detail||x.DetailDesc||'')}</td><td>${fmt(x.DebitAmount||x.Debit||x.Bedehkar||x.RialBed||x.CurrDebitAmount||0)}</td><td>${fmt(x.CreditAmount||x.Credit||x.Bestankar||x.RialBes||x.CurrCreditAmount||0)}</td><td>${fmt(x.RemainAccount||x.Remain||x.Balance||x.total||0)}</td><td>${esc(x.DocumentNumber||x.DocNo||x.SanadNo||x.VouchNumber||'')} / ${esc(x.InvNo||x.InvoiceNumber||'')}</td></tr>`).join('');
    $('#turnoverOut').innerHTML=h+'</tbody></table>';
  };
}


/* STAGE 0.7.0: Sales archive, proforma archive/convert, stable print flow */
async function pageProformaArchive(){
  setPage('آرشیو پیش‌فاکتورها',`<main class="main-content"><div class="card"><div class="card-header"><h5>آرشیو و پیگیری پیش‌فاکتورها</h5></div><div class="card-body"><div class="row four"><div class="form-group"><label>جستجو نام/موبایل/شماره</label><input id="pfArchiveQ" placeholder="مثلا 0915 یا نام مشتری یا شماره"></div><div class="form-group"><label>وضعیت</label><select id="pfArchiveStatus"><option value="">همه</option><option value="issued">ثبت‌شده</option><option value="converted">تبدیل‌شده</option><option value="cancelled">لغوشده</option></select></div><div class="form-group"><label>از تاریخ شمسی</label><input id="pfArchiveFrom" placeholder="14030501"></div><div class="form-group"><label>تا تاریخ شمسی</label><input id="pfArchiveTo" placeholder="14030531"></div></div><button class="btn" id="pfArchiveLoad">نمایش آرشیو</button><div id="pfArchiveList" class="mt"></div></div></div><div id="pfArchiveDetail"></div></main>`);
  $('#pfArchiveLoad').onclick=loadProformaArchive;
  await loadProformaArchive();
}
async function loadProformaArchive(){
  const q=($('#pfArchiveQ')?.value||'').trim(); const status=($('#pfArchiveStatus')?.value||'').trim();
  let url=`/api/proformas?limit=200${q?`&q=${encodeURIComponent(q)}`:''}${status?`&status=${encodeURIComponent(status)}`:''}`;
  const r=await api(url); const list=r.list||[];
  if(!list.length){$('#pfArchiveList').innerHTML='<div class="warn">پیش‌فاکتوری پیدا نشد.</div>';return;}
  let h='<table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>مشتری</th><th>موبایل</th><th>مبلغ</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>';
  h+=list.map(x=>`<tr><td>${esc(x.proformaNo)}</td><td>${esc(toJalaliDisplay(x.createdAt||''))}</td><td>${esc(x.customerName||'')}</td><td>${esc(x.mobile||'')}</td><td>${fmt(x.totalAmount||0)}</td><td>${esc(x.status||'')}</td><td><button class="mini open-pf" data-no="${esc(x.proformaNo)}">باز کردن</button> <a class="mini" target="_blank" href="/print/proforma/${encodeURIComponent(x.proformaNo)}">چاپ</a></td></tr>`).join('');
  $('#pfArchiveList').innerHTML=h+'</tbody></table>';
  $$('.open-pf').forEach(b=>b.onclick=()=>openProformaForConvert(b.dataset.no));
}
async function openProformaForConvert(no){
  const r=await api(`/api/proformas/${encodeURIComponent(no)}`); const pf=r.proforma;
  let h=`<div class="card"><div class="card-header"><h5>پیش‌فاکتور ${esc(pf.proformaNo)} - ${esc(pf.customerName||'')}</h5></div><div class="card-body"><div class="info">برای تبدیل به فاکتور، موجودی فعلی هر کالا دوباره از شایگان خوانده می‌شود. کالاهای بدون موجودی قابل تبدیل مستقیم نیستند.</div>`;
  h+=`<div class="row three mt"><div><b>مشتری:</b> ${esc(pf.customerName||'')}</div><div><b>موبایل:</b> ${esc(pf.mobile||'')}</div><div><b>وضعیت:</b> ${esc(pf.status||'')}</div></div>`;
  if(pf.status==='converted') h+=`<div class="success">این پیش‌فاکتور به فاکتور ${esc(pf.shayganInvoiceNo||'')} تبدیل شده است. <a target="_blank" href="/print/invoice/${esc(pf.shayganInvoiceNo||'')}">چاپ فاکتور</a></div>`;
  h+=`<div id="pfConvertRows" class="mt"><div class="small muted">در حال خواندن موجودی ردیف‌ها...</div></div>`;
  if(pf.status!=='converted') h+=`<div id="pfConvertMapping" class="mapping-box mt"></div><button class="btn red" id="convertPfBtn">تبدیل به فاکتور فروش</button><div id="convertPfOut"></div>`;
  h+='</div></div>';
  $('#pfArchiveDetail').innerHTML=h;
  const lines=[];
  for(let i=0;i<(pf.items||[]).length;i++){
    const it=pf.items[i]; let inv={ok:false,list:[]};
    try{inv=await api(`/api/items/${encodeURIComponent(it.itemCode)}/inventory`)}catch(e){inv={ok:false,list:[],error:e.message}}
    lines.push({...it, stocks:inv.list||[], selectedStock:(inv.list||[])[0]||null});
  }
  renderPfConvertRows(lines);
  if(pf.status!=='converted'){
    await renderPfConvertMapping();
    $('#convertPfBtn').onclick=()=>convertProforma(pf,lines);
  }
}
function renderPfConvertRows(lines){
  if(!lines.length){$('#pfConvertRows').innerHTML='<div class="warn">ردیفی وجود ندارد.</div>';return;}
  let h='<table class="table"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت</th><th>انتخاب انبار فعلی</th><th>وضعیت</th></tr></thead><tbody>';
  h+=lines.map((x,i)=>{const opts=(x.stocks||[]).map(s=>`<option value="${esc(s.stockNumber)}">${esc(s.stockNumber)} - ${esc(s.stockName)} | موجودی ${fmt(s.quantity)} | پایه ${fmt(s.averageCost)}</option>`).join(''); return `<tr><td>${esc(x.itemCode)}<br>${esc(x.itemDescription)}</td><td><input class="pf-conv-qty" data-i="${i}" type="number" value="${esc(x.quantity||1)}"></td><td><input class="pf-conv-price" data-i="${i}" type="number" value="${esc(x.price||0)}"></td><td>${x.stocks&&x.stocks.length?`<select class="pf-conv-stock" data-i="${i}">${opts}</select>`:'<span class="warntext">موجودی ندارد</span>'}</td><td>${x.stocks&&x.stocks.length?'<span class="oktext">قابل تبدیل</span>':'<span class="warntext">نیازمند تأمین/انتخاب کالا</span>'}</td></tr>`}).join('');
  $('#pfConvertRows').innerHTML=h+'</tbody></table>';
}
async function renderPfConvertMapping(){
  const box=$('#pfConvertMapping'); const maps=await ensureMappings();
  if(state.user?.role==='admin'){
    const selected=maps.find(m=>m.cashboxAccountNumber&&m.employeeAccountNumber)||maps[0];
    box.innerHTML=`<div class="form-group"><label>صادرکننده فاکتور</label><select id="pfConvertMappingSelect">${maps.map(m=>`<option value="${esc(m.username)}" ${selected&&selected.username===m.username?'selected':''}>${esc(mappingLabel(m))}</option>`).join('')}</select></div>`;
  }else{
    const m=maps.find(x=>x.username===state.user?.username)||state.user?.mapping;
    box.innerHTML=m&&m.cashboxAccountNumber&&m.employeeAccountNumber?`<div class="success">${esc(mappingLabel(m))}</div>`:`<div class="error">اتصال صندوق/نماینده برای کاربر شما کامل نیست.</div>`;
  }
}
async function convertProforma(pf,lines){
  try{
    const items=[];
    for(let i=0;i<lines.length;i++){
      const line=lines[i]; const stockSel=document.querySelector(`.pf-conv-stock[data-i="${i}"]`); if(!stockSel) continue;
      const stock=line.stocks.find(s=>String(s.stockNumber)===String(stockSel.value)); if(!stock) continue;
      const quantity=Number(document.querySelector(`.pf-conv-qty[data-i="${i}"]`)?.value||line.quantity||0);
      const price=Number(document.querySelector(`.pf-conv-price[data-i="${i}"]`)?.value||line.price||0);
      items.push({itemCode:line.itemCode,itemDescription:line.itemDescription,itemGuid:line.itemGuid||stock.itemGuid,stockNumber:stock.stockNumber,stockName:stock.stockName,stockGuid:stock.stockGuid,quantity,price});
    }
    if(!items.length)return $('#convertPfOut').innerHTML='<div class="error">هیچ ردیف دارای موجودی برای تبدیل انتخاب نشده است.</div>';
    const mappingUsername= state.user?.role==='admin' ? ($('#pfConvertMappingSelect')?.value||'') : state.user?.username;
    $('#convertPfOut').innerHTML='<div class="small muted">در حال تبدیل به فاکتور شایگان...</div>';
    const r=await post(`/api/proformas/${encodeURIComponent(pf.proformaNo)}/convert`,{items,mappingUsername});
    $('#convertPfOut').innerHTML=r.ok?`<div class="success">تبدیل شد. شماره فاکتور شایگان: ${esc(r.invoiceNumber||r.result?.Number||'')}</div><a class="btn" target="_blank" href="/print/invoice/${encodeURIComponent(r.invoiceNumber||r.result?.Number||'')}">چاپ فاکتور</a>`:`<div class="error">${esc(r.error||'خطا')}</div>`;
    await loadProformaArchive();
  }catch(e){$('#convertPfOut').innerHTML=`<div class="error">${esc(e.message)}</div>`}
}



/* STAGE 0.8.4: strict turnover account identity - full replacement */
function accountGuidOf(a){return a?.guId||a?.accountGuid||a?.AccountGuId||a?.raw?.GuId||a?.raw?.AccountGuId||''}
function accountKeyOfClient(a){const g=accountGuidOf(a);return g?`guid:${g}`:`acct:${a?.accountNumber||''}|${a?.moinNumber||''}|${a?.accountName||''}`}
async function pageTurnover(){
  setPage('گردش حساب',`<main class="main-content"><div class="card"><div class="card-header"><h5>گردش حساب</h5></div><div class="card-body"><div id="turnoverAccessMsg" class="small muted"></div><div class="row four"><div id="turnoverSelectWrap" class="form-group"><label>حساب‌های مجاز</label><div id="allowedAccountsBox" class="access-list"></div></div><div id="turnoverSearchWrap" class="form-group account-picker"><label>جستجوی حساب</label><input id="turnoverAccountSearch" placeholder="نام یا کد حساب؛ مثلا موذنی ۶۰" autocomplete="off"><div id="turnoverAccountResults" class="floating-list account-list"></div><input id="turnoverPicked" class="readonly mt6" readonly placeholder="حساب انتخاب‌شده"></div><div class="form-group"><label>از تاریخ شمسی، ۸ رقمی</label><input id="turnoverFrom" placeholder="14030501"></div><div class="form-group"><label>تا تاریخ شمسی، ۸ رقمی</label><input id="turnoverTo" placeholder="14030531"></div></div><button class="btn" id="loadTurnoverBtn">نمایش گردش</button><div id="turnoverOut" class="mt"></div></div></div></main>`);
  const r=await api('/api/account-access/my');
  const allowedBox=$('#allowedAccountsBox');
  const searchWrap=$('#turnoverSearchWrap');
  const input=$('#turnoverAccountSearch');
  const box=$('#turnoverAccountResults');
    let picked=null;
  let lastList=[];
  function labelAcc(a){return `${a.accountNumber||''} - ${a.accountName||''}${a.moinNumber?' | معین '+a.moinNumber:''}`}
  function setPicked(acc, source='search'){
    picked={accountNumber:String(acc.accountNumber||''), accountName:acc.accountName||'', moinNumber:acc.moinNumber||'', accountGuid:accountGuidOf(acc), guId:accountGuidOf(acc), accountKey:acc.accountKey||accountKeyOfClient(acc), source};
    $('#turnoverPicked').value=labelAcc(picked)+(picked.accountGuid?` | ${picked.accountGuid.slice(0,8)}`:'');
    $('#turnoverOut').innerHTML='';
  }
  function renderResults(list){
    lastList=list||[];
    box.style.display='block';
    if(!lastList.length){box.innerHTML='<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>';return;}
    box.innerHTML=lastList.map((a,i)=>`<div class="account-result" data-i="${i}"><b>${esc(a.accountName||'')}</b><span>${esc(a.accountNumber||'')}</span><small>${esc(a.moinNumber||'')}${accountGuidOf(a)?' | '+esc(accountGuidOf(a).slice(0,8)):''}</small></div>`).join('');
    box.querySelectorAll('.account-result').forEach(el=>el.onclick=()=>{const a=lastList[Number(el.dataset.i)];setPicked(a);input.value=labelAcc(a);box.style.display='none';});
  }
  function localFilter(q){const toks=tokensClient(q);if(!toks.length)return [];return (lastList||[]).map(a=>({...a,_score:toks.every(t=>normClient(`${a.accountNumber||''} ${a.accountName||''} ${a.moinNumber||''}`).includes(t))?1:-1})).filter(a=>a._score>=0)}
  const doSearch=debounce(async()=>{
    const q=input.value.trim();
    picked=null;$('#turnoverPicked').value='';
    if(q.length<2){box.style.display='none';box.innerHTML='';lastList=[];return;}
    // First try filtering the visible list if it still matches; this prevents flicker but never changes selected identity.
    const filtered=localFilter(q);
    if(filtered.length && lastList.length){renderResults(filtered);return;}
    box.style.display='block';box.innerHTML='<div class="floating-empty">در حال جستجو...</div>';
    try{const res=await api(`/api/accounts/search?q=${encodeURIComponent(q)}&limit=120&pages=220&strict=1`);renderResults(res.list||[]);}catch(e){box.innerHTML=`<div class="floating-empty">${esc(e.message)}</div>`;}
  },300);
  if(r.fullAccess){
    $('#turnoverAccessMsg').textContent='این گروه کاربری دسترسی کامل گردش حساب دارد. حساب را از لیست انتخاب کن؛ تا انتخاب قطعی انجام نشود، گردش نمایش داده نمی‌شود.';
    $('#turnoverSelectWrap').style.display='none';
    input.addEventListener('input',doSearch);
    input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();if(lastList.length){const a=lastList[0];setPicked(a,'enter-first');input.value=labelAcc(a);box.style.display='none';}}});
  }else{
    searchWrap.style.display='none';
    const list=r.list||[];
    $('#turnoverAccessMsg').textContent=list.length?'حساب‌های مجاز شما: روی یک حساب کلیک کن و سپس فیلتر تاریخ را بزن.':'هیچ حسابی برای مشاهده گردش شما تعریف نشده است.';
    allowedBox.innerHTML=list.length?list.map((a,i)=>`<button class="account-chip allowed-account" data-i="${i}"><b>${esc(a.accountNumber)}</b><span>${esc(a.accountName||'')}</span><small>${esc(a.source||'')}${accountGuidOf(a)?' | '+esc(accountGuidOf(a).slice(0,8)):''}</small></button>`).join(''):'<div class="warn">حساب مجاز تعریف نشده است.</div>';
    $$('.allowed-account').forEach(b=>b.onclick=()=>{const a=list[Number(b.dataset.i)];setPicked(a,'allowed');$$('.allowed-account').forEach(x=>x.classList.remove('active'));b.classList.add('active');});
    if(list.length===1)setPicked(list[0],'allowed-auto');
  }
  $('#loadTurnoverBtn').onclick=async()=>{
    if(!picked||!picked.accountNumber){$('#turnoverOut').innerHTML='<div class="error">حساب را از لیست انتخاب کن. تایپ کردن کافی نیست.</div>';return;}
    $('#turnoverOut').innerHTML=`<div class="small muted">در حال دریافت گردش حساب ${esc(picked.accountNumber)} - ${esc(picked.accountName||'')}...</div>`;
    const body={accountNumber:picked.accountNumber,accountName:picked.accountName,accountGuid:picked.accountGuid,accountKey:picked.accountKey,dateFrom:cleanDate8($('#turnoverFrom').value.trim()),dateTo:cleanDate8($('#turnoverTo').value.trim())};
    const tr=await post('/admin/accounting/getTurnover',body);
    const rows=tr.list||tr.result||[];
    const debug=`<details><summary>جزئیات تست‌های شایگان</summary><pre class="debug-pre">${esc(JSON.stringify({sent:body, diagnostics:tr.diagnostics||{}, domainUsed:tr.domainUsed||'', rawAccount:tr.raw?.Result?.[0]?{AccountNumber:tr.raw.Result[0].AccountNumber,AccountName:tr.raw.Result[0].AccountName,AccountGuId:tr.raw.Result[0].AccountGuId}:null},null,2))}</pre></details><div id="saleSellerDetailBox" class="mt"></div>`;
    if(!tr.ok)return $('#turnoverOut').innerHTML=`<div class="error">${esc(tr.error||'خطا در خواندن گردش حساب')}</div>${debug}`;
    if(!rows.length)return $('#turnoverOut').innerHTML=`<div class="warn">گردشی برای ${esc(picked.accountNumber)} - ${esc(picked.accountName||'')} در این بازه پیدا نشد یا شایگان حساب دیگری برگرداند که رد شد.</div>${debug}`;
    let h=`<div class="success">${rows.length} ردیف گردش برای ${esc(picked.accountNumber)} - ${esc(picked.accountName||'')}</div><table class="table"><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>سند/فاکتور</th></tr></thead><tbody>`;
    h+=rows.map(x=>`<tr><td>${esc(toJalaliDisplay(x.Date||x.date||x.InvDate||x.DocDate||x.VouchDate||x.VoucherDate||''))}</td><td>${esc(x.RowDesc||x.Comment||x.Description||x.Desc||x.RowDescription||x.Detail||x.DetailDesc||'')}</td><td>${fmt(x.DebitAmount||x.Debit||x.Bedehkar||x.RialBed||x.CurrDebitAmount||0)}</td><td>${fmt(x.CreditAmount||x.Credit||x.Bestankar||x.RialBes||x.CurrCreditAmount||0)}</td><td>${fmt(x.RemainAccount||x.Remain||x.Balance||x.total||0)}</td><td>${esc(x.DocumentNumber||x.DocNo||x.SanadNo||x.VouchNumber||'')} / ${esc(x.InvNo||x.InvoiceNumber||'')}</td></tr>`).join('');
    $('#turnoverOut').innerHTML=h+'</tbody></table>'+debug;
  };
}

async function route(){let p=location.hash.slice(1)||firstAllowedPage();if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}if(p==='dashboard')return dashboard();if(p==='stocks')return pageStocks();if(p==='cardex')return pageCardex();if(p==='sale')return pageSale();if(p==='proforma')return pageProforma();if(p==='proforma-list')return pageProformaArchive();if(p==='turnover')return pageTurnover();if(p==='account-set')return pageAccountSet();if(p==='users')return pageUsers();if(p==='seller-profit')return pageSellerProfit();if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();if(p==='customers')return pageCustomers();return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p)}


/* PATCH 0.7.1: seller invoice search + editable proforma */
async function ensureMappings(){
  if(state.mappings && state.mappings.length) return state.mappings;
  try{
    const r=await api('/api/user-mappings');
    state.mappings=r.list||[];
  }catch(e){
    state.mappings=[];
  }
  if((!state.mappings || !state.mappings.length) && state.user && state.user.mapping){
    state.mappings=[{
      username:state.user.username,
      fullName:state.user.fullName||state.user.username,
      role:state.user.role,
      cashboxAccountNumber:state.user.mapping.cashboxAccountNumber||'',
      employeeAccountNumber:state.user.mapping.employeeAccountNumber||'',
      storeName:state.user.mapping.storeName||'',
      isActive:true
    }];
  }
  return state.mappings||[];
}
async function renderSellerMappingBox(){
  const box=$('#sellerMappingBox');
  let mappings=[];
  try{mappings=await ensureMappings()}catch(e){mappings=[];}
  if(state.user?.role==='admin'){
    state.selectedMapping=mappings.find(m=>m.cashboxAccountNumber&&m.employeeAccountNumber)||mappings[0]||null;
    box.innerHTML=`<div class="form-group"><label>فروشنده/صندوق صادرکننده</label><select id="sellerMappingSelect">${mappings.map(m=>`<option value="${esc(m.username)}" ${state.selectedMapping&&m.username===state.selectedMapping.username?'selected':''}>${esc(mappingLabel(m))}</option>`).join('')}</select><div class="small muted">فروشنده امکان تغییر صندوق ندارد؛ ادمین برای تست می‌تواند صادرکننده را انتخاب کند.</div></div>`;
    const sel=$('#sellerMappingSelect'); if(sel) sel.onchange=()=>{state.selectedMapping=mappings.find(m=>m.username===sel.value)||null};
  }else{
    state.selectedMapping=mappings.find(m=>m.username===state.user?.username)||state.user?.mapping||null; // 0.9.19.26.3: no fallback to mappings[0] for non-admin
    if(!state.selectedMapping||!state.selectedMapping.cashboxAccountNumber||!state.selectedMapping.employeeAccountNumber){
      box.innerHTML=`<div class="error">اتصال صندوق/نماینده برای کاربر شما تعریف نشده است. مدیر باید در بخش تعریف صندوق/نماینده آن را تکمیل کند.</div>`;
    }else{
      box.innerHTML=`<div class="success">${esc(mappingLabel(state.selectedMapping))}</div>`;
    }
  }
}
async function pageSale(){
  state.saleLines=[];state.selectedItem=null;state.selectedStock=null;state.invoiceNumber=null;
  setPage('فاکتور فروش جدید',`<main class="main-content"><div class="card"><div class="card-header danger"><h5>فاکتور فروش جدید</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>نام خریدار</label><input id="buyerName"></div><div class="form-group"><label>موبایل</label><input id="buyerMobile"></div><div class="form-group"><label>کد ملی</label><input id="buyerNational"></div><div class="form-group"><label>Lead ID</label><input id="leadId"></div></div><div id="sellerMappingBox" class="mapping-box"></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا</h5></div><div class="card-body">${itemSearchWidget('sale')}<div id="saleInventory" class="mt"></div><div class="row three mt"><div class="form-group"><label>انبار انتخاب‌شده</label><input id="STNumber" readonly></div><div class="form-group"><label>تعداد</label><input id="Quan" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="Price" type="number"></div></div><div id="priceWarn"></div><div id="serialBox" class="mt"></div><div class="actions"><button class="btn green" id="addLineBtn">افزودن ردیف و رفتن به کالای بعدی</button></div><div id="saleLines" class="mt"></div><div class="actions"><button class="btn red" id="issueBtn">صدور فاکتور</button><div class="muted">شماره قطعی فاکتور در لحظه صدور مستقیم از شایگان خوانده و کنترل می‌شود.</div></div><div id="saleOut"></div></div></div></main>`);
  renderSellerMappingBox().catch(e=>{$('#sellerMappingBox').innerHTML=`<div class="error">خطا در خواندن اتصال صندوق/نماینده: ${esc(e.message)}</div>`});
  bindItemSearch('sale',item=>{state.selectedItem=item;renderInventory(item.itemCode,'#saleInventory',true)}, {showStocks:true,selectStock:true,onStockPick:(item,stock)=>selectSaleStock(item,stock),onEnter:(q)=>renderInventorySearch(q,'#saleInventory',true)});
  $('#Price').addEventListener('input',checkBelowCost);
  $('#addLineBtn').onclick=addSaleLine;
  renderSaleLines();
  const reserveBtn=$('#reserveBtn'); if(reserveBtn) reserveBtn.style.display='none';
  $('#issueBtn').onclick=issueSale;
}
function startProformaEdit(pf){
  location.hash='proforma';
  setTimeout(()=>{
    state.editingProformaNo=pf.proformaNo;
    state.proformaLines=(pf.items||[]).map(x=>({itemCode:x.itemCode,itemDescription:x.itemDescription,itemGuid:x.itemGuid||'',quantity:Number(x.quantity||1),price:Number(x.price||0)}));
    const title=document.querySelector('#pageTitle'); if(title) title.textContent=`ویرایش پیش‌فاکتور ${pf.proformaNo}`;
    const head=document.querySelector('.card-header h5'); if(head) head.textContent=`ویرایش پیش‌فاکتور ${pf.proformaNo}`;
    const save=$('#pfSave'); if(save) save.textContent='ذخیره تغییرات پیش‌فاکتور';
    if($('#pfCustomer')) $('#pfCustomer').value=pf.customerName||'';
    if($('#pfMobile')) $('#pfMobile').value=pf.mobile||'';
    if($('#pfLead')) $('#pfLead').value=pf.leadId||'';
    renderProformaLines();
  },100);
}
async function saveProformaOrUpdate(){
  if(!state.proformaLines.length)return alert('ردیفی وجود ندارد');
  const payload={customerName:$('#pfCustomer').value,mobile:$('#pfMobile').value,leadId:$('#pfLead').value,items:state.proformaLines};
  const isEdit=!!state.editingProformaNo;
  const r=isEdit?await api(`/api/proformas/${encodeURIComponent(state.editingProformaNo)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}):await post('/api/proformas',payload);
  if(r.ok){
    const no=(r.proforma&&r.proforma.proformaNo)||state.editingProformaNo;
    $('#pfOut').innerHTML=`<div class="success">${isEdit?'پیش‌فاکتور ویرایش شد':'پیش‌فاکتور ثبت شد'}: ${esc(no)}</div><a class="btn" target="_blank" href="/print/proforma/${encodeURIComponent(no)}">چاپ پیش‌فاکتور</a> <button class="btn" onclick="location.hash='proforma-list'">آرشیو پیش‌فاکتور</button>`;
    state.editingProformaNo=null;
  }else $('#pfOut').innerHTML=`<div class="error">${esc(r.error||'خطا')}</div>`;
}
async function pageProforma(){
  if(!state.editingProformaNo){state.proformaLines=[];state.proformaItem=null;}
  setPage('پیش‌فاکتور',`<main class="main-content"><div class="card"><div class="card-header"><h5>صدور پیش‌فاکتور</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>نام خریدار</label><input id="pfCustomer"></div><div class="form-group"><label>موبایل</label><input id="pfMobile"></div><div class="form-group"><label>Lead ID</label><input id="pfLead"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا، بدون محدودیت موجودی</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="pfQ" placeholder="مثلا all in one یا nb msi"><div id="pfMsg" class="small muted"></div><div id="pfList" class="floating-list"></div><input id="pfSelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="pfQty" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="pfPrice" type="number"></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="pfAdd">افزودن ردیف</button></div></div>${proformaLineHtml()}<div class="actions"><button class="btn red" id="pfSave">${state.editingProformaNo?'ذخیره تغییرات پیش‌فاکتور':'ثبت پیش‌فاکتور'}</button></div><div id="pfOut"></div></div></div></main>`);
  bindProductSearch('pf',(item)=>{state.proformaItem=item;$('#pfSelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#pfQ').value=item.itemDescription;}, {limit:120});
  $('#pfAdd').onclick=()=>{if(!state.proformaItem)return alert('کالا را انتخاب کن');const quantity=Number($('#pfQty').value||0),price=Number($('#pfPrice').value||0);if(quantity<=0||price<=0)return alert('تعداد و قیمت معتبر وارد کن');state.proformaLines.push({...state.proformaItem,quantity,price});state.proformaItem=null;$('#pfSelected').value='';$('#pfQ').value='';$('#pfQty').value='1';$('#pfPrice').value='';renderProformaLines()};
  renderProformaLines();
  $('#pfSave').onclick=saveProformaOrUpdate;
}
async function openProforma(no){
  const r=await api(`/api/proformas/${encodeURIComponent(no)}`); const pf=r.proforma;
  let h=`<div class="card"><div class="card-header"><h5>پیش‌فاکتور ${esc(pf.proformaNo)} - ${esc(pf.customerName||'')}</h5></div><div class="card-body"><div class="info">قبل از تبدیل به فاکتور، می‌توانی پیش‌فاکتور را ویرایش کنی یا موجودی فعلی هر ردیف را کنترل کنی.</div>`;
  h+=`<div class="actions"><button class="btn" id="editPfBtn">ویرایش پیش‌فاکتور</button><a class="btn" target="_blank" href="/print/proforma/${encodeURIComponent(pf.proformaNo)}">چاپ پیش‌فاکتور</a></div>`;
  h+=`<table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>${(pf.items||[]).map(x=>`<tr><td>${esc(x.itemCode)}</td><td>${esc(x.itemDescription)}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.price)}</td><td>${fmt(Number(x.quantity||0)*Number(x.price||0))}</td></tr>`).join('')}</tbody></table><h5>تبدیل به فاکتور فروش</h5><div id="pfConvertRows">در حال بررسی موجودی...</div>`;
  if(pf.status!=='converted') h+=`<div id="pfConvertMapping" class="mapping-box mt"></div><button class="btn red" id="convertPfBtn">تبدیل به فاکتور فروش</button><div id="convertPfOut"></div>`;
  h+='</div></div>';
  $('#pfArchiveDetail').innerHTML=h;
  $('#editPfBtn').onclick=()=>startProformaEdit(pf);
  const lines=[];
  for(let i=0;i<(pf.items||[]).length;i++){
    const it=pf.items[i]; let inv={ok:false,list:[]};
    try{inv=await api(`/api/items/${encodeURIComponent(it.itemCode)}/inventory`)}catch(e){inv={ok:false,list:[],error:e.message}}
    lines.push({...it, stocks:inv.list||[], selectedStock:(inv.list||[])[0]||null});
  }
  renderPfConvertRows(lines);
  if(pf.status!=='converted'){
    await renderPfConvertMapping();
    $('#convertPfBtn').onclick=()=>convertProforma(pf,lines);
  }
}

/* PATCH 0.7.2: editable proforma line item fix - allow changing product/qty/price before conversion */
function resetProformaLineEditor(){
  state.proformaEditIndex=null;
  state.proformaItem=null;
  const q=$('#pfQ'), selected=$('#pfSelected'), qty=$('#pfQty'), price=$('#pfPrice'), add=$('#pfAdd');
  if(q) q.value='';
  if(selected) selected.value='';
  if(qty) qty.value='1';
  if(price) price.value='';
  if(add){ add.textContent='افزودن ردیف'; add.classList.add('green'); add.classList.remove('red'); }
  const cancel=$('#pfCancelEdit'); if(cancel) cancel.style.display='none';
}
function loadProformaLineForEdit(index){
  const line=(state.proformaLines||[])[index];
  if(!line) return;
  state.proformaEditIndex=index;
  state.proformaItem={ itemCode:line.itemCode, itemDescription:line.itemDescription, itemGuid:line.itemGuid||'' };
  $('#pfQ').value=line.itemDescription||line.itemCode||'';
  $('#pfSelected').value=`${line.itemCode||''} - ${line.itemDescription||''}`;
  $('#pfQty').value=Number(line.quantity||1);
  $('#pfPrice').value=Number(line.price||0);
  $('#pfAdd').textContent='ذخیره تغییر ردیف';
  $('#pfAdd').classList.remove('green'); $('#pfAdd').classList.add('red');
  const cancel=$('#pfCancelEdit'); if(cancel) cancel.style.display='inline-block';
  window.scrollTo({top:0,behavior:'smooth'});
}
function proformaTotals(){
  const lines=state.proformaLines||[];
  return lines.reduce((acc,x)=>{
    const q=Number(x.quantity||0);
    const p=Number(x.price||0);
    acc.count += 1;
    acc.qty += q;
    acc.total += q*p;
    return acc;
  },{count:0,qty:0,total:0});
}
function proformaSummaryHtml(){
  const t=proformaTotals();
  return `<div class="pf-live-total"><span>تعداد ردیف: <b>${fmt(t.count)}</b></span><span>جمع تعداد: <b>${fmt(t.qty)}</b></span><span>جمع کل پیش‌فاکتور: <b>${fmt(t.total)}</b></span></div>`;
}
function renderProformaLines(){
  const box=$('#proformaLines');
  if(!box) return;
  if(!state.proformaLines) state.proformaLines=[];
  if(!state.proformaLines.length){
    box.innerHTML='<div class="small muted">هنوز ردیفی اضافه نشده است.</div>'+proformaSummaryHtml();
    return;
  }
  const t=proformaTotals();
  let h='<table class="table"><thead><tr><th>ردیف</th><th>کد</th><th>کالا</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th><th>عملیات</th></tr></thead><tbody>';
  h+=state.proformaLines.map((x,i)=>`<tr class="${state.proformaEditIndex===i?'row-editing':''}"><td>${i+1}</td><td>${esc(x.itemCode||'')}</td><td>${esc(x.itemDescription||'')}</td><td>${fmt(x.quantity||0)}</td><td>${fmt(x.price||0)}</td><td>${fmt(Number(x.quantity||0)*Number(x.price||0))}</td><td><button class="mini pf-line-edit" data-i="${i}">ویرایش</button> <button class="mini proforma-del" data-i="${i}">حذف</button></td></tr>`).join('');
  h += `</tbody><tfoot><tr class="pf-total-row"><th colspan="3">جمع ردیف‌ها</th><th>${fmt(t.qty)}</th><th></th><th>${fmt(t.total)}</th><th></th></tr></tfoot></table>`;
  box.innerHTML=h+proformaSummaryHtml();
  $$('.pf-line-edit').forEach(b=>b.onclick=()=>loadProformaLineForEdit(Number(b.dataset.i)));
  $$('.proforma-del').forEach(b=>b.onclick=()=>{
    const idx=Number(b.dataset.i);
    if(!confirm('این ردیف حذف شود؟')) return;
    state.proformaLines.splice(idx,1);
    if(state.proformaEditIndex===idx) resetProformaLineEditor();
    if(state.proformaEditIndex>idx) state.proformaEditIndex--;
    renderProformaLines();
  });
}
function addOrUpdateProformaLine(){
  if(!state.proformaItem) return alert('کالا را انتخاب کن');
  const quantity=Number($('#pfQty').value||0), price=Number($('#pfPrice').value||0);
  if(quantity<=0||price<=0) return alert('تعداد و قیمت معتبر وارد کن');
  const line={...state.proformaItem, quantity, price};
  if(Number.isInteger(state.proformaEditIndex) && state.proformaEditIndex>=0){
    state.proformaLines[state.proformaEditIndex]=line;
  }else{
    state.proformaLines.push(line);
  }
  resetProformaLineEditor();
  renderProformaLines();
}
async function pageProforma(){
  if(!state.editingProformaNo){ state.proformaLines=[]; state.proformaItem=null; state.proformaEditIndex=null; }
  setPage('پیش‌فاکتور',`<main class="main-content"><div class="card"><div class="card-header"><h5>${state.editingProformaNo?'ویرایش پیش‌فاکتور '+esc(state.editingProformaNo):'صدور پیش‌فاکتور'}</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>نام خریدار</label><input id="pfCustomer"></div><div class="form-group"><label>موبایل</label><input id="pfMobile"></div><div class="form-group"><label>Lead ID</label><input id="pfLead"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن / ویرایش کالا، بدون محدودیت موجودی</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="pfQ" placeholder="مثلا all in one یا nb msi"><div id="pfMsg" class="small muted"></div><div id="pfList" class="floating-list"></div><input id="pfSelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="pfQty" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="pfPrice" type="number"></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="pfAdd">افزودن ردیف</button> <button class="btn" id="pfCancelEdit" style="display:none">انصراف از ویرایش ردیف</button></div></div>${proformaLineHtml()}<div class="actions"><button class="btn red" id="pfSave">${state.editingProformaNo?'ذخیره تغییرات پیش‌فاکتور':'ثبت پیش‌فاکتور'}</button></div><div id="pfOut"></div></div></div></main>`);
  bindProductSearch('pf',(item)=>{state.proformaItem=item;$('#pfSelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#pfQ').value=item.itemDescription;}, {limit:120});
  $('#pfAdd').onclick=addOrUpdateProformaLine;
  $('#pfCancelEdit').onclick=resetProformaLineEditor;
  renderProformaLines();
  $('#pfSave').onclick=saveProformaOrUpdate;
}
function startProformaEdit(pf){
  if(pf.status==='converted') return alert('پیش‌فاکتور تبدیل‌شده قابل ویرایش نیست.');
  location.hash='proforma';
  setTimeout(()=>{
    state.editingProformaNo=pf.proformaNo;
    state.proformaEditIndex=null;
    state.proformaLines=(pf.items||[]).map(x=>({itemCode:x.itemCode,itemDescription:x.itemDescription,itemGuid:x.itemGuid||'',quantity:Number(x.quantity||1),price:Number(x.price||0)}));
    pageProforma().then(()=>{
      if($('#pfCustomer')) $('#pfCustomer').value=pf.customerName||'';
      if($('#pfMobile')) $('#pfMobile').value=pf.mobile||'';
      if($('#pfLead')) $('#pfLead').value=pf.leadId||'';
      renderProformaLines();
    });
  },50);
}
async function openProformaForConvert(no){
  const r=await api(`/api/proformas/${encodeURIComponent(no)}`); const pf=r.proforma;
  let h=`<div class="card"><div class="card-header"><h5>پیش‌فاکتور ${esc(pf.proformaNo)} - ${esc(pf.customerName||'')}</h5></div><div class="card-body"><div class="info">قبل از تبدیل به فاکتور، در صورت نیاز پیش‌فاکتور را ویرایش کن؛ هنگام تبدیل موجودی هر ردیف دوباره از شایگان خوانده می‌شود.</div>`;
  h+=`<div class="row three mt"><div><b>مشتری:</b> ${esc(pf.customerName||'')}</div><div><b>موبایل:</b> ${esc(pf.mobile||'')}</div><div><b>وضعیت:</b> ${esc(pf.status||'')}</div></div>`;
  if(pf.status!=='converted') h+=`<div class="actions"><button class="btn" id="editPfBtn">ویرایش پیش‌فاکتور</button><a class="btn" target="_blank" href="/print/proforma/${encodeURIComponent(pf.proformaNo)}">چاپ پیش‌فاکتور</a></div>`;
  else h+=`<div class="success">این پیش‌فاکتور به فاکتور ${esc(pf.shayganInvoiceNo||'')} تبدیل شده است. <a target="_blank" href="/print/invoice/${esc(pf.shayganInvoiceNo||'')}">چاپ فاکتور</a></div>`;
  h+=`<table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>${(pf.items||[]).map(x=>`<tr><td>${esc(x.itemCode)}</td><td>${esc(x.itemDescription)}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.price)}</td><td>${fmt(Number(x.quantity||0)*Number(x.price||0))}</td></tr>`).join('')}</tbody></table><h5>تبدیل به فاکتور فروش</h5><div id="pfConvertRows">در حال بررسی موجودی...</div>`;
  if(pf.status!=='converted') h+=`<div id="pfConvertMapping" class="mapping-box mt"></div><button class="btn red" id="convertPfBtn">تبدیل به فاکتور فروش</button><div id="convertPfOut"></div>`;
  h+='</div></div>';
  $('#pfArchiveDetail').innerHTML=h;
  if(pf.status!=='converted') $('#editPfBtn').onclick=()=>startProformaEdit(pf);
  const lines=[];
  for(let i=0;i<(pf.items||[]).length;i++){
    const it=pf.items[i]; let inv={ok:false,list:[]};
    try{inv=await api(`/api/items/${encodeURIComponent(it.itemCode)}/inventory`)}catch(e){inv={ok:false,list:[],error:e.message}}
    lines.push({...it, stocks:inv.list||[], selectedStock:(inv.list||[])[0]||null});
  }
  renderPfConvertRows(lines);
  if(pf.status!=='converted'){
    await renderPfConvertMapping();
    $('#convertPfBtn').onclick=()=>convertProforma(pf,lines);
  }
}
if(typeof window!=='undefined'){
  window.__MKCRM_PATCH_VERSION='0.8.0-search-performance-stage';
}


/* PATCH 0.8.0: search performance control - local filtering + cache sync tools */
(function(){
  const PERF_VERSION='0.8.0-search-performance-stage';
  window.__MKCRM_PATCH_VERSION=PERF_VERSION;

  function _productText(x){ return `${x.ItemCode||x.itemCode||''} ${x.ItemDesc||x.itemDescription||''}`; }
  function _productMatches(x,tokens){ const hay=normClient(_productText(x)); return tokens.every(t=>hay.includes(normClient(t))); }
  function _productScore(x,tokens){ const hay=normClient(_productText(x)); const code=normClient(x.ItemCode||x.itemCode||''); let score=0; for(const t of [...new Set(tokens.map(normClient))]){ if(code===t)score+=10000; else if(code.startsWith(t))score+=5000; else if(code.includes(t))score+=2200; if(hay.startsWith(t))score+=1600; else if(hay.includes(t))score+=Math.max(100,900-hay.indexOf(t)); } score-=Math.min(hay.length,400)/35; return score; }
  function _filterProducts(list,q,limit){ const tokens=tokensClient(q); if(!tokens.length)return []; return (list||[]).filter(x=>_productMatches(x,tokens)).sort((a,b)=>_productScore(b,tokens)-_productScore(a,tokens)).slice(0,limit||120); }

  window.bindProductSearch = bindProductSearch = function(prefix, onPick, opts={}){
    const q=$(`#${prefix}Q`), box=$(`#${prefix}List`), msg=$(`#${prefix}Msg`);
    let cacheList=[], lastQuery='', requestSeq=0, requestController=null;
    const limit=Number(opts.limit||120);
    const managedPopup=true;
    uiPageLifecycle.add(()=>{requestSeq++;if(requestController)requestController.abort();requestController=null;});
    async function live(qv){
      const seq=++requestSeq;
      if(requestController)requestController.abort();requestController=new AbortController();
      box.style.display='block'; box.innerHTML='<div class="floating-empty">در حال جستجو...</div>'; if(msg)msg.textContent='در حال جستجو...';
      if(managedPopup)popupSuggestionController.open({popup:box,trigger:q,optionSelector:'.product-row'});
      let r;try{r=await searchAllItemsRows(qv,limit,false,{signal:requestController.signal});}catch(e){if(e.name==='AbortError')return [];throw e;}
      if(seq!==requestSeq) return [];
      cacheList=r.list||[]; lastQuery=qv;
      const list=_filterProducts(cacheList,qv,limit).length?_filterProducts(cacheList,qv,limit):cacheList;
      render(list,r);
      return list;
    }
    function render(items,r={}){
      if(msg) msg.textContent=`${(items||[]).length} کالا | ${r.source||'cache/local'}${r.cacheCount?' | کش: '+r.cacheCount:''}${r.scannedPages?' | '+r.scannedPages+' صفحه':''}${r.note?' | '+r.note:''}`;
      box.style.display='block';
      box.innerHTML=(items||[]).map(x=>`<div class="product-row" data-code="${esc(x.ItemCode||x.itemCode)}" data-desc="${esc(x.ItemDesc||x.itemDescription)}" data-guid="${esc(x.ItemGuId||x.itemGuid||'')}"><b>${esc(x.ItemDesc||x.itemDescription)}</b><div class="small muted">کد: ${esc(x.ItemCode||x.itemCode)}</div></div>`).join('') || '<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>';
      box.querySelectorAll('.product-row').forEach(el=>el.onclick=()=>{const item={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription}`;if(managedPopup)popupSuggestionController.close();else box.style.display='none';onPick(item,items)});
      if(managedPopup)popupSuggestionController.open({popup:box,trigger:q,optionSelector:'.product-row'});
    }
    const search=debounce(async()=>{
      const val=q.value.trim(); const tokens=tokensClient(val);
      if(val.length<2||!tokens.length){if(managedPopup)popupSuggestionController.close({restoreFocus:false});else box.style.display='none';box.innerHTML='';if(msg)msg.textContent='';return;}
      if(cacheList.length){ const filtered=_filterProducts(cacheList,val,limit); if(filtered.length){render(filtered,{source:'client-filter'}); return;} }
      await live(val);
    },220);
    q.addEventListener('input',search);
    q.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault(); const val=q.value.trim(); const items=cacheList.length?_filterProducts(cacheList,val,limit):await live(val); box.style.display='none'; if(opts.onEnter) opts.onEnter(val,items); else if(items.length===1){const x=items[0];onPick({itemCode:x.ItemCode||x.itemCode,itemDescription:x.ItemDesc||x.itemDescription,itemGuid:x.ItemGuId||x.itemGuid||''},items)}}});
  };

  function _stockMatches(row,tokens){ const hay=normClient(`${row.itemCode||row.ItemCode||''} ${row.itemDescription||row.ItemDesc||''} ${row.stockNumber||row.STNumber||''} ${row.stockName||row.StDesc||''}`); return tokens.every(t=>hay.includes(normClient(t))); }
  function _stockScore(row,tokens){ const hay=normClient(`${row.itemCode||row.ItemCode||''} ${row.itemDescription||row.ItemDesc||''} ${row.stockNumber||row.STNumber||''} ${row.stockName||row.StDesc||''}`); let score=0; for(const t of [...new Set(tokens.map(normClient))]){ if(hay.startsWith(t))score+=1500; else if(hay.includes(t))score+=Math.max(100,800-hay.indexOf(t)); } score+=Number(row.quantity||row.RemainQ||0); return score; }
  function _filterStockRows(rows,q,stockFilter,limit){ const tokens=tokensClient(q); let list=(rows||[]); if(stockFilter) list=list.filter(x=>String(x.stockNumber||x.STNumber)===String(stockFilter)); if(tokens.length) list=list.filter(x=>_stockMatches(x,tokens)).sort((a,b)=>_stockScore(b,tokens)-_stockScore(a,tokens)); return list.slice(0,limit||300); }

  window.bindItemSearch = bindItemSearch = function(prefix,onPick,opts={}){
    const q=$(`#${prefix}Q`), box=$(`#${prefix}List`), msg=$(`#${prefix}Msg`); let cacheRows=[], lastStock='', lastGroups=[]; const limit=Number(opts.limit||300);
    const managedPopup=prefix==='stock'||prefix==='cardex';
    function renderRows(rows,r={}){ let filtered=_filterStockRows(rows,q.value.trim(),opts.getStockFilter?opts.getStockFilter():'',limit); const groups=groupStockRows(filtered); lastGroups=groups; if(msg)msg.textContent=`${groups.length} کالا | ${filtered.length} ردیف انبار | ${r.source||'client-filter'}${r.scannedPages?' | '+r.scannedPages+' صفحه':''}`; box.style.display='block'; box.innerHTML=groups.map(g=>renderStockGroupHtml(g,opts)).join('') || '<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>'; box.querySelectorAll('.stock-group').forEach(el=>el.onclick=(ev)=>{if(ev.target.classList.contains('choose-stock-row'))return;const item={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription}`;if(managedPopup)popupSuggestionController.close();else box.style.display='none';onPick(item, groups.find(g=>g.itemCode===item.itemCode))}); box.querySelectorAll('.choose-stock-row').forEach(btn=>btn.onclick=(ev)=>{ev.stopPropagation();const raw=JSON.parse(btn.dataset.row);const {item,stock}=rawToItemStock(raw);$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription} | ${stock.stockNumber} - ${stock.stockName}`;if(managedPopup)popupSuggestionController.close();else box.style.display='none';if(opts.onStockPick) opts.onStockPick(item,stock); else onPick(item,{rows:[raw],total:stock.quantity})}); if(managedPopup)popupSuggestionController.open({popup:box,trigger:q,optionSelector:'.stock-group'}); return groups; }
    async function liveSearch(){ const val=q.value.trim(); const stock=opts.getStockFilter?opts.getStockFilter():''; box.style.display='block'; box.innerHTML='<div class="floating-empty">در حال جستجو...</div>'; if(msg)msg.textContent='در حال جستجو...'; if(managedPopup)popupSuggestionController.open({popup:box,trigger:q,optionSelector:'.stock-group'}); const r=await searchStockRows(val, limit, stock); cacheRows=r.list||[]; lastStock=stock; return renderRows(cacheRows,r); }
    const search=debounce(async()=>{ const val=q.value.trim(); if(val.length<2){if(managedPopup)popupSuggestionController.close({restoreFocus:false});else box.style.display='none';box.innerHTML='';if(msg)msg.textContent='';return;} const stock=opts.getStockFilter?opts.getStockFilter():''; if(cacheRows.length && stock===lastStock){ const groups=renderRows(cacheRows,{source:'client-filter'}); if(groups.length) return; } await liveSearch(); },220);
    q.addEventListener('input',search);
    q.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault(); const stock=opts.getStockFilter?opts.getStockFilter():''; const groups=(cacheRows.length&&stock===lastStock)?renderRows(cacheRows,{source:'client-filter'}):await liveSearch(); box.style.display='none'; if(opts.onEnter) opts.onEnter(q.value.trim(),groups); else if(groups.length===1){const g=groups[0];onPick({itemCode:g.itemCode,itemDescription:g.itemDescription,itemGuid:g.itemGuid},g)}}});
    if(!managedPopup)document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==q)box.style.display='none'});
    if(opts.filterElement){opts.filterElement.addEventListener('change',()=>{lastGroups=[]; if(q.value.trim().length>=2) liveSearch();});}
  };

  const _oldReports=pageReports;
  window.pageReports = pageReports = async function(){
    setPage('تست‌ها و گزارش',`<div class="card"><h3>ابزار کنترل‌شده</h3><div class="card-body"><div class="info">نسخه: ${PERF_VERSION}</div><button class="btn" id="h">Health</button><button class="btn" id="ver">Version</button><button class="btn" id="status">Search Status</button><button class="btn" id="last">آخرین شماره فروش</button><button class="btn red" id="sync">Sync Inventory Catalog</button><button class="btn red" id="syncAll">Sync All Items Catalog برای کاردکس/پیش‌فاکتور</button><button class="btn red" id="syncAccounts">Sync Accounts Catalog برای گردش حساب</button><button class="btn" id="testNb">تست nb msi / msi nb</button><button class="btn" id="testAccount">تست موذنی / ۶۰ موذنی</button><pre id="out"></pre></div></div>`);
    $('#h').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/shaygan/health'),null,2);
    $('#ver').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/version'),null,2);
    $('#status').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/search/status'),null,2);
    $('#last').onclick=async()=>$('#out').textContent=JSON.stringify(await api('/api/invoices/last-sale'),null,2);
    $('#sync').onclick=async()=>$('#out').textContent=JSON.stringify(await post('/api/catalog/sync?pages=300',{}),null,2);
    $('#syncAll').onclick=async()=>$('#out').textContent=JSON.stringify(await post('/api/catalog/sync-all-items?pages=all',{}),null,2);
    $('#syncAccounts').onclick=async()=>$('#out').textContent=JSON.stringify(await post('/api/catalog/sync-accounts?pages=220',{}),null,2);
    $('#testNb').onclick=async()=>$('#out').textContent=JSON.stringify({a:await api('/api/items/search?q=nb%20msi&limit=20'),b:await api('/api/items/search?q=msi%20nb&limit=20')},null,2);
    $('#testAccount').onclick=async()=>$('#out').textContent=JSON.stringify({a:await api('/api/accounts/search?q=%D9%85%D9%88%D8%B0%D9%86%DB%8C&limit=20'),b:await api('/api/accounts/search?q=60%20%D9%85%D9%88%D8%B0%D9%86%DB%8C&limit=20')},null,2);
  };
})();

/* PATCH 0.8.8: operational UI integration from 0.8.4 baseline. Turnover logic is intentionally frozen. */
(function(){
  const OP_VERSION = '0.8.8-doc-control-purchase-operational-from-084';
  window.__MKCRM_PATCH_VERSION = OP_VERSION;
  try{
    ['admin','accounting','warehouse','purchase','seller_buyer'].forEach(r=>{
      if(ROLE_PAGES[r] !== 'all' && Array.isArray(ROLE_PAGES[r])){
        ['buy','purchase-drafts'].forEach(p=>{ if(!ROLE_PAGES[r].includes(p)) ROLE_PAGES[r].push(p); });
      }
    });
    ['admin','accounting','warehouse','purchase'].forEach(r=>{
      if(ROLE_PAGES[r] !== 'all' && Array.isArray(ROLE_PAGES[r]) && !ROLE_PAGES[r].includes('app-logs')) ROLE_PAGES[r].push('app-logs');
    });
  }catch(e){console.warn('role page patch warning',e)}

  window.renderMenu = renderMenu = function(){
    const newMenu = [
      ['حسابداری / شایگان', [
        ['sale','فاکتور فروش جدید'],
        ['proforma','پیش‌فاکتور'],
        ['proforma-list','آرشیو پیش‌فاکتور'],
        ['buy','فاکتور خرید جدید'],
        ['purchase-drafts','آرشیو پیش‌نویس خرید'],
        ['stocks','موجودی انبارها'],
        ['cardex','کاردکس کالا'],
        ['inv-sale','فاکتورهای فروش'],
        ['inv-buy','فاکتورهای خرید'],
        ['turnover','گردش حساب'],
        ['account-set','تعریف صندوق/نماینده']
      ]],
      ['CRM', [
        ['customers','مشتریان'],
        ['leads','Lead ID'],
        ['reservations','رزرو شماره']
      ]],
      ['مدیریت', [
        ['settings','تنظیمات'],
        ['users','کاربران'],
        ['roles','نقش‌ها'],
        ['reports','تست‌ها'],
        ['app-logs','لاگ عملیات']
      ]]
    ];
    let h=''; const role=userRole();
    newMenu.forEach(([g,items])=>{ const allowedItems=items.filter(([id])=>canPage(id)); if(!allowedItems.length)return; h+=`<div class="menu-group">${g}</div>`; allowedItems.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`); });
    $('#menu').innerHTML=h;
    $$('.navbtn').forEach(b=>b.onclick=()=>{location.hash=b.dataset.page; route();});
    const chip=document.querySelector('.user-chip');
    if(chip) chip.innerHTML=`${esc(state.user?.fullName||state.user?.username||'')}<br><small>${esc(ROLE_LABELS[role]||role)}</small><br><small>${OP_VERSION}</small>`;
  };

  function purchaseLineHtml(){return `<div id="purchaseLines" class="mt"></div>`}
  function renderPurchaseLines(){
    const box=$('#purchaseLines'); if(!box)return;
    const lines=state.purchaseLines||[];
    if(!lines.length){box.innerHTML='<div class="muted">هنوز ردیفی اضافه نشده است.</div>';return;}
    const rows=lines.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.itemCode)}</td><td>${esc(x.itemDescription)}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.price)}</td><td>${fmt(Number(x.quantity)*Number(x.price))}</td><td><button class="btn small danger" data-del="${i}">حذف</button></td></tr>`).join('');
    const total=lines.reduce((s,x)=>s+Number(x.quantity||0)*Number(x.price||0),0);
    box.innerHTML=`<table class="table"><thead><tr><th>#</th><th>کد</th><th>کالا</th><th>تعداد</th><th>قیمت خرید</th><th>مبلغ</th><th></th></tr></thead><tbody>${rows}</tbody></table><div class="total">جمع: ${fmt(total)} ریال</div>`;
    box.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{state.purchaseLines.splice(Number(b.dataset.del),1);renderPurchaseLines();});
  }
  window.pagePurchaseDraft = pagePurchaseDraft = async function(){
    state.purchaseLines=[]; state.purchaseItem=null;
    setPage('فاکتور خرید جدید', `<main class="main-content"><div class="card"><div class="card-header"><h5>پیش‌نویس فاکتور خرید</h5></div><div class="card-body"><div class="info">این فاز فقط پیش‌نویس داخلی می‌سازد و در شایگان سند خرید ثبت نمی‌کند.</div><div class="row three"><div class="form-group"><label>نام تأمین‌کننده</label><input id="buySupplier"></div><div class="form-group"><label>موبایل / تماس</label><input id="buyMobile"></div><div class="form-group"><label>توضیحات</label><input id="buyDesc"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="buyQ" placeholder="نام یا کد کالا"><div id="buyMsg" class="small muted"></div><div id="buyList" class="floating-list"></div><input id="buySelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="buyQty" type="number" value="1"></div><div class="form-group"><label>قیمت خرید</label><input id="buyPrice" type="number"></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="buyAdd">افزودن ردیف</button></div></div>${purchaseLineHtml()}<div class="actions"><button class="btn red" id="buySave">ذخیره پیش‌نویس خرید</button></div><div id="buyOut"></div></div></div></main>`);
    bindProductSearch('buy',(item)=>{state.purchaseItem=item;$('#buySelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#buyQ').value=item.itemDescription;},{limit:120});
    $('#buyAdd').onclick=()=>{ if(!state.purchaseItem)return alert('کالا را انتخاب کن'); const quantity=Number($('#buyQty').value||0), price=Number($('#buyPrice').value||0); if(quantity<=0||price<0)return alert('تعداد و قیمت معتبر وارد کن'); state.purchaseLines.push({...state.purchaseItem,quantity,price}); state.purchaseItem=null; $('#buySelected').value=''; $('#buyQ').value=''; $('#buyQty').value='1'; $('#buyPrice').value=''; renderPurchaseLines(); };
    renderPurchaseLines();
    $('#buySave').onclick=async()=>{ if(!state.purchaseLines.length)return alert('ردیفی وجود ندارد'); const payload={supplierName:$('#buySupplier').value,supplierMobile:$('#buyMobile').value,description:$('#buyDesc').value,items:state.purchaseLines}; try{const r=await post('/api/purchase-drafts',payload); $('#buyOut').innerHTML=r.ok?`<div class="success">پیش‌نویس خرید ذخیره شد: ${r.draft.purchaseDraftNo}</div>`:`<div class="error">${esc(r.error||'خطا')}</div>`;}catch(e){$('#buyOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;} };
  };

  window.pagePurchaseDraftArchive = pagePurchaseDraftArchive = async function(){
    setPage('آرشیو پیش‌نویس خرید', `<main class="main-content"><div class="card"><div class="card-header"><h5>آرشیو پیش‌نویس خرید</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>جستجو</label><input id="pdQ" placeholder="شماره، تأمین‌کننده، توضیحات"></div><div class="form-group"><label>وضعیت</label><select id="pdStatus"><option value="">همه</option><option value="draft">پیش‌نویس</option><option value="cancelled">لغوشده</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="pdLoad">نمایش</button></div></div><div id="pdList">در حال بارگذاری...</div></div></div></main>`);
    async function load(){ const q=$('#pdQ').value||'', status=$('#pdStatus').value||''; const r=await api(`/api/purchase-drafts?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`); const list=r.list||[]; $('#pdList').innerHTML=list.length?`<table class="table"><thead><tr><th>شماره</th><th>تأمین‌کننده</th><th>تاریخ</th><th>کاربر</th><th>جمع</th><th>وضعیت</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.purchaseDraftNo)}</td><td>${esc(x.supplierName||'')}</td><td>${toJalaliDisplay(x.createdAt)}</td><td>${esc(x.createdByName||x.createdBy||'')}</td><td>${fmt(x.totalAmount||0)}</td><td>${esc(x.status||'draft')}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">پیش‌نویسی پیدا نشد.</div>'; }
    $('#pdLoad').onclick=load; await load();
  };

  window.pageAppLogs = pageAppLogs = async function(){
    setPage('لاگ عملیات', `<main class="main-content"><div class="card"><div class="card-header"><h5>لاگ عملیات</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>جستجو</label><input id="logQ" placeholder="نوع، کاربر، مشتری، موبایل"></div><div class="form-group"><label>نوع</label><input id="logType" placeholder="مثلا proforma_edit"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="logLoad">نمایش</button></div></div><div id="logList">در حال بارگذاری...</div></div></div></main>`);
    async function load(){ const q=$('#logQ').value||'', type=$('#logType').value||''; const r=await api(`/api/app-logs?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=200`); const list=r.list||[]; $('#logList').innerHTML=list.length?`<table class="table"><thead><tr><th>زمان</th><th>نوع</th><th>کاربر</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>{const detail={...x}; delete detail._id; delete detail.at; delete detail.type; return `<tr><td>${toJalaliDisplay(x.at)}</td><td>${esc(x.type||'')}</td><td>${esc(x.username||x.by||x.createdBy||x.updatedBy||'')}</td><td><pre class="mini-json">${esc(JSON.stringify(detail,null,2))}</pre></td></tr>`}).join('')}</tbody></table>`:'<div class="muted">لاگی پیدا نشد.</div>'; }
    $('#logLoad').onclick=load; await load();
  };

  const _routeFrozenTurnover = route;
  window.route = route = async function(){
    let p=location.hash.slice(1)||firstAllowedPage();
    if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}
    if(p==='dashboard')return dashboard();
    if(p==='stocks')return pageStocks();
    if(p==='cardex')return pageCardex();
    if(p==='sale')return pageSale();
    if(p==='proforma')return pageProforma();
    if(p==='proforma-list')return pageProformaArchive();
    if(p==='turnover')return pageTurnover(); // frozen from 0.8.4
    if(p==='account-set')return pageAccountSet();
    if(p==='users')return pageUsers();
    if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();
    if(p==='customers')return pageCustomers();
    if(p==='buy')return pagePurchaseDraft();
    if(p==='purchase-drafts')return pagePurchaseDraftArchive();
    if(p==='app-logs')return pageAppLogs();
    return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p);
  };
})();


/* FINAL PATCH 0.8.9: operational purchase draft + supplier search + canPurchase + immediate routing. Turnover remains frozen from 0.8.4 baseline. */
(function(){
  const FINAL_VERSION = '0.8.9-purchase-draft-operational-from-084';
  window.__MKCRM_PATCH_VERSION = FINAL_VERSION;

  const _baseCanPage = canPage;
  window.canPage = canPage = function(page){
    const r = userRole();
    if(r === 'admin') return true;
    if((page === 'buy' || page === 'purchase-drafts') && state.user && state.user.canPurchase === true) return true;
    return _baseCanPage(page);
  };

  window.renderMenu = renderMenu = function(){
    const newMenu = [
      ['حسابداری / شایگان', [
        ['sale','فاکتور فروش جدید'],
        ['proforma','پیش‌فاکتور'],
        ['proforma-list','آرشیو پیش‌فاکتور'],
        ['buy','فاکتور خرید جدید'],
        ['purchase-drafts','آرشیو پیش‌نویس خرید'],
        ['stocks','موجودی انبارها'],
        ['cardex','کاردکس کالا'],
        ['inv-sale','فاکتورهای فروش'],
        ['inv-buy','فاکتورهای خرید'],
        ['turnover','گردش حساب'],
        ['account-set','تعریف صندوق/نماینده']
      ]],
      ['CRM', [
        ['customers','مشتریان'],
        ['leads','Lead ID'],
        ['reservations','رزرو شماره']
      ]],
      ['مدیریت', [
        ['settings','تنظیمات'],
        ['users','کاربران'],
        ['roles','نقش‌ها'],
        ['reports','تست‌ها'],
        ['app-logs','لاگ عملیات']
      ]]
    ];
    let h=''; const role=userRole();
    newMenu.forEach(([g,items])=>{ const allowedItems=items.filter(([id])=>canPage(id)); if(!allowedItems.length)return; h+=`<div class="menu-group">${g}</div>`; allowedItems.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`); });
    const menuEl = $('#menu'); if(!menuEl) return;
    menuEl.innerHTML=h;
    $$('.navbtn').forEach(b=>b.onclick=(ev)=>{ev.preventDefault(); history.pushState(null,'','#'+b.dataset.page); route();});
    const chip=document.querySelector('.user-chip');
    if(chip) chip.innerHTML=`${esc(state.user?.fullName||state.user?.username||'')}<br><small>${esc(ROLE_LABELS[role]||role)}</small><br><small>${FINAL_VERSION}</small>`;
  };

  async function supplierSearch(q, limit=80){
    return await api(`/api/suppliers/search?q=${encodeURIComponent(q||'')}&limit=${limit}`);
  }
  function bindSupplierPicker(inputId, listId, onPick){
    const input=$('#'+inputId), box=$('#'+listId); if(!input||!box)return;
    let last=[]; let seq=0,requestController=null;
    uiPageLifecycle.add(()=>{seq++;requestController?.abort();requestController=null;});
    function render(list){
      box.style.display='block';
      box.innerHTML=(list||[]).map(a=>`<div class="account-row" data-number="${esc(a.supplierNumber||a.accountNumber||'')}" data-name="${esc(a.supplierName||a.accountName||'')}" data-guid="${esc(a.supplierGuid||a.accountGuid||'')}"><b>${esc(a.supplierName||a.accountName||'')}</b><div class="small muted">کد: ${esc(a.supplierNumber||a.accountNumber||'')}</div></div>`).join('') || '<div class="floating-empty">تأمین‌کننده‌ای پیدا نشد.</div>';
      box.querySelectorAll('.account-row').forEach(el=>el.onclick=()=>{const acc={supplierNumber:el.dataset.number,supplierName:el.dataset.name,supplierGuid:el.dataset.guid,accountNumber:el.dataset.number,accountName:el.dataset.name,accountGuid:el.dataset.guid}; input.value=`${acc.supplierNumber} - ${acc.supplierName}`; popupSuggestionController.close(); onPick(acc);});
      popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-row'});
    }
    const search=debounce(async()=>{const q=input.value.trim(); if(q.length<2){seq++;requestController?.abort();popupSuggestionController.close({restoreFocus:false}); return;} const my=++seq;requestController?.abort();requestController=new AbortController(); box.innerHTML='<div class="floating-empty">در حال جستجو در شایگان...</div>';popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.account-row'});try{const r=await api(`/api/suppliers/search?q=${encodeURIComponent(q)}&limit=80`,{signal:requestController.signal});if(my!==seq)return;last=r.list||[];render(last);}catch(e){if(e.name!=='AbortError'){popupSuggestionController.close({restoreFocus:false});box.innerHTML=`<div class="floating-empty">${esc(e.message||e)}</div>`;}}},260);
    input.addEventListener('input', search);
    input.addEventListener('keydown', e=>{ if(e.key==='Enter'){e.preventDefault(); if(last.length===1){const a=last[0]; input.value=`${a.supplierNumber||a.accountNumber||''} - ${a.supplierName||a.accountName||''}`; box.style.display='none'; onPick({supplierNumber:a.supplierNumber||a.accountNumber||'',supplierName:a.supplierName||a.accountName||'',supplierGuid:a.supplierGuid||a.accountGuid||'',accountNumber:a.supplierNumber||a.accountNumber||'',accountName:a.supplierName||a.accountName||'',accountGuid:a.supplierGuid||a.accountGuid||''});}}});
  }

  window.pagePurchaseDraft = pagePurchaseDraft = async function(){
    state.purchaseLines=[]; state.purchaseItem=null; state.purchaseSupplier=null;
    setPage('فاکتور خرید جدید', `<main class="main-content"><div class="card"><div class="card-header"><h5>پیش‌نویس فاکتور خرید</h5></div><div class="card-body"><div class="info">فعلاً فقط پیش‌نویس داخلی می‌سازد و در شایگان سند خرید ثبت نمی‌کند. تأمین‌کننده از شایگان انتخاب می‌شود.</div><div class="row three"><div class="form-group account-picker"><label>جستجوی تأمین‌کننده از شایگان</label><input id="buySupplierSearch" placeholder="نام یا کد تأمین‌کننده / حساب"><div id="buySupplierList" class="floating-list account-list"></div><input id="buySupplier" class="readonly mt6" readonly placeholder="تأمین‌کننده انتخاب‌شده"></div><div class="form-group"><label>موبایل / تماس</label><input id="buyMobile"></div><div class="form-group"><label>توضیحات</label><input id="buyDesc"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="buyQ" placeholder="نام یا کد کالا"><div id="buyMsg" class="small muted"></div><div id="buyList" class="floating-list"></div><input id="buySelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="buyQty" type="number" value="1"></div><div class="form-group"><label>قیمت خرید</label><input id="buyPrice" type="number"></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="buyAdd">افزودن ردیف</button></div></div>${purchaseLineHtml()}<div class="actions"><button class="btn red" id="buySave">ذخیره پیش‌نویس خرید</button></div><div id="buyOut"></div></div></div></main>`);
    bindSupplierPicker('buySupplierSearch','buySupplierList',(acc)=>{state.purchaseSupplier=acc; $('#buySupplier').value=`${acc.supplierNumber} - ${acc.supplierName}`;});
    bindProductSearch('buy',(item)=>{state.purchaseItem=item;$('#buySelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#buyQ').value=item.itemDescription;},{limit:120});
    $('#buyAdd').onclick=()=>{ if(!state.purchaseItem)return alert('کالا را انتخاب کن'); const quantity=Number($('#buyQty').value||0), price=Number($('#buyPrice').value||0); if(quantity<=0||price<0)return alert('تعداد و قیمت معتبر وارد کن'); state.purchaseLines.push({...state.purchaseItem,quantity,price}); state.purchaseItem=null; $('#buySelected').value=''; $('#buyQ').value=''; $('#buyQty').value='1'; $('#buyPrice').value=''; renderPurchaseLines(); };
    renderPurchaseLines();
    $('#buySave').onclick=async()=>{ if(!state.purchaseLines.length)return alert('ردیفی وجود ندارد'); if(!state.purchaseSupplier)return alert('تأمین‌کننده را از لیست شایگان انتخاب کن'); const payload={supplierName:state.purchaseSupplier.supplierName,supplierNumber:state.purchaseSupplier.supplierNumber,supplierGuid:state.purchaseSupplier.supplierGuid,supplierMobile:$('#buyMobile').value,description:$('#buyDesc').value,items:state.purchaseLines}; try{const r=await post('/api/purchase-drafts',payload); $('#buyOut').innerHTML=r.ok?`<div class="success">پیش‌نویس خرید ذخیره شد: ${r.draft.purchaseDraftNo}</div>`:`<div class="error">${esc(r.error||'خطا')}</div>`;}catch(e){$('#buyOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;} };
  };

  window.pageUsers = pageUsers = async function(){
    state.userAccessDraft=[];
    setPage('کاربران',`<main class="main-content"><div class="card"><div class="card-header"><h5>افزودن / ویرایش کاربر</h5></div><div class="card-body"><input type="hidden" id="uOriginalUsername"><div class="row three"><div class="form-group"><label>نام</label><input id="uFirst"></div><div class="form-group"><label>نام خانوادگی</label><input id="uLast"></div><div class="form-group"><label>نام کاربری</label><input id="uUsername"></div><div class="form-group"><label>رمز ورود</label><input id="uPass" type="password" placeholder="فقط برای تغییر رمز پر شود"></div><div class="form-group"><label>تکرار رمز ورود</label><input id="uPass2" type="password"></div><div class="form-group"><label>گروه کاربری</label><select id="uRole"><option value="admin">مدیر سیستم</option><option value="seller">فروشنده</option><option value="accounting">حسابداری</option><option value="warehouse">انبار</option><option value="purchase">بازرگانی</option><option value="seller_buyer">فروشنده-خریدار</option></select></div><div class="form-group"><label>شماره موبایل</label><input id="uMobile"></div><div class="form-group"><label>دسترسی خرید برای فروشنده</label><label class="checkline"><input type="checkbox" id="uCanPurchase"> فعال‌سازی فاکتور/پیش‌نویس خرید</label><label class="checkline"><input type="checkbox" id="uCanViewPurchaseInvoices"> مرور فاکتورهای خرید شایگان</label><label class="checkline"><input type="checkbox" id="uCanPostPurchaseToBoard"> اعلام ورود کالا در تابلو</label><label class="checkline"><input type="checkbox" id="uCanManageBoardEvents"> مدیریت وضعیت‌های تابلو</label></div></div><div id="userAccessBox" class="mapping-box" style="display:none"><h4>حساب‌های مجاز گردش حساب برای این فروشنده</h4><p class="small muted">صندوق و جاری کارکنان از «تعریف صندوق/نماینده» خودکار مجاز هستند.</p><div class="row two"><div class="form-group account-picker"><label>جستجوی حساب شایگان برای دسترسی مجاز</label><input id="uAccessSearch" placeholder="نام یا کد حساب"><div id="uAccessResults" class="floating-list account-list"></div></div><div><label>حساب‌های انتخاب‌شده</label><div id="userAccessList" class="access-list"></div></div></div></div><button class="btn green" id="saveUserBtn">ذخیره کاربر</button><button class="btn gray" id="newUserBtn">کاربر جدید</button><button class="btn" id="repairUserLinksBtn">اصلاح اتصال کاربران</button><div id="userMsg"></div></div></div><div class="card"><div class="card-header"><h5>لیست کاربران</h5></div><div class="card-body"><div id="usersTable">در حال بارگذاری...</div></div></div></main>`);
    $('#uRole').onchange=_showUserAccessSection;
    bindAccountPicker('uAccessSearch','uAccessResults',(acc)=>{if(!(state.userAccessDraft||[]).find(x=>String(x.accountNumber)===String(acc.accountNumber))){state.userAccessDraft.push({accountNumber:acc.accountNumber,accountName:acc.accountName,accountGuid:acc.guId||acc.accountGuid||'',guId:acc.guId||acc.accountGuid||'',accountKey:acc.accountKey||''});_renderUserAccessDraft();}});
    $('#newUserBtn').onclick=()=>{$('#uOriginalUsername').value=$('#uFirst').value=$('#uLast').value=$('#uUsername').value=$('#uPass').value=$('#uPass2').value=$('#uMobile').value='';$('#uRole').value='seller';$('#uCanPurchase').checked=false;state.userAccessDraft=[];_showUserAccessSection();_renderUserAccessDraft();$('#userMsg').innerHTML=''};
    $('#saveUserBtn').onclick=saveUser;
    const repairBtn=$('#repairUserLinksBtn'); if(repairBtn) repairBtn.onclick=async()=>{ if(!confirm('اتصالات تکراری و خراب کاربران بررسی و اصلاح شود؟'))return; const r=await post('/api/users/repair-links',{}); $('#userMsg').innerHTML=r.ok?`<div class="success">اصلاح انجام شد. کاربران: ${r.users} | اتصال‌های تکراری حذف‌شده: ${r.fixedMappings} | دسترسی‌های تکراری حذف‌شده: ${r.fixedAccess} | اتصال جدید ساخته‌شده: ${r.created}</div>`:`<div class="error">${esc(r.error||'خطا')}</div>`; state.mappings=null; await renderUsersTable(); };
    _showUserAccessSection(); _renderUserAccessDraft(); await renderUsersTable();
  };
  window.saveUser = saveUser = async function(){
    const firstName=$('#uFirst').value.trim(), lastName=$('#uLast').value.trim(), username=$('#uUsername').value.trim(), password=$('#uPass').value, password2=$('#uPass2').value, role=$('#uRole').value, mobile=$('#uMobile').value.trim(), originalUsername=$('#uOriginalUsername').value.trim(), canPurchase=$('#uCanPurchase')?.checked===true;
    if(!firstName||!lastName||!username||!role)return $('#userMsg').innerHTML='<div class="error">نام، نام خانوادگی، نام کاربری و گروه کاربری الزامی است.</div>';
    if(password!==password2)return $('#userMsg').innerHTML='<div class="error">رمز ورود و تکرار آن برابر نیست.</div>';
    const r=await post('/api/users',{firstName,lastName,username,password,role,mobile,canPurchase,originalUsername,updatedBy:state.user?.username||'admin'});
    if(!r.ok)return $('#userMsg').innerHTML=`<div class="error">${esc(r.error||'خطا')}</div>`;
    const ar=await _saveUserAccessIfNeeded(username,role);
    state.mappings=null;
    $('#userMsg').innerHTML=`<div class="success">کاربر ذخیره شد${canPurchase?' و دسترسی خرید فعال شد':''}${ar.skipped?'':' و حساب‌های مجاز گردش حساب هم ثبت شد'}.</div>`;
    $('#uOriginalUsername').value=username; await renderUsersTable();
  };
  window.renderUsersTable = renderUsersTable = async function(){
    const r=await api('/api/users');const roles={admin:'مدیر سیستم',seller:'فروشنده',accounting:'حسابداری',warehouse:'انبار',purchase:'بازرگانی',seller_buyer:'فروشنده-خریدار'};let h='<table class="table"><thead><tr><th>نام</th><th>نام کاربری</th><th>گروه کاربری</th><th>موبایل</th><th>خرید</th><th>وضعیت اتصال شایگان</th></tr></thead><tbody>';const maps=(await api('/api/user-mappings')).list||[];h+=(r.list||[]).map(u=>{const m=maps.find(x=>x.username===u.username);const payload=encodeURIComponent(JSON.stringify(u));return `<tr class="user-row" data-user="${payload}"><td><button class="linklike edit-user">${esc(u.fullName||((u.firstName||'')+' '+(u.lastName||'')))}</button></td><td>${esc(u.username)}</td><td>${esc(roles[u.role]||u.role||'')}</td><td>${esc(u.mobile||'')}</td><td>${u.canPurchase?'<span class="oktext">فعال</span>':'-'}</td><td>${(u.canViewPurchaseInvoices||u.canPostPurchaseToBoard||u.canManageBoardEvents)?'<span class="oktext">فعال</span>':'-'}</td><td>${m&&m.cashboxAccountNumber&&m.employeeAccountNumber?'<span class="oktext">متصل</span>':'<span class="warntext">نیازمند اتصال</span>'}</td></tr>`}).join('');$('#usersTable').innerHTML=h+'</tbody></table>';$$('.user-row').forEach(tr=>tr.onclick=async()=>{const u=JSON.parse(decodeURIComponent(tr.dataset.user));$('#uOriginalUsername').value=u.username||'';$('#uFirst').value=u.firstName||'';$('#uLast').value=u.lastName||'';$('#uUsername').value=u.username||'';$('#uRole').value=u.role||'seller';$('#uMobile').value=u.mobile||'';$('#uCanPurchase').checked=u.canPurchase===true;$('#uPass').value='';$('#uPass2').value='';_showUserAccessSection();await _loadUserAccess(u.username);$('#userMsg').innerHTML='<div class="info">حالت ویرایش کاربر: رمز را فقط در صورت تغییر وارد کن.</div>';window.scrollTo({top:0,behavior:'smooth'});});
  };

  const _route089 = route;
  window.route = route = async function(){
    let p=location.hash.slice(1)||firstAllowedPage();
    if(!canPage(p)){p=firstAllowedPage();history.replaceState(null,'','#'+p);}
    if(p==='dashboard')return dashboard();
    if(p==='stocks')return pageStocks();
    if(p==='cardex')return pageCardex();
    if(p==='sale')return pageSale();
    if(p==='proforma')return pageProforma();
    if(p==='proforma-list')return pageProformaArchive();
    if(p==='turnover')return pageTurnover();
    if(p==='account-set')return pageAccountSet();
    if(p==='users')return pageUsers();
    if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();
    if(p==='customers')return pageCustomers();
    if(p==='buy')return pagePurchaseDraft();
    if(p==='purchase-drafts')return pagePurchaseDraftArchive();
    if(p==='app-logs')return pageAppLogs();
    return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p);
  };
  setTimeout(()=>{try{ if($('#menu')) renderMenu(); if($('#content') && state.user) route(); }catch(e){console.error('0.8.9 final activation error',e)}},0);
})();


/* FINAL PATCH 0.9.0: purchase draft usable UI + supplier from Shaygan + line edit + last purchase price + rial words. Turnover remains frozen from 0.8.4. */
(function(){
  const V='0.9.6-purchase-guard-customer-bank';
  window.__MKCRM_PATCH_VERSION=V;
  const smallNums=['','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه','ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
  const tens=['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
  const hundreds=['','صد','دویست','سیصد','چهارصد','پانصد','ششصد','هفتصد','هشتصد','نهصد'];
  const scales=['','هزار','میلیون','میلیارد','هزار میلیارد'];
  function threeWords(n){n=Number(n||0);const parts=[];const h=Math.floor(n/100),r=n%100;if(h)parts.push(hundreds[h]);if(r){if(r<20)parts.push(smallNums[r]);else{const t=Math.floor(r/10),u=r%10;parts.push(tens[t]);if(u)parts.push(smallNums[u]);}}return parts.join(' و ')}
  function rialWords(n){n=Math.floor(Number(n||0));if(!n)return 'صفر ریال';const chunks=[];let x=n;while(x>0){chunks.push(x%1000);x=Math.floor(x/1000);}const parts=[];for(let i=chunks.length-1;i>=0;i--){if(!chunks[i])continue;parts.push((threeWords(chunks[i])+' '+(scales[i]||'')).trim());}return parts.join(' و ')+' ریال'}
  function lineAmount(q,p){return Number(q||0)*Number(p||0)}
  async function getLastPurchase(itemCode){try{return await api(`/api/items/${encodeURIComponent(itemCode)}/last-purchase`)}catch(e){return {ok:false,error:e.message}}}
  async function supplierSearch(q, limit=80){return await api(`/api/suppliers/search?q=${encodeURIComponent(q||'')}&limit=${limit}`)}
  function bindSupplierPicker(inputId,listId,onPick){const input=$('#'+inputId),box=$('#'+listId);if(!input||!box)return;let last=[],seq=0;function render(list){box.style.display='block';box.innerHTML=(list||[]).map((a,i)=>`<div class="account-result" data-i="${i}"><b>${esc(a.supplierName||a.accountName||'')}</b><span>${esc(a.supplierNumber||a.accountNumber||'')}</span><small>${esc(a.supplierGuid||a.accountGuid||'')}</small></div>`).join('')||'<div class="floating-empty">تأمین‌کننده‌ای پیدا نشد.</div>';box.querySelectorAll('.account-result').forEach(el=>el.onclick=()=>{const a=list[Number(el.dataset.i)];const acc={supplierNumber:a.supplierNumber||a.accountNumber||'',supplierName:a.supplierName||a.accountName||'',supplierGuid:a.supplierGuid||a.accountGuid||'',accountNumber:a.supplierNumber||a.accountNumber||'',accountName:a.supplierName||a.accountName||'',accountGuid:a.supplierGuid||a.accountGuid||''};input.value=`${acc.supplierNumber} - ${acc.supplierName}`;box.style.display='none';onPick(acc);});}
    const run=debounce(async()=>{const q=input.value.trim(); if(q.length<2){box.style.display='none';return;} const my=++seq;box.style.display='block';box.innerHTML='<div class="floating-empty">در حال جستجو در شایگان...</div>';const r=await supplierSearch(q,80);if(my!==seq)return;last=r.list||[];render(last);},250);input.addEventListener('input',run);input.addEventListener('keydown',e=>{if(e.key==='Enter'&&last.length===1){e.preventDefault();const a=last[0];const acc={supplierNumber:a.supplierNumber||a.accountNumber||'',supplierName:a.supplierName||a.accountName||'',supplierGuid:a.supplierGuid||a.accountGuid||''};input.value=`${acc.supplierNumber} - ${acc.supplierName}`;box.style.display='none';onPick(acc);}});document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==input)box.style.display='none'});}
  window.canPage = (function(base){return function(page){const r=userRole(); if(r==='admin')return true; if((page==='buy'||page==='purchase-drafts')&&state.user&&state.user.canPurchase===true)return true; return base(page);};})(canPage);
  window.renderMenu = renderMenu = function(){const newMenu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا-تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات']]]];let h='';const role=userRole();newMenu.forEach(([g,items])=>{const allowed=items.filter(([id])=>canPage(id));if(!allowed.length)return;h+=`<div class="menu-group">${g}</div>`;allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`)});const m=$('#menu');if(!m)return;m.innerHTML=h;$$('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});const chip=document.querySelector('.user-chip');if(chip)chip.innerHTML=`${esc(state.user?.fullName||state.user?.username||'')}<br><small>${esc(ROLE_LABELS[role]||role)}</small><br><small>${V}</small>`};
  function renderPurchaseLines(){const box=$('#purchaseLines');if(!box)return;const lines=state.purchaseLines||[];if(!lines.length){box.innerHTML='<div class="muted">هنوز ردیفی اضافه نشده است.</div>';return;}let totalQty=0,totalAmount=0;const rows=lines.map((x,i)=>{const amount=lineAmount(x.quantity,x.price);totalQty+=Number(x.quantity||0);totalAmount+=amount;return `<tr><td>${i+1}</td><td>${esc(x.itemCode)}</td><td>${esc(x.itemDescription)}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.lastPurchasePrice||0)}</td><td>${fmt(x.price)}</td><td>${fmt(amount)}</td><td><button class="btn small" data-edit="${i}">ویرایش</button> <button class="btn small danger" data-del="${i}">حذف</button></td></tr>`}).join('');box.innerHTML=`<table class="table"><thead><tr><th>#</th><th>کد</th><th>کالا</th><th>تعداد</th><th>آخرین خرید</th><th>قیمت واحد</th><th>مبلغ</th><th></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="3">جمع</th><th>${fmt(totalQty)}</th><th></th><th></th><th>${fmt(totalAmount)}</th><th></th></tr></tfoot></table><div class="total">جمع کل: ${fmt(totalAmount)} ریال</div>`;box.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{state.purchaseLines.splice(Number(b.dataset.del),1);renderPurchaseLines();});box.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editPurchaseLine(Number(b.dataset.edit)));}
  function updatePriceText(){const p=Number($('#buyPrice')?.value||0),q=Number($('#buyQty')?.value||0);const el=$('#buyPriceWords');if(el)el.innerHTML=`قیمت واحد: <b>${fmt(p)} ریال</b> - ${esc(rialWords(p))}<br>مبلغ ردیف: <b>${fmt(lineAmount(q,p))} ریال</b> - ${esc(rialWords(lineAmount(q,p)))}`;}
  function resetPurchaseLineForm(){state.purchaseItem=null;state.purchaseEditIndex=null;['buySelected','buyQ','buyPrice'].forEach(id=>{const e=$('#'+id);if(e)e.value=''});if($('#buyQty'))$('#buyQty').value='1';if($('#buyAdd'))$('#buyAdd').textContent='افزودن ردیف';if($('#buyCancelEdit'))$('#buyCancelEdit').style.display='none';if($('#buyLastPurchase'))$('#buyLastPurchase').innerHTML='';updatePriceText();}
  function editPurchaseLine(i){const x=(state.purchaseLines||[])[i];if(!x)return;state.purchaseEditIndex=i;state.purchaseItem={itemCode:x.itemCode,itemDescription:x.itemDescription,itemGuid:x.itemGuid||''};$('#buySelected').value=`${x.itemCode} - ${x.itemDescription}`;$('#buyQ').value=x.itemDescription;$('#buyQty').value=x.quantity;$('#buyPrice').value=x.price;$('#buyAdd').textContent='ذخیره تغییر ردیف';$('#buyCancelEdit').style.display='inline-block';$('#buyLastPurchase').innerHTML=x.lastPurchasePrice?`آخرین قیمت خرید: ${fmt(x.lastPurchasePrice)} ریال | ${esc(x.lastPurchaseSupplier||'')}`:'آخرین قیمت خرید: اطلاعاتی ثبت نشده';updatePriceText();}
  async function pickPurchaseItem(item){state.purchaseItem=item;$('#buySelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#buyQ').value=item.itemDescription;$('#buyLastPurchase').innerHTML='در حال خواندن آخرین قیمت خرید...';const r=await getLastPurchase(item.itemCode);const lp=r.lastPurchase||null;state.purchaseLast=lp;if(lp&&lp.price){$('#buyLastPurchase').innerHTML=`آخرین قیمت خرید کل سیستم: <b>${fmt(lp.price)} ریال</b> | ${esc(lp.supplierName||'')} | ${toJalaliDisplay(lp.date||'')}`; if(!$('#buyPrice').value) $('#buyPrice').value=lp.price;}else{$('#buyLastPurchase').innerHTML='آخرین قیمت خرید برای این کالا پیدا نشد.';}updatePriceText();}
  function addOrUpdatePurchaseLine(){if(!state.purchaseItem)return alert('کالا را انتخاب کن');const quantity=Number($('#buyQty').value||0),price=Number($('#buyPrice').value||0);if(quantity<=0||price<0)return alert('تعداد و قیمت معتبر وارد کن');const lp=state.purchaseLast||{};const line={...state.purchaseItem,quantity,price,lastPurchasePrice:Number(lp.price||0),lastPurchaseSupplier:lp.supplierName||'',lastPurchaseDate:lp.date||''};if(Number.isInteger(state.purchaseEditIndex)&&state.purchaseEditIndex>=0)state.purchaseLines[state.purchaseEditIndex]=line;else state.purchaseLines.push(line);resetPurchaseLineForm();renderPurchaseLines();}
  window.pagePurchaseDraft = pagePurchaseDraft = async function(){state.purchaseLines=[];state.purchaseItem=null;state.purchaseSupplier=null;state.purchaseLast=null;state.purchaseEditIndex=null;setPage('فاکتور خرید جدید',`<main class="main-content"><div class="card"><div class="card-header"><h5>پیش‌نویس فاکتور خرید</h5></div><div class="card-body"><div class="info">پیش‌نویس داخلی خرید؛ هنوز در شایگان سند خرید ثبت نمی‌کند. واحد همه مبالغ: ریال.</div><div class="row three"><div class="form-group account-picker"><label>تأمین‌کننده از شایگان</label><input id="buySupplierSearch" placeholder="نام یا کد تأمین‌کننده"><div id="buySupplierList" class="floating-list account-list"></div><input id="buySupplier" class="readonly mt6" readonly placeholder="تأمین‌کننده انتخاب‌شده"></div><div class="form-group"><label>موبایل / تماس</label><input id="buyMobile"></div><div class="form-group"><label>توضیحات</label><input id="buyDesc"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن / ویرایش کالا</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="buyQ" placeholder="نام یا کد کالا"><div id="buyMsg" class="small muted"></div><div id="buyList" class="floating-list"></div><input id="buySelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div id="buyLastPurchase" class="info mt"></div><div class="row three mt"><div class="form-group"><label>تعداد</label><input id="buyQty" type="number" value="1"></div><div class="form-group"><label>قیمت واحد خرید - ریال</label><input id="buyPrice" type="number" placeholder="مثلا 1000"><div id="buyPriceWords" class="small muted"></div></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="buyAdd">افزودن ردیف</button> <button class="btn" id="buyCancelEdit" style="display:none">انصراف از ویرایش</button></div></div><div id="purchaseLines" class="mt"></div><div class="actions"><button class="btn red" id="buySave">ذخیره پیش‌نویس خرید</button></div><div id="buyOut"></div></div></div></main>`);bindSupplierPicker('buySupplierSearch','buySupplierList',acc=>{state.purchaseSupplier=acc;$('#buySupplier').value=`${acc.supplierNumber} - ${acc.supplierName}`;});bindProductSearch('buy',pickPurchaseItem,{limit:120});$('#buyQty').addEventListener('input',updatePriceText);$('#buyPrice').addEventListener('input',updatePriceText);$('#buyAdd').onclick=addOrUpdatePurchaseLine;$('#buyCancelEdit').onclick=resetPurchaseLineForm;renderPurchaseLines();updatePriceText();$('#buySave').onclick=async()=>{if(!state.purchaseSupplier)return alert('تأمین‌کننده را از شایگان انتخاب کن');if(!state.purchaseLines.length)return alert('حداقل یک ردیف لازم است');const payload={supplierName:state.purchaseSupplier.supplierName,supplierNumber:state.purchaseSupplier.supplierNumber,supplierGuid:state.purchaseSupplier.supplierGuid,supplierMobile:$('#buyMobile').value,description:$('#buyDesc').value,items:state.purchaseLines};try{const r=await post('/api/purchase-drafts',payload);$('#buyOut').innerHTML=r.ok?`<div class="success">پیش‌نویس خرید ذخیره شد: ${r.draft.purchaseDraftNo}</div>`:`<div class="error">${esc(r.error||'خطا')}</div>`;if(r.ok){state.purchaseLines=[];renderPurchaseLines();}}catch(e){$('#buyOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;}}};
  window.route = route = async function(){let p=location.hash.slice(1)||firstAllowedPage();if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}if(p==='dashboard')return dashboard();if(p==='stocks')return pageStocks();if(p==='cardex')return pageCardex();if(p==='sale')return pageSale();if(p==='proforma')return pageProforma();if(p==='proforma-list')return pageProformaArchive();if(p==='turnover')return pageTurnover();if(p==='account-set')return pageAccountSet();if(p==='users')return pageUsers();if(p==='seller-profit')return pageSellerProfit();if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();if(p==='customers')return pageCustomers();if(p==='buy')return pagePurchaseDraft();if(p==='purchase-drafts')return pagePurchaseDraftArchive();if(p==='app-logs')return pageAppLogs();return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p)};
  window.addEventListener('hashchange',()=>{try{route()}catch(e){console.error(e)}});
  setTimeout(()=>{try{if($('#menu'))renderMenu();if(state.user)route();}catch(e){console.error('0.9.0 activation',e)}},10);
})();


/* FINAL PATCH 0.9.1: issue purchase draft to Shaygan InvTyp=3 with stock selection. Turnover remains frozen from 0.8.4. */
(function(){
  const V='0.9.6-purchase-guard-customer-bank';
  window.MKCRM_VERSION = V;
  async function loadStocks(){ if(state._stocks&&state._stocks.length)return state._stocks; const r=await api('/api/stocks'); state._stocks=r.list||[]; return state._stocks; }
  function stockOptions(selected=''){ const list=state._stocks||[]; return '<option value="">انتخاب انبار ورودی</option>'+list.map(s=>`<option value="${esc(s.stockNumber)}" ${String(selected)===String(s.stockNumber)?'selected':''}>${esc(s.stockNumber)} - ${esc(s.stockName||'')}</option>`).join(''); }
  function renderPurchaseLines091(){const box=$('#purchaseLines');if(!box)return;const lines=state.purchaseLines||[];if(!lines.length){box.innerHTML='<div class="muted">هنوز ردیفی اضافه نشده است.</div>';return;}let totalQty=0,totalAmount=0;const rows=lines.map((x,i)=>{const amount=Number(x.quantity||0)*Number(x.price||0);totalQty+=Number(x.quantity||0);totalAmount+=amount;return `<tr><td>${i+1}</td><td>${esc(x.itemCode)}</td><td>${esc(x.itemDescription)}</td><td>${esc(x.stockNumber||'')} - ${esc(x.stockName||'')}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.lastPurchasePrice||0)}</td><td>${fmt(x.price)}</td><td>${fmt(amount)}</td><td><button class="btn small" data-edit="${i}">ویرایش</button> <button class="btn small danger" data-del="${i}">حذف</button></td></tr>`}).join('');box.innerHTML=`<table class="table"><thead><tr><th>#</th><th>کد</th><th>کالا</th><th>انبار ورودی</th><th>تعداد</th><th>آخرین خرید</th><th>قیمت</th><th>مبلغ</th><th></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="4">جمع</th><th>${fmt(totalQty)}</th><th></th><th></th><th>${fmt(totalAmount)}</th><th></th></tr></tfoot></table><div class="total">جمع کل: ${fmt(totalAmount)} ریال</div>`;box.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{state.purchaseLines.splice(Number(b.dataset.del),1);renderPurchaseLines091();});box.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editPurchaseLine091(Number(b.dataset.edit)));}
  function updatePriceText091(){const p=Number($('#buyPrice')?.value||0),q=Number($('#buyQty')?.value||0);const el=$('#buyPriceWords');if(el)el.innerHTML=`قیمت واحد: <b>${fmt(p)} ریال</b> - ${esc(rialWords(p))}<br>مبلغ ردیف: <b>${fmt(q*p)} ریال</b> - ${esc(rialWords(q*p))}`;}
  function resetPurchaseLineForm091(){state.purchaseItem=null;state.purchaseEditIndex=null;['buySelected','buyQ','buyPrice'].forEach(id=>{const e=$('#'+id);if(e)e.value=''});if($('#buyStock'))$('#buyStock').value='';if($('#buyQty'))$('#buyQty').value='1';if($('#buyAdd'))$('#buyAdd').textContent='افزودن ردیف';if($('#buyCancelEdit'))$('#buyCancelEdit').style.display='none';if($('#buyLastPurchase'))$('#buyLastPurchase').innerHTML='';updatePriceText091();}
  function editPurchaseLine091(i){const x=(state.purchaseLines||[])[i];if(!x)return;state.purchaseEditIndex=i;state.purchaseItem={itemCode:x.itemCode,itemDescription:x.itemDescription,itemGuid:x.itemGuid||''};$('#buySelected').value=`${x.itemCode} - ${x.itemDescription}`;$('#buyQ').value=x.itemDescription;$('#buyQty').value=x.quantity;$('#buyPrice').value=x.price;$('#buyStock').value=x.stockNumber||'';$('#buyAdd').textContent='ذخیره تغییر ردیف';$('#buyCancelEdit').style.display='inline-block';$('#buyLastPurchase').innerHTML=x.lastPurchasePrice?`آخرین قیمت خرید: ${fmt(x.lastPurchasePrice)} ریال | ${esc(x.lastPurchaseSupplier||'')}`:'آخرین قیمت خرید: اطلاعاتی ثبت نشده';updatePriceText091();}
  async function pickPurchaseItem091(item){state.purchaseItem=item;$('#buySelected').value=`${item.itemCode} - ${item.itemDescription}`;$('#buyQ').value=item.itemDescription;$('#buyLastPurchase').innerHTML='در حال خواندن آخرین قیمت خرید...';const r=await api(`/api/items/${encodeURIComponent(item.itemCode)}/last-purchase`).catch(e=>({ok:false,error:e.message}));const lp=r.lastPurchase||null;state.purchaseLast=lp;if(lp&&lp.price){$('#buyLastPurchase').innerHTML=`آخرین قیمت خرید کل سیستم: <b>${fmt(lp.price)} ریال</b> | ${esc(lp.supplierName||'')} | ${toJalaliDisplay(lp.date||'')}`; if(!$('#buyPrice').value) $('#buyPrice').value=lp.price;}else{$('#buyLastPurchase').innerHTML='آخرین قیمت خرید برای این کالا پیدا نشد.';}updatePriceText091();}
  function addOrUpdatePurchaseLine091(){if(!state.purchaseItem)return alert('کالا را انتخاب کن');const quantity=Number($('#buyQty').value||0),price=Number($('#buyPrice').value||0);const stockNumber=$('#buyStock').value||'';const stock=(state._stocks||[]).find(s=>String(s.stockNumber)===String(stockNumber))||{};if(!stockNumber)return alert('انبار ورودی را انتخاب کن');if(quantity<=0||price<0)return alert('تعداد و قیمت معتبر وارد کن');const lp=state.purchaseLast||{};const line={...state.purchaseItem,stockNumber,stockName:stock.stockName||'',stockGuid:stock.stockGuid||'',quantity,price,lastPurchasePrice:Number(lp.price||0),lastPurchaseSupplier:lp.supplierName||'',lastPurchaseDate:lp.date||''};if(Number.isInteger(state.purchaseEditIndex)&&state.purchaseEditIndex>=0)state.purchaseLines[state.purchaseEditIndex]=line;else state.purchaseLines.push(line);resetPurchaseLineForm091();renderPurchaseLines091();}
  window.pagePurchaseDraft = pagePurchaseDraft = async function(){state.purchaseLines=[];state.purchaseItem=null;state.purchaseSupplier=null;state.purchaseLast=null;state.purchaseEditIndex=null;await loadStocks();setPage('فاکتور خرید جدید',`<main class="main-content"><div class="card"><div class="card-header"><h5>پیش‌نویس فاکتور خرید</h5></div><div class="card-body"><div class="info">پیش‌نویس خرید؛ بعد از ذخیره از آرشیو می‌توانی آن را در شایگان با InvTyp=3 ثبت کنی. واحد همه مبالغ: ریال.</div><div class="row three"><div class="form-group account-picker"><label>تأمین‌کننده از شایگان</label><input id="buySupplierSearch" placeholder="نام یا کد تأمین‌کننده"><div id="buySupplierList" class="floating-list account-list"></div><input id="buySupplier" class="readonly mt6" readonly placeholder="تأمین‌کننده انتخاب‌شده"></div><div class="form-group"><label>موبایل / تماس</label><input id="buyMobile"></div><div class="form-group"><label>توضیحات</label><input id="buyDesc"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن / ویرایش کالا</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="buyQ" placeholder="نام یا کد کالا"><div id="buyMsg" class="small muted"></div><div id="buyList" class="floating-list"></div><input id="buySelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div id="buyLastPurchase" class="info mt"></div><div class="row four mt"><div class="form-group"><label>انبار ورودی</label><select id="buyStock">${stockOptions('')}</select></div><div class="form-group"><label>تعداد</label><input id="buyQty" type="number" value="1"></div><div class="form-group"><label>قیمت واحد خرید - ریال</label><input id="buyPrice" type="number" placeholder="مثلا 1000"><div id="buyPriceWords" class="small muted"></div></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="buyAdd">افزودن ردیف</button> <button class="btn" id="buyCancelEdit" style="display:none">انصراف از ویرایش</button></div></div><div id="purchaseLines" class="mt"></div><div class="actions"><button class="btn red" id="buySave">ذخیره پیش‌نویس خرید</button></div><div id="buyOut"></div></div></div></main>`);bindSupplierPicker('buySupplierSearch','buySupplierList',acc=>{state.purchaseSupplier=acc;$('#buySupplier').value=`${acc.supplierNumber} - ${acc.supplierName}`;});bindProductSearch('buy',pickPurchaseItem091,{limit:120});$('#buyQty').addEventListener('input',updatePriceText091);$('#buyPrice').addEventListener('input',updatePriceText091);$('#buyAdd').onclick=addOrUpdatePurchaseLine091;$('#buyCancelEdit').onclick=resetPurchaseLineForm091;renderPurchaseLines091();updatePriceText091();$('#buySave').onclick=async()=>{if(!state.purchaseSupplier)return alert('تأمین‌کننده را از شایگان انتخاب کن');if(!state.purchaseLines.length)return alert('حداقل یک ردیف لازم است');const payload={supplierName:state.purchaseSupplier.supplierName,supplierNumber:state.purchaseSupplier.supplierNumber,supplierGuid:state.purchaseSupplier.supplierGuid,supplierMobile:$('#buyMobile').value,description:$('#buyDesc').value,items:state.purchaseLines};try{const r=await post('/api/purchase-drafts',payload);$('#buyOut').innerHTML=r.ok?`<div class="success">پیش‌نویس خرید ذخیره شد: ${r.draft.purchaseDraftNo}</div>`:`<div class="error">${esc(r.error||'خطا')}</div>`;if(r.ok){state.purchaseLines=[];renderPurchaseLines091();}}catch(e){$('#buyOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;}}};
  window.pagePurchaseDraftArchive = pagePurchaseDraftArchive = async function(){setPage('آرشیو پیش‌نویس خرید',`<main class="main-content"><div class="card"><div class="card-header"><h5>آرشیو پیش‌نویس خرید</h5></div><div class="card-body"><div class="row three"><div class="form-group"><label>جستجو</label><input id="pdQ" placeholder="شماره، تأمین‌کننده، توضیحات"></div><div class="form-group"><label>وضعیت</label><select id="pdStatus"><option value="">همه</option><option value="draft">پیش‌نویس</option><option value="issued">ثبت‌شده در شایگان</option><option value="failed">خطای ثبت</option><option value="cancelled">لغوشده</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="pdLoad">نمایش</button></div></div><div id="pdList">در حال بارگذاری...</div><div id="pdOut"></div></div></div></main>`);async function issue(no){if(state.purchaseIssueInFlight){alert('ثبت خرید در حال انجام است؛ صبر کن تا نتیجه مشخص شود.');return;}state.purchaseIssueInFlight=true;$$('[data-issue]').forEach(b=>b.disabled=true);$('#pdOut').innerHTML='<div class="info">در حال خواندن آخرین شماره فاکتور خرید از شایگان...</div>';let preview=null;try{preview=await api(`/api/purchase-drafts/${no}/issue-preview`);}catch(e){$('#pdOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;return;}if(!preview.ok){$('#pdOut').innerHTML=`<div class="error">${esc(preview.error||'خطا در آماده‌سازی ثبت خرید')}</div>`;return;}const msg=`این پیش‌نویس خرید در شایگان ثبت شود؟\nآخرین شماره خرید شایگان: ${preview.lastPurchaseInvoiceNumber||0}\nشماره پیشنهادی بعدی: ${preview.suggestedInvoiceNumber}\nInvTyp خرید: 3`;if(!confirm(msg)){ $('#pdOut').innerHTML='<div class="muted">ثبت در شایگان لغو شد.</div>'; return;}$('#pdOut').innerHTML=`<div class="info">در حال ثبت در شایگان با شماره پیشنهادی ${esc(preview.suggestedInvoiceNumber)}...</div>`;try{const r=await post(`/api/purchase-drafts/${no}/issue`,{});$('#pdOut').innerHTML=r.ok?`<div class="success">فاکتور خرید در شایگان ثبت و تأیید شد. شماره: ${esc(r.shayganInvoiceNumber||r.result?.Number||'')}</div>`:`<div class="error">${esc(r.error||'خطا')}</div><pre class="mini-json">${esc(JSON.stringify(r.verify||r.raw||r,null,2))}</pre>`;await load();}catch(e){$('#pdOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;}finally{state.purchaseIssueInFlight=false;$$('[data-issue]').forEach(b=>b.disabled=false);}}async function load(){const q=$('#pdQ').value||'',status=$('#pdStatus').value||'';const r=await api(`/api/purchase-drafts?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);const list=r.list||[];$('#pdList').innerHTML=list.length?`<table class="table"><thead><tr><th>شماره</th><th>تأمین‌کننده</th><th>تاریخ</th><th>کاربر</th><th>جمع</th><th>وضعیت</th><th>شایگان</th><th>عملیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.purchaseDraftNo)}</td><td>${esc(x.supplierName||'')}</td><td>${toJalaliDisplay(x.createdAt)}</td><td>${esc(x.createdByName||x.createdBy||'')}</td><td>${fmt(x.totalAmount||0)}</td><td>${esc(statusFa(x.status||'draft'))}</td><td>${esc(x.shayganInvoiceNumber||'')}</td><td><button class="btn small" data-print-draft="${esc(x.purchaseDraftNo)}">چاپ پیش‌نویس</button> ${x.status==='issued'?`<button class="btn small green" data-print-inv="${esc(x.shayganInvoiceNumber||'')}">چاپ فاکتور</button>`:`<button class="btn small green" data-issue="${esc(x.purchaseDraftNo)}">ثبت در شایگان</button>`}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">پیش‌نویسی پیدا نشد.</div>';$('#pdList').querySelectorAll('[data-issue]').forEach(b=>b.onclick=()=>issue(b.dataset.issue));$('#pdList').querySelectorAll('[data-print-draft]').forEach(b=>b.onclick=()=>window.open(`/print/purchase-draft/${encodeURIComponent(b.dataset.printDraft)}`,'_blank'));$('#pdList').querySelectorAll('[data-print-inv]').forEach(b=>b.onclick=()=>{if(b.dataset.printInv)window.open(`/print/purchase-invoice/${encodeURIComponent(b.dataset.printInv)}`,'_blank');});}$('#pdLoad').onclick=load;await load();};
  window.renderMenu = renderMenu;
  window.route = async function(){let p=location.hash.slice(1)||firstAllowedPage();if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}if(p==='dashboard')return dashboard();if(p==='stocks')return pageStocks();if(p==='cardex')return pageCardex();if(p==='sale')return pageSale();if(p==='proforma')return pageProforma();if(p==='proforma-list')return pageProformaArchive();if(p==='turnover')return pageTurnover();if(p==='account-set')return pageAccountSet();if(p==='users')return pageUsers();if(p==='seller-profit')return pageSellerProfit();if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();if(p==='customers')return pageCustomers();if(p==='buy')return pagePurchaseDraft();if(p==='purchase-drafts')return pagePurchaseDraftArchive();if(p==='app-logs')return pageAppLogs();return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p)};
  setTimeout(()=>{try{if($('#menu'))renderMenu();if(state.user)route();}catch(e){console.error('0.9.1 activation',e)}},20);
})();

function statusFa(s){return ({draft:'پیش‌نویس',issuing:'در حال ثبت',issued:'ثبت‌شده',failed:'خطای ثبت',pending_verify:'در انتظار بررسی',cancelled:'لغوشده'}[String(s||'draft')]||String(s||'draft'));}
/* FINAL PATCH 0.9.2: robust purchase UI search bindings. Turnover remains frozen from 0.8.4 baseline. */
(function(){
  const V='0.9.6-purchase-guard-customer-bank';
  window.__MKCRM_PATCH_VERSION=V;
  const $p=(s)=>document.querySelector(s);
  const $$p=(s)=>Array.from(document.querySelectorAll(s));
  const fmt2=(n)=>Number(n||0).toLocaleString('fa-IR');
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const dly=(fn,ms=300)=>{let t;return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}};
  function pAmount(q,p){return Number(q||0)*Number(p||0)}
  function pStockOptions(sel=''){
    const list=state.stocks||[];
    return '<option value="">انتخاب انبار ورودی</option>'+list.map(s=>`<option value="${safe(s.stockNumber)}" ${String(sel)===String(s.stockNumber)?'selected':''}>${safe(s.stockNumber)} - ${safe(s.stockName)}</option>`).join('');
  }
  function pRialWords(n){
    n=Math.floor(Number(n||0)); if(!n)return 'صفر ریال';
    const small=['','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه','ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
    const tens=['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
    const hund=['','صد','دویست','سیصد','چهارصد','پانصد','ششصد','هفتصد','هشتصد','نهصد'];
    const scales=['','هزار','میلیون','میلیارد','هزار میلیارد'];
    function tri(x){const a=[];const h=Math.floor(x/100),r=x%100;if(h)a.push(hund[h]);if(r){if(r<20)a.push(small[r]);else{const t=Math.floor(r/10),u=r%10;a.push(tens[t]);if(u)a.push(small[u]);}}return a.join(' و ')}
    const chunks=[];while(n>0){chunks.push(n%1000);n=Math.floor(n/1000)}
    const out=[];for(let i=chunks.length-1;i>=0;i--){if(chunks[i])out.push((tri(chunks[i])+' '+(scales[i]||'')).trim())}
    return out.join(' و ')+' ریال';
  }
  async function pApi(url,opts={}){return await api(url,opts)}
  async function pPost(url,body){return await post(url,body)}
  async function pLoadStocks(){if(typeof loadStocks==='function')return await loadStocks();const r=await pApi('/api/stocks');state.stocks=(r.list||[]);return state.stocks;}
  function purchaseTotals(){let q=0,a=0;(state.purchaseLines||[]).forEach(x=>{q+=Number(x.quantity||0);a+=pAmount(x.quantity,x.price)});return {q,a}}
  function renderPurchaseLines092(){
    const box=$p('#purchaseLines'); if(!box)return;
    const lines=state.purchaseLines||[];
    if(!lines.length){box.innerHTML='<div class="muted">هنوز ردیفی اضافه نشده است.</div>'; updatePurchaseTotals092(); return;}
    let tq=0,ta=0;
    const rows=lines.map((x,i)=>{const amount=pAmount(x.quantity,x.price);tq+=Number(x.quantity||0);ta+=amount;return `<tr><td>${i+1}</td><td>${safe(x.itemCode)}</td><td>${safe(x.itemDescription)}</td><td>${safe(x.stockNumber||'')} - ${safe(x.stockName||'')}</td><td>${fmt2(x.quantity)}</td><td>${fmt2(x.lastPurchasePrice||0)}</td><td>${fmt2(x.price)}</td><td>${fmt2(amount)}</td><td><button class="btn small" data-pedit="${i}">ویرایش</button> <button class="btn small danger" data-pdel="${i}">حذف</button></td></tr>`}).join('');
    box.innerHTML=`<table class="table"><thead><tr><th>#</th><th>کد</th><th>کالا</th><th>انبار ورودی</th><th>تعداد</th><th>آخرین خرید</th><th>قیمت واحد</th><th>مبلغ</th><th></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="4">جمع</th><th>${fmt2(tq)}</th><th></th><th></th><th>${fmt2(ta)}</th><th></th></tr></tfoot></table>`;
    box.querySelectorAll('[data-pdel]').forEach(b=>b.onclick=()=>{state.purchaseLines.splice(Number(b.dataset.pdel),1);renderPurchaseLines092();});
    box.querySelectorAll('[data-pedit]').forEach(b=>b.onclick=()=>editPurchaseLine092(Number(b.dataset.pedit)));
    updatePurchaseTotals092();
  }
  function updatePurchaseTotals092(){const t=purchaseTotals();const el=$p('#buyTotals');if(el)el.innerHTML=`جمع تعداد: <b>${fmt2(t.q)}</b> | جمع کل: <b>${fmt2(t.a)} ریال</b> | ${safe(pRialWords(t.a))}`;}
  function updatePriceWords092(){const p=Number($p('#buyPrice')?.value||0),q=Number($p('#buyQty')?.value||0);const el=$p('#buyPriceWords');if(el)el.innerHTML=`قیمت واحد: <b>${fmt2(p)} ریال</b> - ${safe(pRialWords(p))}<br>مبلغ ردیف: <b>${fmt2(q*p)} ریال</b> - ${safe(pRialWords(q*p))}`;}
  function resetPurchaseLine092(){state.purchaseItem=null;state.purchaseEditIndex=null;state.purchaseLast=null;['buySelected','buyQ','buyPrice'].forEach(id=>{const e=$p('#'+id);if(e)e.value=''});if($p('#buyQty'))$p('#buyQty').value='1';if($p('#buyStock'))$p('#buyStock').value='';if($p('#buyAdd'))$p('#buyAdd').textContent='افزودن ردیف';if($p('#buyCancelEdit'))$p('#buyCancelEdit').style.display='none';if($p('#buyLastPurchase'))$p('#buyLastPurchase').innerHTML='';updatePriceWords092();}
  function editPurchaseLine092(i){const x=(state.purchaseLines||[])[i];if(!x)return;state.purchaseEditIndex=i;state.purchaseItem={itemCode:x.itemCode,itemDescription:x.itemDescription,itemGuid:x.itemGuid||''};state.purchaseLast={price:x.lastPurchasePrice||0,supplierName:x.lastPurchaseSupplier||'',date:x.lastPurchaseDate||''};$p('#buySelected').value=`${x.itemCode} - ${x.itemDescription}`;$p('#buyQ').value=x.itemDescription;$p('#buyStock').value=x.stockNumber||'';$p('#buyQty').value=x.quantity;$p('#buyPrice').value=x.price;$p('#buyAdd').textContent='ذخیره تغییر ردیف';$p('#buyCancelEdit').style.display='inline-block';$p('#buyLastPurchase').innerHTML=x.lastPurchasePrice?`آخرین قیمت خرید: <b>${fmt2(x.lastPurchasePrice)} ریال</b> | ${safe(x.lastPurchaseSupplier||'')}`:'آخرین قیمت خرید: اطلاعاتی ثبت نشده';updatePriceWords092();}
  async function pickPurchaseItem092(item){state.purchaseItem={itemCode:item.itemCode||item.ItemCode,itemDescription:item.itemDescription||item.ItemDesc||item.ItemDescription,itemGuid:item.itemGuid||item.ItemGuId||''};$p('#buySelected').value=`${state.purchaseItem.itemCode} - ${state.purchaseItem.itemDescription}`;$p('#buyQ').value=state.purchaseItem.itemDescription;$p('#buyItemList').style.display='none';$p('#buyLastPurchase').innerHTML='در حال خواندن آخرین قیمت خرید...';const r=await pApi(`/api/items/${encodeURIComponent(state.purchaseItem.itemCode)}/last-purchase`).catch(e=>({ok:false,error:e.message}));const lp=r.lastPurchase||null;state.purchaseLast=lp;if(lp&&lp.price){$p('#buyLastPurchase').innerHTML=`آخرین قیمت خرید کل سیستم: <b>${fmt2(lp.price)} ریال</b> | ${safe(lp.supplierName||'')} | ${typeof toJalaliDisplay==='function'?toJalaliDisplay(lp.date||''):safe(lp.date||'')}`;if(!$p('#buyPrice').value)$p('#buyPrice').value=lp.price;}else{$p('#buyLastPurchase').innerHTML='آخرین قیمت خرید برای این کالا پیدا نشد.';}updatePriceWords092();}
  function bindSupplierSearch092(){const input=$p('#buySupplierSearch'),box=$p('#buySupplierList');let last=[];if(!input||!box)return;const run=dly(async()=>{const q=input.value.trim();if(q.length<2){box.style.display='none';return;}box.style.display='block';box.innerHTML='<div class="floating-empty">در حال جستجوی تأمین‌کننده...</div>';const r=await pApi(`/api/suppliers/search?q=${encodeURIComponent(q)}&limit=80`).catch(e=>({ok:false,error:e.message,list:[]}));last=r.list||[];box.innerHTML=last.length?last.map((a,i)=>`<div class="account-result" data-i="${i}"><b>${safe(a.supplierName||a.accountName)}</b><span>${safe(a.supplierNumber||a.accountNumber)}</span></div>`).join(''):`<div class="floating-empty">${safe(r.error||'تأمین‌کننده‌ای پیدا نشد')}</div>`;box.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>{const a=last[Number(el.dataset.i)];state.purchaseSupplier={supplierNumber:a.supplierNumber||a.accountNumber||'',supplierName:a.supplierName||a.accountName||'',supplierGuid:a.supplierGuid||a.accountGuid||''};input.value=`${state.purchaseSupplier.supplierNumber} - ${state.purchaseSupplier.supplierName}`;$p('#buySupplier').value=input.value;box.style.display='none';});},250);input.addEventListener('input',run);input.addEventListener('keydown',e=>{if(e.key==='Enter'&&last.length===1){e.preventDefault();box.querySelector('[data-i="0"]')?.click();}});}
  function bindItemSearch092(){const input=$p('#buyQ'),box=$p('#buyItemList'),msg=$p('#buyItemMsg');let last=[];if(!input||!box)return;const run=dly(async()=>{const q=input.value.trim();if(q.length<2){box.style.display='none';if(msg)msg.textContent='';return;}box.style.display='block';box.innerHTML='<div class="floating-empty">در حال جستجوی کالا...</div>';if(msg)msg.textContent='';const r=await pApi(`/api/items/search-all?q=${encodeURIComponent(q)}&limit=120&pages=25`).catch(e=>({ok:false,error:e.message,list:[]}));last=r.list||[];if(msg)msg.textContent=`${last.length} کالا ${r.source?'| '+r.source:''}`;box.innerHTML=last.length?last.map((x,i)=>{const code=x.itemCode||x.ItemCode,desc=x.itemDescription||x.ItemDesc||x.ItemDescription;return `<div class="product-row" data-i="${i}"><b>${safe(desc)}</b><div class="small muted">کد: ${safe(code)}</div></div>`}).join(''):`<div class="floating-empty">${safe(r.error||'کالایی پیدا نشد')}</div>`;box.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>pickPurchaseItem092(last[Number(el.dataset.i)]));},250);input.addEventListener('input',run);input.addEventListener('keydown',e=>{if(e.key==='Enter'&&last.length===1){e.preventDefault();box.querySelector('[data-i="0"]')?.click();}});}
  function addOrUpdatePurchaseLine092(){if(!state.purchaseItem)return alert('کالا را از لیست انتخاب کن');const stockNumber=$p('#buyStock').value||'';const stock=(state.stocks||[]).find(s=>String(s.stockNumber)===String(stockNumber))||{};const quantity=Number($p('#buyQty').value||0),price=Number($p('#buyPrice').value||0);if(!stockNumber)return alert('انبار ورودی را انتخاب کن');if(quantity<=0||price<0)return alert('تعداد و قیمت معتبر وارد کن');const lp=state.purchaseLast||{};const line={...state.purchaseItem,stockNumber,stockName:stock.stockName||'',stockGuid:stock.stockGuid||'',quantity,price,lastPurchasePrice:Number(lp.price||0),lastPurchaseSupplier:lp.supplierName||'',lastPurchaseDate:lp.date||''};if(Number.isInteger(state.purchaseEditIndex)&&state.purchaseEditIndex>=0)state.purchaseLines[state.purchaseEditIndex]=line;else state.purchaseLines.push(line);resetPurchaseLine092();renderPurchaseLines092();}
  window.pagePurchaseDraft = pagePurchaseDraft = async function(){state.purchaseLines=[];state.purchaseItem=null;state.purchaseSupplier=null;state.purchaseLast=null;state.purchaseEditIndex=null;await pLoadStocks();setPage('فاکتور خرید جدید',`<main class="main-content"><div class="card"><div class="card-header"><h5>پیش‌نویس فاکتور خرید</h5></div><div class="card-body"><div class="info">واحد همه مبالغ ریال است. تأمین‌کننده و کالا باید از لیست انتخاب شوند.</div><div class="row three"><div class="form-group account-picker"><label>تأمین‌کننده از شایگان</label><input id="buySupplierSearch" placeholder="نام یا کد تأمین‌کننده" autocomplete="off"><div id="buySupplierList" class="floating-list account-list"></div><input id="buySupplier" class="readonly mt6" readonly placeholder="تأمین‌کننده انتخاب‌شده"></div><div class="form-group"><label>موبایل / تماس</label><input id="buyMobile"></div><div class="form-group"><label>توضیحات</label><input id="buyDesc"></div></div></div></div><div class="card"><div class="card-header"><h5>افزودن / ویرایش کالا</h5></div><div class="card-body"><div class="legacy-search"><label>جستجوی کالا</label><input id="buyQ" placeholder="نام یا کد کالا" autocomplete="off"><div id="buyItemMsg" class="small muted"></div><div id="buyItemList" class="floating-list"></div><input id="buySelected" class="readonly" readonly placeholder="کالای انتخاب‌شده"></div><div id="buyLastPurchase" class="info mt"></div><div class="row four mt"><div class="form-group"><label>انبار ورودی</label><select id="buyStock">${pStockOptions('')}</select></div><div class="form-group"><label>تعداد</label><input id="buyQty" type="number" value="1"></div><div class="form-group"><label>قیمت واحد خرید - ریال</label><input id="buyPrice" type="number" placeholder="مثلاً 1000"><div id="buyPriceWords" class="small muted"></div></div><div class="form-group"><label>&nbsp;</label><button class="btn green" id="buyAdd">افزودن ردیف</button> <button class="btn" id="buyCancelEdit" style="display:none">انصراف از ویرایش</button></div></div><div id="purchaseLines" class="mt"></div><div id="buyTotals" class="total mt"></div><div class="actions"><button class="btn red" id="buySave">ذخیره پیش‌نویس خرید</button></div><div id="buyOut"></div></div></div></main>`);bindSupplierSearch092();bindItemSearch092();$p('#buyQty').addEventListener('input',updatePriceWords092);$p('#buyPrice').addEventListener('input',updatePriceWords092);$p('#buyAdd').onclick=addOrUpdatePurchaseLine092;$p('#buyCancelEdit').onclick=resetPurchaseLine092;renderPurchaseLines092();updatePriceWords092();$p('#buySave').onclick=async()=>{if(!state.purchaseSupplier)return alert('تأمین‌کننده را از لیست شایگان انتخاب کن');if(!state.purchaseLines.length)return alert('حداقل یک ردیف لازم است');const payload={supplierName:state.purchaseSupplier.supplierName,supplierNumber:state.purchaseSupplier.supplierNumber,supplierGuid:state.purchaseSupplier.supplierGuid,supplierMobile:$p('#buyMobile').value,description:$p('#buyDesc').value,items:state.purchaseLines};try{const r=await pPost('/api/purchase-drafts',payload);$p('#buyOut').innerHTML=r.ok?`<div class="success">پیش‌نویس خرید ذخیره شد: ${safe(r.draft.purchaseDraftNo)}</div>`:`<div class="error">${safe(r.error||'خطا')}</div>`;if(r.ok){state.purchaseLines=[];renderPurchaseLines092();}}catch(e){$p('#buyOut').innerHTML=`<div class="error">${safe(e.message)}</div>`;}}};
  window.route = route = async function(){let p=location.hash.slice(1)||firstAllowedPage();if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}if(p==='dashboard')return dashboard();if(p==='stocks')return pageStocks();if(p==='cardex')return pageCardex();if(p==='sale')return pageSale();if(p==='proforma')return pageProforma();if(p==='proforma-list')return pageProformaArchive();if(p==='turnover')return pageTurnover();if(p==='account-set')return pageAccountSet();if(p==='users')return pageUsers();if(p==='seller-profit')return pageSellerProfit();if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();if(p==='customers')return pageCustomers();if(p==='buy')return pagePurchaseDraft();if(p==='purchase-drafts')return pagePurchaseDraftArchive();if(p==='app-logs')return pageAppLogs();return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p)};
  setTimeout(()=>{try{if($p('#menu'))renderMenu();if(state.user)route();}catch(e){console.error('0.9.2 activation',e)}},50);
})();

/* FINAL PATCH 0.9.6: purchase archive issue guard with full frontend finally cleanup */
(function(){
  const V='0.9.6-purchase-guard-customer-bank';
  window.MKCRM_VERSION = V;
  function localStatusFa(s){return ({draft:'پیش‌نویس',issuing:'در حال ثبت',issued:'ثبت‌شده',failed:'خطای ثبت',pending_verify:'در انتظار بررسی',cancelled:'لغوشده'}[String(s||'draft')]||String(s||'draft'));}
  window.pagePurchaseDraftArchive = pagePurchaseDraftArchive = async function(){
    setPage('آرشیو پیش‌نویس خرید',`<main class="main-content"><div class="card"><div class="card-header"><h5>آرشیو پیش‌نویس خرید</h5></div><div class="card-body"><div class="info">نسخه 0.9.6: ثبت خرید دارای قفل ضد کلیک تکراری است.</div><div class="row three"><div class="form-group"><label>جستجو</label><input id="pdQ" placeholder="شماره، تأمین‌کننده، توضیحات"></div><div class="form-group"><label>وضعیت</label><select id="pdStatus"><option value="">همه</option><option value="draft">پیش‌نویس</option><option value="issuing">در حال ثبت</option><option value="issued">ثبت‌شده در شایگان</option><option value="pending_verify">در انتظار بررسی</option><option value="failed">خطای ثبت</option><option value="cancelled">لغوشده</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="pdLoad">نمایش</button></div></div><div id="pdList">در حال بارگذاری...</div><div id="pdOut"></div></div></div></main>`);
    async function issue(no){
      if(state.purchaseIssueInFlight){alert('ثبت خرید در حال انجام است؛ صبر کن تا نتیجه مشخص شود.');return;}
      state.purchaseIssueInFlight=true;
      const disableButtons = (v)=>$$('[data-issue]').forEach(b=>b.disabled=!!v);
      disableButtons(true);
      try{
        $('#pdOut').innerHTML='<div class="info">در حال خواندن آخرین شماره فاکتور خرید از شایگان...</div>';
        const preview=await api(`/api/purchase-drafts/${no}/issue-preview`);
        if(!preview.ok){$('#pdOut').innerHTML=`<div class="error">${esc(preview.error||'خطا در آماده‌سازی ثبت خرید')}</div>`;return;}
        const msg=`این پیش‌نویس خرید در شایگان ثبت شود؟\nآخرین شماره خرید شایگان: ${preview.lastPurchaseInvoiceNumber||0}\nشماره پیشنهادی بعدی: ${preview.suggestedInvoiceNumber}\nInvTyp خرید: 3`;
        if(!confirm(msg)){ $('#pdOut').innerHTML='<div class="muted">ثبت در شایگان لغو شد.</div>'; return; }
        $('#pdOut').innerHTML=`<div class="info">در حال ثبت در شایگان با شماره پیشنهادی ${esc(preview.suggestedInvoiceNumber)}...</div>`;
        const r=await post(`/api/purchase-drafts/${no}/issue`,{});
        $('#pdOut').innerHTML=r.ok?`<div class="success">فاکتور خرید در شایگان ثبت و تأیید شد. شماره: ${esc(r.shayganInvoiceNumber||r.result?.Number||'')}</div>`:`<div class="error">${esc(r.error||'خطا')}</div><pre class="mini-json">${esc(JSON.stringify(r.verify||r.raw||r,null,2))}</pre>`;
        await load();
      }catch(e){
        $('#pdOut').innerHTML=`<div class="error">${esc(e.message||e)}</div>`;
      }finally{
        state.purchaseIssueInFlight=false;
        disableButtons(false);
      }
    }
    async function load(){
      const q=$('#pdQ').value||'', status=$('#pdStatus').value||'';
      const r=await api(`/api/purchase-drafts?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
      const list=r.list||[];
      $('#pdList').innerHTML=list.length?`<table class="table"><thead><tr><th>شماره</th><th>تأمین‌کننده</th><th>تاریخ</th><th>کاربر</th><th>جمع</th><th>وضعیت</th><th>شایگان</th><th>عملیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.purchaseDraftNo)}</td><td>${esc(x.supplierName||'')}</td><td>${toJalaliDisplay(x.createdAt)}</td><td>${esc(x.createdByName||x.createdBy||'')}</td><td>${fmt(x.totalAmount||0)}</td><td>${esc(localStatusFa(x.status||'draft'))}</td><td>${esc(x.shayganInvoiceNumber||'')}</td><td><button class="btn small" data-print-draft="${esc(x.purchaseDraftNo)}">چاپ پیش‌نویس</button> ${x.status==='issued'?`<button class="btn small green" data-print-inv="${esc(x.shayganInvoiceNumber||'')}">چاپ فاکتور</button>`: (['issuing','pending_verify'].includes(String(x.status||''))?'<span class="muted">ثبت مجدد قفل است</span>':`<button class="btn small green" data-issue="${esc(x.purchaseDraftNo)}">ثبت در شایگان</button>`)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">پیش‌نویسی پیدا نشد.</div>';
      $('#pdList').querySelectorAll('[data-issue]').forEach(b=>b.onclick=()=>issue(b.dataset.issue));
      $('#pdList').querySelectorAll('[data-print-draft]').forEach(b=>b.onclick=()=>window.open(`/print/purchase-draft/${encodeURIComponent(b.dataset.printDraft)}`,'_blank'));
      $('#pdList').querySelectorAll('[data-print-inv]').forEach(b=>b.onclick=()=>{if(b.dataset.printInv)window.open(`/print/purchase-invoice/${encodeURIComponent(b.dataset.printInv)}`,'_blank');});
    }
    $('#pdLoad').onclick=load;
    await load();
  };
})();

/* FINAL PATCH 0.9.6 CUSTOMER BANK: Shaygan sales customer sync + sale autofill. Purchase/turnover frozen. */
(function(){
  const V='0.9.6-purchase-guard-customer-bank';
  window.MKCRM_VERSION = V;
  function safeText(v){return esc(v==null?'':String(v));}
  function customerLabel(c){return `${c.fullName||'بدون نام'} ${c.mobile?' | '+c.mobile:''} ${c.nationalCode?' | کد ملی '+c.nationalCode:''} ${c.purchaseCount?` | ${c.purchaseCount} خرید`:''}`;}
  async function pickCustomerToSale(c){
    if(!c)return;
    if($('#buyerName')) $('#buyerName').value=c.fullName||'';
    if($('#buyerMobile')) $('#buyerMobile').value=c.mobile||'';
    if($('#buyerNational')) $('#buyerNational').value=c.nationalCode||'';
    const box=$('#saleCustomerHint');
    if(box) box.innerHTML=`<div class="success">مشتری از بانک CRM تکمیل شد: ${safeText(customerLabel(c))}</div>`;
  }
  function bindSaleCustomerAutofill(){
    if(!$('#buyerName') || $('#saleCustomerSearchBox')) return;
    const row=$('#buyerName').closest('.row') || $('#buyerName').parentElement.parentElement;
    const wrap=document.createElement('div');
    wrap.id='saleCustomerSearchBox';
    wrap.className='card customer-autofill-card';
    wrap.innerHTML=`<div class="card-body"><div class="info">بانک مشتریان CRM: با نام، موبایل یا کد ملی جستجو کن. اگر مشتری قبلاً در شایگان/CRM بوده، مشخصات او را به فاکتور فروش منتقل کن.</div><div class="form-group account-picker"><label>جستجوی مشتری</label><input id="saleCustomerSearch" placeholder="نام / موبایل / کد ملی" autocomplete="off"><div id="saleCustomerResults" class="floating-list account-list"></div></div><div id="saleCustomerHint" class="mt6"></div></div>`;
    row.parentElement.appendChild(wrap);
    const input=$('#saleCustomerSearch'), list=$('#saleCustomerResults');
    let timer=null;
    input.addEventListener('input',()=>{
      clearTimeout(timer);
      const q=input.value.trim();
      if(q.length<2){list.style.display='none';list.innerHTML='';return;}
      timer=setTimeout(async()=>{
        const r=await api(`/api/customers/search?q=${encodeURIComponent(q)}&limit=20`);
        const arr=r.list||[];
        list.style.display='block';
        list.innerHTML=arr.length?arr.map((c,i)=>`<div class="floating-item customer-pick" data-i="${i}"><b>${safeText(c.fullName||'بدون نام')}</b><br><span>${safeText(c.mobile||'')} ${c.nationalCode?' | '+safeText(c.nationalCode):''}</span><br><small>تعداد خرید: ${safeText(c.purchaseCount||0)} | آخرین خرید: ${safeText(c.lastPurchaseDate||'')}</small></div>`).join(''):'<div class="floating-empty">مشتری پیدا نشد</div>';
        list.querySelectorAll('.customer-pick').forEach(el=>el.onclick=()=>{const c=arr[Number(el.dataset.i)];pickCustomerToSale(c);list.style.display='none';input.value=customerLabel(c);});
      },250);
    });
    ['buyerName','buyerMobile','buyerNational'].forEach(id=>{const el=$('#'+id);if(el)el.addEventListener('blur',async()=>{const q=el.value.trim();if(q.length<3)return;const r=await api(`/api/customers/search?q=${encodeURIComponent(q)}&limit=1`);const c=(r.list||[])[0];if(c){const box=$('#saleCustomerHint');if(box)box.innerHTML=`<div class="info">مشتری مشابه پیدا شد: <button class="btn small" id="fillSimilarCustomer">تکمیل اطلاعات</button> ${safeText(customerLabel(c))}</div>`;const b=$('#fillSimilarCustomer');if(b)b.onclick=()=>pickCustomerToSale(c);}});});
  }
  const oldPageSale = window.pageSale;
  if(typeof oldPageSale==='function'){
    window.pageSale = pageSale = async function(){ await oldPageSale(); setTimeout(bindSaleCustomerAutofill, 80); };
  }
  window.pageCustomers = pageCustomers = async function(){
    setPage('بانک مشتریان',`<main class="main-content"><div class="card"><div class="card-header"><h5>بانک مشتریان CRM</h5></div><div class="card-body"><div class="info">این بانک از مشتریان ثبت‌شده در CRM و مشتریان استخراج‌شده از توضیحات فاکتورهای فروش شایگان ساخته می‌شود. هدف: تکمیل سریع مشخصات در فروش و تشخیص مشتریان پرتکرار.</div><div class="row four"><div class="form-group"><label>جستجو</label><input id="custQ" placeholder="نام / موبایل / کد ملی"></div><div class="form-group"><label>حداقل خرید پرتکرار</label><input id="custMin" type="number" value="2"></div><div class="form-group"><label>Sync شایگان - صفحات هر نوع</label><input id="custPages" type="number" value="80"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="custSearchBtn">جستجو</button> <button class="btn green" id="custSyncBtn">Sync یکسال فروش شایگان</button></div></div><div id="custStats" class="mt"></div><div id="custOut" class="mt">در حال بارگذاری...</div></div></div></main>`);
    async function stats(){const r=await api('/api/customers/stats');if(r.ok)$('#custStats').innerHTML=`<div class="info">کل مشتریان: ${fmt(r.total||0)} | پرتکرار: ${fmt(r.repeated||0)} ${r.lastRun?`| آخرین Sync: ${safeText(toJalaliDisplay(r.lastRun.startedAt||''))} | candidates: ${fmt(r.lastRun.candidates||0)}`:''}</div>`;}
    async function load(){const q=$('#custQ').value.trim();const r=await api(`/api/customers/search?q=${encodeURIComponent(q)}&limit=100`);const list=r.list||[];$('#custOut').innerHTML=list.length?`<table class="table"><thead><tr><th>نام</th><th>موبایل</th><th>کد ملی</th><th>تعداد خرید</th><th>جمع خرید</th><th>آخرین خرید</th><th>منبع</th></tr></thead><tbody>${list.map(c=>`<tr><td>${safeText(c.fullName||'')}</td><td>${safeText(c.mobile||'')}</td><td>${safeText(c.nationalCode||'')}</td><td>${fmt(c.purchaseCount||0)}</td><td>${fmt(c.totalPurchaseAmount||0)}</td><td>${safeText(c.lastPurchaseDate||'')}</td><td>${safeText(c.lastSource||c.firstSource||'')}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">مشتری پیدا نشد.</div>';}
    $('#custSearchBtn').onclick=load;
    $('#custSyncBtn').onclick=async()=>{if(!confirm('Sync مشتریان از فاکتورهای فروش شایگان شروع شود؟ این عملیات کنترل‌شده است ولی ممکن است چند دقیقه طول بکشد.'))return;$('#custOut').innerHTML='<div class="info">در حال Sync مشتریان از شایگان...</div>';const pages=Number($('#custPages').value||80);const r=await post('/api/customers/sync-shaygan-sales',{days:365,pages});$('#custOut').innerHTML=r.ok?`<div class="success">Sync تمام شد. کاندیدا: ${fmt(r.candidates||0)} | ثبت/به‌روزرسانی: ${fmt(r.upserts||0)} | صفحات: ${fmt(r.scannedPages||0)}</div><pre class="mini-json">${safeText(JSON.stringify(r.errors||[],null,2))}</pre>`:`<div class="error">${safeText(r.error||'خطا')}</div>`;await stats();await load();};
    await stats(); await load();
  };
  window.route = route = async function(){let p=location.hash.slice(1)||firstAllowedPage();if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}if(p==='dashboard')return dashboard();if(p==='stocks')return pageStocks();if(p==='cardex')return pageCardex();if(p==='sale')return pageSale();if(p==='proforma')return pageProforma();if(p==='proforma-list')return pageProformaArchive();if(p==='turnover')return pageTurnover();if(p==='account-set')return pageAccountSet();if(p==='users')return pageUsers();if(p==='seller-profit')return pageSellerProfit();if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();if(p==='customers')return pageCustomers();if(p==='buy')return pagePurchaseDraft();if(p==='purchase-drafts')return pagePurchaseDraftArchive();if(p==='app-logs')return pageAppLogs();return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p)};
})();


/* FINAL PATCH 0.9.7: sales readiness, sale discount, improved print expectations. Purchase/turnover frozen. */
(function(){
  const V='0.9.8-sale-issue-idempotency-lock';
  window.MKCRM_VERSION = V;
  function saleGross(){return (state.saleLines||[]).reduce((sum,x)=>sum+Number(x.quantity||0)*Number(x.price||0),0)}
  // FIX-C1: parse sale discount safely even when user enters formatted numbers like 100,000 or Persian digits.
  function parseSaleMoney(v){
    const raw=String(v??'')
      .replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[,،\s]/g,'')
      .replace(/[^0-9.\-]/g,'');
    const n=Number(raw||0);
    return Number.isFinite(n)?n:0;
  }
  function saleDiscount(){return Math.max(0, parseSaleMoney($('#saleDiscount')?.value || 0));}
  function saleNet(){return Math.max(0, saleGross()-saleDiscount())}
  function updateSaleTotals(){
    const box=$('#saleTotalsBox'); if(!box)return;
    const gross=saleGross(), discount=saleDiscount(), net=saleNet();
    box.innerHTML=`<div class="sale-total-row"><span>جمع ردیف‌ها</span><b>${fmt(gross)} ریال</b></div><div class="sale-total-row"><span>تخفیف</span><b>${fmt(discount)} ریال</b></div><div class="sale-total-row net"><span>قابل پرداخت</span><b>${fmt(net)} ریال</b></div>`;
  }
  function resetSaleFormForNextInvoice(){
    state.saleLines=[];
    state.selectedItem=null;
    state.selectedStock=null;
    state.invoiceNumber=null;
    state.saleIssued=false;
    state.saleIssueInFlight=false;
    state.saleIssueKey='sale-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    ['buyerName','buyerMobile','buyerNational','leadId','saleQ','saleSelected','STNumber','Price'].forEach(id=>{const el=$('#'+id); if(el) el.value='';});
    const q=$('#Quan'); if(q) q.value='1';
    const d=$('#saleDiscount'); if(d) d.value='0';
    ['saleInventory','serialBox','priceWarn'].forEach(id=>{const el=$('#'+id); if(el) el.innerHTML='';});
    try{ renderSaleLines(); }catch(e){}
    try{ updateSaleTotals(); }catch(e){}
    const issueBtn=$('#issueBtn'), reserveBtn=$('#reserveBtn');
    if(issueBtn){ issueBtn.disabled=false; issueBtn.textContent=issueBtn.dataset.oldText||'صدور فاکتور'; }
    if(reserveBtn) reserveBtn.disabled=false;
    try{ if(typeof decorateManualLeadFieldAgain==='function') decorateManualLeadFieldAgain(); }catch(e){}
  }
  const oldRenderSaleLines = window.renderSaleLines || renderSaleLines;
  window.renderSaleLines = renderSaleLines = function(){
    oldRenderSaleLines();
    if(!$('#saleDiscountBox') && $('#saleLines')){
      const div=document.createElement('div');
      div.id='saleDiscountBox';
      div.className='sale-discount-box';
      div.innerHTML=`<div class="row two"><div class="form-group"><label>تخفیف کل فاکتور - ریال</label><input id="saleDiscount" type="text" inputmode="numeric" value="0" placeholder="مثلا 100000"></div><div class="form-group"><label>جمع فاکتور</label><div id="saleTotalsBox" class="sale-totals"></div></div></div>`;
      $('#saleLines').after(div);
      $('#saleDiscount').addEventListener('input',updateSaleTotals);
    }
    updateSaleTotals();
  };
  const oldPageSale = window.pageSale || pageSale;
  window.pageSale = pageSale = async function(){
    await oldPageSale();
    state.saleIssueInFlight=false;
    state.saleIssued=false;
    state.saleIssueKey='sale-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    setTimeout(()=>{
      if($('#saleDiscount')) updateSaleTotals();
      const issueBtn=$('#issueBtn'); if(issueBtn) issueBtn.onclick=issueSale;
    },80);
  };
  window.issueSale = issueSale = async function(){
    const issueBtn=$('#issueBtn'), reserveBtn=$('#reserveBtn');
    if(state.saleIssued){ resetSaleForm922(); markSaleFormReady922(); }
    if(state.saleIssueInFlight){ alert('صدور فاکتور در حال انجام است؛ صبر کن تا پاسخ شایگان نمایش داده شود.'); return; }
    state.saleIssueInFlight=true;
    if(issueBtn){ issueBtn.disabled=true; issueBtn.dataset.oldText=issueBtn.textContent; issueBtn.textContent='در حال صدور...'; }
    if(reserveBtn) reserveBtn.disabled=true;
    $('#saleOut').innerHTML='<div class="info">در حال خواندن شماره نهایی از شایگان و صدور فاکتور... لطفاً دکمه را دوباره نزن.</div>';
    try{
      if(!state.saleLines.length){ if(state.selectedItem&&state.selectedStock) addSaleLine(); }
      if(!state.saleLines.length) throw new Error('هیچ ردیف کالایی در فاکتور نیست');
      if(!state.selectedMapping||!state.selectedMapping.cashboxAccountNumber||!state.selectedMapping.employeeAccountNumber) throw new Error('اتصال صندوق و نماینده فروش کامل نیست');
      const discountAmount=saleDiscount();
      if(discountAmount>saleGross()) throw new Error('تخفیف نمی‌تواند بیشتر از جمع ردیف‌ها باشد');
      
      const payload={saleIssueKey:state.saleIssueKey,customerName:$('#buyerName').value,mobile:$('#buyerMobile').value,nationalCode:$('#buyerNational').value,leadId:$('#leadId').value,mappingUsername:state.selectedMapping.username,sessionUsername:state.user?.username||'',username:state.user?.fullName||state.selectedMapping.fullName||'CRM',items:state.saleLines,discountAmount};
      const r=await post('/admin/accounting/putInvoice',payload);
      if(r.ok){
        const printedNo = r.invoiceNumber || r.result?.Number || r.result?.InvNo || state.invoiceNumber;
        const issuedTitle = r.duplicate ? 'این فاکتور قبلاً ثبت شده بود و دوباره ارسال نشد.' : `فاکتور ${esc(printedNo||'')} با موفقیت صادر شد.`;
        resetSaleFormForNextInvoice();
        $('#saleOut').innerHTML=`<div class="success">${issuedTitle} فروشنده: ${esc(r.mapping?.fullName||'')} | فروشگاه: ${esc(r.mapping?.storeName||'')} | تخفیف: ${fmt(discountAmount)} ریال<br><b>فرم برای صدور فاکتور جدید آماده شد.</b></div><div class="actions"><a class="btn" target="_blank" href="${r.printUrl || ('/print/invoice/'+encodeURIComponent(printedNo))}">چاپ فاکتور</a><button class="btn green" id="newSaleAfterIssue">فاکتور جدید</button></div>`;
        const nb=$('#newSaleAfterIssue'); if(nb) nb.onclick=()=>resetSaleFormForNextInvoice();
      } else {
        throw new Error(r.error||JSON.stringify(r.raw));
      }
    }catch(e){
      $('#saleOut').innerHTML=`<div class="error">${esc(e.message)}</div>`;
      state.saleIssueInFlight=false;
      if(issueBtn){ issueBtn.disabled=false; issueBtn.textContent=issueBtn.dataset.oldText||'صدور فاکتور'; }
      if(reserveBtn) reserveBtn.disabled=false;
    }
  };
  const extraStyle=document.createElement('style');
  extraStyle.textContent=`.sale-discount-box{margin-top:12px;border:1px solid #d7e3f7;background:#f8fbff;border-radius:10px;padding:10px}.sale-totals{border:1px solid #c7d7f1;border-radius:8px;background:white;padding:8px}.sale-total-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #e5edf8}.sale-total-row:last-child{border-bottom:0}.sale-total-row.net{font-weight:bold;color:#0b5ed7;font-size:15px}`;
  document.head.appendChild(extraStyle);
})();


/* PATCH 0.9.9: sales usability - Jalali kardex dates, page draft state preservation, sale price words. */
(function(){
  const V='0.9.9-sales-ui-state-jalali-pricewords';
  window.MKCRM_VERSION = V;

  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function wordsFa(num){
    let n=Math.floor(Number(num||0));
    if(!Number.isFinite(n)||n<=0) return 'صفر ریال';
    const ones=['','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'];
    const teens=['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
    const tens=['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
    const hundreds=['','صد','دویست','سیصد','چهارصد','پانصد','ششصد','هفتصد','هشتصد','نهصد'];
    const scales=['','هزار','میلیون','میلیارد','هزار میلیارد','میلیون میلیارد'];
    function three(x){
      const parts=[]; const h=Math.floor(x/100), r=x%100;
      if(h) parts.push(hundreds[h]);
      if(r>=10&&r<20) parts.push(teens[r-10]);
      else { const t=Math.floor(r/10), o=r%10; if(t) parts.push(tens[t]); if(o) parts.push(ones[o]); }
      return parts.join(' و ');
    }
    const chunks=[]; while(n>0){chunks.push(n%1000); n=Math.floor(n/1000);} const out=[];
    for(let i=chunks.length-1;i>=0;i--){ if(!chunks[i]) continue; out.push((three(chunks[i])+' '+(scales[i]||'')).trim()); }
    return out.join(' و ')+' ریال';
  }

  // 1) Kardex dates must be Jalali in UI.
  const prevRenderKardex = window.renderKardex || (typeof renderKardex==='function' ? renderKardex : null);
  window.renderKardex = renderKardex = async function(item,target,stockNumber=''){
    const targetEl=$(target); if(targetEl) targetEl.innerHTML='در حال خواندن کاردکس...';
    const code = item.itemCode || item;
    const url=`/api/items/${encodeURIComponent(code)}/kardex${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`;
    const r=await api(url);
    const rows=r.rows||[];
    const meta=r.meta||{};
    let note='';
    if(meta.reachedLimit) note=`<div class="small muted">نمایش سریع: ${safe(rows.length)} گردش از حداکثر ${safe(meta.maxRows)} صفحه خوانده شد. برای گزارش کامل از مسیر مدیریتی/Sync شبانه استفاده شود.</div>`;
    if(r.error) note+=`<div class="error">${safe(r.error)}</div>`;
    let h=note+'<table class="table"><thead><tr><th>تاریخ شمسی</th><th>فاکتور</th><th>طرف حساب</th><th>ورود</th><th>خروج</th><th>مانده</th><th>قیمت خرید/تمام‌شده</th><th>قیمت فروش</th><th>سود</th></tr></thead><tbody>';
    h+=rows.map(x=>`<tr><td>${safe(toJalaliDisplay(x.date||x.Date||x.InvDate||''))}</td><td>${safe(x.invoiceNumber||x.InvNo||'')}</td><td>${safe(x.accountName||x.AccountName||'')}</td><td>${nfmt(x.inQty)}</td><td>${nfmt(x.outQty)}</td><td>${nfmt(x.remainQty)}</td><td>${nfmt(x.costPrice)}</td><td>${nfmt(x.salePrice)}</td><td>${nfmt(x.grossProfit)}</td></tr>`).join('');
    if(targetEl) targetEl.innerHTML=h+'</tbody></table>';
  };

  // 2) Keep last user inputs when moving between CRM pages.
  const STATE_PREFIX='mkcrm.pageState.';
  let currentPage=(location.hash||'#dashboard').slice(1)||'dashboard';
  function stateKey(page){return STATE_PREFIX+(state.user?.username||'guest')+'.'+page;}
  function readPageState(page){try{return JSON.parse(sessionStorage.getItem(stateKey(page))||'{}')}catch{return {}}}
  function writePageState(page,data){try{sessionStorage.setItem(stateKey(page),JSON.stringify(data||{}))}catch(e){}}
  function collectInputs(){
    const inputs={};
    document.querySelectorAll('#content input,#content select,#content textarea').forEach(el=>{
      if(!el.id) return;
      if(el.type==='password' || el.type==='file') return;
      if(el.type==='checkbox') inputs[el.id]=!!el.checked; else inputs[el.id]=el.value;
    });
    return inputs;
  }
  function applyInputs(inputs){
    Object.entries(inputs||{}).forEach(([id,val])=>{const el=document.getElementById(id); if(!el) return; if(el.type==='checkbox') el.checked=!!val; else el.value=val;});
  }
  function savePageState(page=currentPage){
    if(!page || !document.getElementById('content')) return;
    const data={inputs:collectInputs(),savedAt:Date.now(),page};
    if(page==='sale'){
      data.sale={
        saleLines:state.saleLines||[], selectedItem:state.selectedItem||null, selectedStock:state.selectedStock||null,
        selectedSerials:state.selectedSerials||[], serialInfo:state.serialInfo||null, invoiceNumber:state.invoiceNumber||null,
        saleIssueInFlight:!!state.saleIssueInFlight, saleIssued:!!state.saleIssued, saleIssueKey:state.saleIssueKey||'',
        selectedMapping:state.selectedMapping||null
      };
    }
    if(page==='proforma') data.proforma={proformaLines:state.proformaLines||[], proformaItem:state.proformaItem||null};
    if(page==='buy') data.purchase={purchaseLines:state.purchaseLines||[], purchaseSupplier:state.purchaseSupplier||null, purchaseItem:state.purchaseItem||null, purchaseLast:state.purchaseLast||null, purchaseEditIndex:state.purchaseEditIndex};
    if(page==='turnover') data.turnover={selectedAccountText:document.getElementById('turnoverAccountSearch')?.value||'', selectHtml:document.getElementById('turnoverAccountSelect')?.innerHTML||''};
    writePageState(page,data);
  }
  function restorePageState(page){
    const data=readPageState(page); if(!data || !data.inputs) return;
    applyInputs(data.inputs);
    if(page==='sale' && data.sale){
      state.saleLines=Array.isArray(data.sale.saleLines)?data.sale.saleLines:[];
      state.selectedItem=data.sale.selectedItem||state.selectedItem||null;
      state.selectedStock=data.sale.selectedStock||state.selectedStock||null;
      state.selectedSerials=data.sale.selectedSerials||[];
      state.serialInfo=data.sale.serialInfo||null;
      state.invoiceNumber=data.sale.invoiceNumber||state.invoiceNumber||null;
      state.selectedMapping=data.sale.selectedMapping||state.selectedMapping||null;
      // Do not restore in-flight state after navigation; user can continue editing safely.
      state.saleIssueInFlight=false;
      state.saleIssued=!!data.sale.saleIssued;
      state.saleIssueKey=data.sale.saleIssueKey || state.saleIssueKey || ('sale-'+Date.now()+'-'+Math.random().toString(16).slice(2));
      if(typeof renderSaleLines==='function') renderSaleLines();
      applyInputs(data.inputs);
      if(typeof updateSalePriceWords099==='function') updateSalePriceWords099();
      const out=$('#saleOut'); if(out && state.invoiceNumber && !out.innerHTML) out.innerHTML=`<div class="info">شماره پیشنهادی قبلی: ${safe(state.invoiceNumber)}</div>`;
    }
    if(page==='proforma' && data.proforma){
      state.proformaLines=Array.isArray(data.proforma.proformaLines)?data.proforma.proformaLines:[];
      state.proformaItem=data.proforma.proformaItem||null;
      if(typeof renderProformaLines==='function') renderProformaLines();
      applyInputs(data.inputs);
    }
    if(page==='buy' && data.purchase){
      state.purchaseLines=Array.isArray(data.purchase.purchaseLines)?data.purchase.purchaseLines:[];
      state.purchaseSupplier=data.purchase.purchaseSupplier||null;
      state.purchaseItem=data.purchase.purchaseItem||null;
      state.purchaseLast=data.purchase.purchaseLast||null;
      state.purchaseEditIndex=data.purchase.purchaseEditIndex;
      if(typeof renderPurchaseLines092==='function') renderPurchaseLines092();
      applyInputs(data.inputs);
      if(typeof updatePriceWords092==='function') updatePriceWords092();
    }
    if(page==='turnover' && data.turnover){
      const sel=$('#turnoverAccountSelect'); if(sel && data.turnover.selectHtml) sel.innerHTML=data.turnover.selectHtml;
      applyInputs(data.inputs);
    }
  }
  const oldSetPage = window.setPage || setPage;
  window.setPage = setPage = function(title, html){
    try{ savePageState(currentPage); }catch(e){console.warn('state save failed',e)}
    oldSetPage(title, html);
    const next=(location.hash||'#dashboard').slice(1)||'dashboard';
    currentPage=next;
    setTimeout(()=>{try{ restorePageState(next); bindSalePriceWords099(); }catch(e){console.warn('state restore failed',e)}},120);
  };
  window.addEventListener('beforeunload',()=>{try{savePageState(currentPage)}catch{}});

  // 3) Show Rial words live for sale price and line amount, like purchase form.
  window.updateSalePriceWords099 = function(){
    const p=Number($('#Price')?.value||0), q=Number($('#Quan')?.value||0);
    const el=$('#salePriceWords'); if(!el)return;
    el.innerHTML=`قیمت واحد: <b>${nfmt(p)} ریال</b> - ${safe(wordsFa(p))}<br>مبلغ ردیف: <b>${nfmt(p*q)} ریال</b> - ${safe(wordsFa(p*q))}`;
  };
  window.bindSalePriceWords099 = function(){
    const price=$('#Price'), qty=$('#Quan');
    if(!price || $('#salePriceWords')) return;
    const div=document.createElement('div'); div.id='salePriceWords'; div.className='small muted price-words-live';
    price.insertAdjacentElement('afterend', div);
    price.addEventListener('input', updateSalePriceWords099);
    qty?.addEventListener('input', updateSalePriceWords099);
    updateSalePriceWords099();
  };
  const oldPageSale099 = window.pageSale || pageSale;
  window.pageSale = pageSale = async function(){ await oldPageSale099(); setTimeout(()=>{restorePageState('sale'); bindSalePriceWords099();},180); };

  const style=document.createElement('style');
  style.textContent=`.price-words-live{margin-top:6px;line-height:1.7;color:#38506b;background:#f7fbff;border:1px solid #dce9fb;border-radius:8px;padding:6px}.state-preserved-note{font-size:12px;color:#64748b}`;
  document.head.appendChild(style);
})();

/* PATCH 0.9.10: inventory inline kardex modal; keep inventory search context. */
(function(){
  const V='0.9.12-inventory-live-source-cardex-unified';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function ensureCardexModal(){
    let m=document.getElementById('inlineCardexModal');
    if(m) return m;
    m=document.createElement('div');
    m.id='inlineCardexModal';
    m.className='mk-modal-overlay';
    m.style.display='none';
    m.innerHTML=`<div class="mk-modal-card mk-modal-card-wide"><div class="mk-modal-head"><div><b id="inlineCardexTitle">کاردکس کالا</b><div id="inlineCardexSub" class="small muted"></div></div><button class="btn" id="inlineCardexClose">بستن</button></div><div id="inlineCardexBody" class="mk-modal-body">...</div></div>`;
    document.body.appendChild(m);
    document.getElementById('inlineCardexClose').onclick=()=>{m.style.display='none';};
    m.addEventListener('click',e=>{if(e.target===m)m.style.display='none';});
    return m;
  }
  window.openInventoryCardexModal = async function(item){
    const m=ensureCardexModal();
    const title=document.getElementById('inlineCardexTitle');
    const sub=document.getElementById('inlineCardexSub');
    const body=document.getElementById('inlineCardexBody');
    title.textContent='کاردکس کالا';
    sub.textContent=`${item.itemCode||''} - ${item.itemDescription||''}`;
    body.innerHTML='در حال خواندن کاردکس...';
    m.style.display='flex';
    try{
      await renderKardex(item,'#inlineCardexBody',item.stockNumber||item.STNumber||'');
    }catch(e){
      body.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;
    }
  };
  // Override inventory table action: cardex opens in modal instead of leaving stocks page.
  window.renderInventoryRows = renderInventoryRows = function(rows,target,selectable=false){
    let h='<table class="table inventory-table"><thead><tr><th>کاردکس</th><th>نام کالا</th><th>کد کالا</th><th>انبار</th><th>موجودی</th><th>قیمت پایه</th><th>انتخاب</th></tr></thead><tbody>';
    h+=(rows||[]).map((x,i)=>{
      const itemCode=x.itemCode||x.ItemCode||'';
      const itemDesc=x.itemDescription||x.ItemDesc||'';
      const itemGuid=x.itemGuid||x.ItemGuId||'';
      return `<tr><td><button class="mini cardex-btn-inline" data-code="${safe(itemCode)}" data-desc="${safe(itemDesc)}" data-guid="${safe(itemGuid)}" data-stock-number="${safe(x.stockNumber||x.STNumber)}">کاردکس</button></td><td>${safe(itemDesc)}</td><td>${safe(itemCode)}</td><td>${safe(x.stockNumber||x.STNumber)} - ${safe(x.stockName||x.StDesc)}</td><td>${nfmt(x.quantity||x.RemainQ)}</td><td>${nfmt(x.averageCost||x.Price)}</td><td>${selectable?`<button class="btn green pick-stock-search" data-row='${safe(JSON.stringify(x))}'>انتخاب</button>`:''}</td></tr>`;
    }).join('');
    const el=$(target); if(el) el.innerHTML=h+'</tbody></table>';
    document.querySelectorAll('.cardex-btn-inline').forEach(b=>b.onclick=(ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      openInventoryCardexModal({itemCode:b.dataset.code,itemDescription:b.dataset.desc,itemGuid:b.dataset.guid,stockNumber:b.dataset.stockNumber||''});
    });
    if(selectable) document.querySelectorAll('.pick-stock-search').forEach(b=>b.onclick=()=>{const raw=JSON.parse(b.dataset.row);const {item,stock}=rawToItemStock(raw);selectSaleStock(item,stock)});
  };
  const style=document.createElement('style');
  style.textContent=`.mk-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9999;align-items:center;justify-content:center;padding:22px}.mk-modal-card{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);max-height:88vh;overflow:hidden;display:flex;flex-direction:column}.mk-modal-card-wide{width:min(1180px,96vw)}.mk-modal-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid #e5edf8;background:#f8fbff}.mk-modal-body{padding:14px 18px;overflow:auto}.mk-modal-body .table{font-size:12px}.inventory-table .cardex-btn-inline{white-space:nowrap}`;
  document.head.appendChild(style);
})();


/* PATCH 0.9.12: authoritative live inventory + unified cardex modal from every inventory path. */
(function(){
  const V='0.9.12-inventory-live-source-cardex-unified';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function qtyOf(x){ return Number(x?.quantity ?? x?.RemainQ ?? x?.Quantity1 ?? 0); }
  function priceOf(x){ return Number(x?.averageCost ?? x?.Price ?? x?.RemainUnit1Price ?? 0); }
  function stockNoOfLocal(x){ return String(x?.stockNumber ?? x?.STNumber ?? x?.StoreNumber ?? ''); }
  function stockNameOf(x){ return String(x?.stockName ?? x?.StDesc ?? x?.StoreName ?? ''); }
  function itemCodeOf(x){ return String(x?.itemCode ?? x?.ItemCode ?? ''); }
  function itemDescOf(x){ return String(x?.itemDescription ?? x?.ItemDesc ?? x?.ItemDescription ?? ''); }
  function itemGuidOf(x){ return String(x?.itemGuid ?? x?.ItemGuId ?? x?.ItemGuid ?? ''); }

  window.groupStockRows = groupStockRows = function(rows){
    const m=new Map();
    (rows||[]).filter(r=>qtyOf(r)>0).forEach(r=>{
      const code=itemCodeOf(r); const guid=itemGuidOf(r); if(!code)return;
      const key=(guid||'no-guid')+'|'+code;
      if(!m.has(key))m.set(key,{itemCode:code,itemDescription:itemDescOf(r),itemGuid:guid,rows:[],total:0,duplicateSafeKey:key});
      const g=m.get(key); g.rows.push(r); g.total+=qtyOf(r);
    });
    return [...m.values()].sort((a,b)=>b.total-a.total||String(a.itemDescription).localeCompare(String(b.itemDescription),'fa'));
  };

  window.rawToItemStock = rawToItemStock = function(raw){
    const item={itemCode:itemCodeOf(raw),itemDescription:itemDescOf(raw),itemGuid:itemGuidOf(raw)};
    const stock={itemCode:item.itemCode,itemDescription:item.itemDescription,itemGuid:item.itemGuid,stockNumber:stockNoOfLocal(raw),stockName:stockNameOf(raw),stockGuid:raw.STGuId||raw.stockGuid||raw.StockGuId||'',quantity:qtyOf(raw),averageCost:priceOf(raw)};
    return {item,stock};
  };

  window.renderStockGroupHtml = renderStockGroupHtml = function(g, opts={}){
    const rows=(g.rows||[]).filter(r=>qtyOf(r)>0).slice().sort((a,b)=>qtyOf(b)-qtyOf(a));
    const stockHtml=rows.map(r=>{const row=JSON.stringify(r).replace(/'/g,'&#39;');return `<div class="stock-line"><span class="stock-name">${safe(stockNoOfLocal(r))} - ${safe(stockNameOf(r))}</span><span class="stock-qty">موجودی: ${nfmt(qtyOf(r))}</span><span class="stock-price">قیمت پایه: ${nfmt(priceOf(r))}</span><button class="mini kardex-stock-row" data-row='${safe(row)}'>کاردکس</button>${opts.selectStock?`<button class="mini choose-stock-row" data-row='${safe(row)}'>انتخاب این انبار</button>`:''}</div>`}).join('');
    return `<div class="floating-item stock-group" data-code="${safe(g.itemCode)}" data-desc="${safe(g.itemDescription)}" data-guid="${safe(g.itemGuid)}"><div class="item-title">${safe(g.itemDescription)}</div><div class="item-meta"><span class="pill">${safe(g.itemCode)}</span><span class="pill stock">جمع موجودی: ${nfmt(g.total)}</span><span class="pill">${rows.length} انبار</span><span class="pill">live</span></div><div class="stock-lines">${stockHtml}</div></div>`;
  };

  async function verifyLiveInventory(code, stockNumber=''){
    const url=`/api/items/${encodeURIComponent(code)}/inventory${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`;
    const r=await api(url);
    return {ok:!!r.ok, rows:(r.list||[]).filter(x=>qtyOf(x)>0), error:r.error||''};
  }

  const oldSelectSaleStock = window.selectSaleStock || selectSaleStock;
  window.selectSaleStock = selectSaleStock = async function(item,stock){
    const code=item?.itemCode||stock?.itemCode; const sn=stock?.stockNumber||'';
    const box=$('#saleInventory'); if(box) box.innerHTML='<div class="info">در حال کنترل موجودی لحظه‌ای شایگان...</div>';
    const live=await verifyLiveInventory(code,sn);
    if(!live.ok){ if(box) box.innerHTML=`<div class="error">کنترل موجودی زنده ناموفق بود: ${safe(live.error)}</div>`; return; }
    const row=live.rows.find(x=>stockNoOfLocal(x)===String(sn)) || live.rows[0];
    if(!row){
      state.selectedItem=null; state.selectedStock=null;
      if($('#STNumber')) $('#STNumber').value='';
      if(box) box.innerHTML='<div class="warn">این کالا در این لحظه در شایگان موجودی قابل فروش ندارد. انتخاب برای فاکتور فروش مجاز نیست.</div>';
      return;
    }
    const is=rawToItemStock(row);
    return oldSelectSaleStock(is.item,is.stock);
  };

  window.renderInventory = renderInventory = async function(itemCode,target,selectable=false,stockNumber=''){
    const el=$(target); if(el) el.innerHTML='در حال خواندن موجودی لحظه‌ای شایگان...';
    const r=await verifyLiveInventory(itemCode,stockNumber);
    if(!r.ok){ if(el) el.innerHTML=`<div class="error">${safe(r.error)}</div>`; return; }
    const rows=r.rows;
    if(!rows.length){ if(el) el.innerHTML='<div class="warn">برای این کالا موجودی قابل فروش در شایگان پیدا نشد.</div>'; return; }
    renderInventoryRows(rows,target,selectable);
  };

  window.renderInventoryRows = renderInventoryRows = function(rows,target,selectable=false){
    const liveRows=(rows||[]).filter(x=>qtyOf(x)>0);
    let h='<table class="table inventory-table"><thead><tr><th>کاردکس</th><th>نام کالا</th><th>کد کالا</th><th>انبار</th><th>موجودی</th><th>قیمت پایه</th><th>انتخاب</th></tr></thead><tbody>';
    h+=liveRows.map(x=>{
      const row=JSON.stringify(x).replace(/'/g,'&#39;');
      return `<tr><td><button class="mini cardex-btn-inline" data-row='${safe(row)}'>کاردکس</button></td><td>${safe(itemDescOf(x))}</td><td>${safe(itemCodeOf(x))}</td><td>${safe(stockNoOfLocal(x))} - ${safe(stockNameOf(x))}</td><td>${nfmt(qtyOf(x))}</td><td>${nfmt(priceOf(x))}</td><td>${selectable?`<button class="btn green pick-stock-search" data-row='${safe(row)}'>انتخاب</button>`:''}</td></tr>`;
    }).join('');
    const el=$(target); if(el) el.innerHTML= liveRows.length ? h+'</tbody></table>' : '<div class="warn">موجودی قابل فروش پیدا نشد.</div>';
    document.querySelectorAll('.cardex-btn-inline,.kardex-stock-row').forEach(b=>b.onclick=(ev)=>{ev.preventDefault();ev.stopPropagation();const raw=JSON.parse(b.dataset.row);openInventoryCardexModal({itemCode:itemCodeOf(raw),itemDescription:itemDescOf(raw),itemGuid:itemGuidOf(raw),stockNumber:stockNoOfLocal(raw)});});
    if(selectable) document.querySelectorAll('.pick-stock-search,.choose-stock-row').forEach(b=>b.onclick=async(ev)=>{ev.preventDefault();ev.stopPropagation();const raw=JSON.parse(b.dataset.row);const {item,stock}=rawToItemStock(raw);await selectSaleStock(item,stock);});
  };

  // Make autocomplete inventory live-authoritative: do not use old client cache when stock may have gone zero.
  window.bindItemSearch = bindItemSearch = function(prefix,onPick,opts={}){
    const q=$(`#${prefix}Q`), box=$(`#${prefix}List`), msg=$(`#${prefix}Msg`); const limit=Number(opts.limit||300); let seq=0;
    async function liveSearch(showBox=true){
      const val=q.value.trim(); const stock=opts.getStockFilter?opts.getStockFilter():'';
      if(val.length<2){box.innerHTML='';box.style.display='none';if(msg)msg.textContent='';return []}
      const my=++seq; if(showBox){box.style.display='block';box.innerHTML='<div class="floating-empty">در حال کنترل موجودی لحظه‌ای...</div>';} if(msg)msg.textContent='در حال خواندن موجودی زنده شایگان...';
      const r=await searchStockRows(val,limit,stock); if(my!==seq)return [];
      const rows=(r.list||[]).filter(x=>qtyOf(x)>0);
      const groups=groupStockRows(rows);
      if(msg)msg.textContent=`${groups.length} کالا | ${rows.length} ردیف موجودی زنده | ${r.source||''}${r.scannedPages?' | '+r.scannedPages+' صفحه':''}${r.error?' | خطا: '+r.error:''}`;
      if(showBox){
        box.style.display='block'; box.innerHTML=groups.map(g=>renderStockGroupHtml(g,opts)).join('') || '<div class="floating-empty">موجودی قابل فروش پیدا نشد.</div>';
        box.querySelectorAll('.stock-group').forEach(el=>el.onclick=(ev)=>{if(ev.target.classList.contains('choose-stock-row')||ev.target.classList.contains('kardex-stock-row'))return;const item={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription}`;box.style.display='none';onPick(item, groups.find(g=>g.itemCode===item.itemCode));});
        box.querySelectorAll('.choose-stock-row').forEach(btn=>btn.onclick=async(ev)=>{ev.stopPropagation();const raw=JSON.parse(btn.dataset.row);const {item,stock}=rawToItemStock(raw);$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription} | ${stock.stockNumber} - ${stock.stockName}`;box.style.display='none';if(opts.onStockPick) await opts.onStockPick(item,stock); else onPick(item,{rows:[raw],total:stock.quantity});});
        box.querySelectorAll('.kardex-stock-row').forEach(btn=>btn.onclick=(ev)=>{ev.stopPropagation();const raw=JSON.parse(btn.dataset.row);openInventoryCardexModal({itemCode:itemCodeOf(raw),itemDescription:itemDescOf(raw),itemGuid:itemGuidOf(raw),stockNumber:stockNoOfLocal(raw)});});
      }
      return groups;
    }
    const deb=debounce(()=>liveSearch(true),350);
    q.addEventListener('input',deb);
    q.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();const groups=await liveSearch(false);box.style.display='none';if(opts.onEnter) opts.onEnter(q.value.trim(),groups);else if(groups.length===1){const g=groups[0];onPick({itemCode:g.itemCode,itemDescription:g.itemDescription,itemGuid:g.itemGuid},g)}}});
    document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==q)box.style.display='none'});
    if(opts.filterElement){opts.filterElement.addEventListener('change',()=>{if(q.value.trim().length>=2)liveSearch(true)});}
  };
})();


/* FIX 0.9.13: complete inventory/cardex data-path + fast search
   - Search fields must NOT scan live inventory page-by-page while typing.
   - Search lists use fast item catalog; live inventory is checked only after product selection.
   - Every inventory-row cardex button opens the same paged Kardex modal, including stocks menu.
*/
(function(){
  const V='0.9.13.1-cardex-modal-stock-selector-full';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function qtyOf(x){ return Number(x?.quantity ?? x?.RemainQ ?? x?.Quantity1 ?? 0); }
  function priceOf(x){ return Number(x?.averageCost ?? x?.Price ?? x?.RemainUnit1Price ?? 0); }
  function stockNo(x){ return String(x?.stockNumber ?? x?.STNumber ?? x?.StoreNumber ?? ''); }
  function stockName(x){ return String(x?.stockName ?? x?.StDesc ?? x?.StoreName ?? ''); }
  function itemCode(x){ return String(x?.itemCode ?? x?.ItemCode ?? ''); }
  function itemDesc(x){ return String(x?.itemDescription ?? x?.ItemDesc ?? x?.ItemDescription ?? ''); }
  function itemGuid(x){ return String(x?.itemGuid ?? x?.ItemGuId ?? x?.ItemGuid ?? ''); }
  function productFromRow(x){return {itemCode:itemCode(x), itemDescription:itemDesc(x), itemGuid:itemGuid(x)}}
  function stockFromRow(x){return {itemCode:itemCode(x),itemDescription:itemDesc(x),itemGuid:itemGuid(x),stockNumber:stockNo(x),stockName:stockName(x),stockGuid:x?.stockGuid||x?.STGuId||x?.StockGuId||'',quantity:qtyOf(x),averageCost:priceOf(x)}}

  window.openInventoryCardexModal = async function(item){
    const code=itemCode(item||{}); if(!code) return alert('کد کالا برای کاردکس مشخص نیست');
    const initialStock=String(item.stockNumber||item.STNumber||'');
    const product={itemCode:code,itemDescription:itemDesc(item),itemGuid:itemGuid(item)};
    let modal=document.getElementById('inlineCardexModal');
    if(!modal){
      modal=document.createElement('div');
      modal.id='inlineCardexModal';
      modal.className='mk-modal-overlay';
      modal.style.display='none';
      document.body.appendChild(modal);
      modal.addEventListener('click',e=>{if(e.target===modal)uiModalController.close()});
    }
    modal.innerHTML=`<div class="mk-modal-card mk-modal-card-wide">
      <div class="mk-modal-head">
        <div>
          <b id="inlineCardexTitle">کاردکس کالا</b>
          <div id="inlineCardexSub" class="small muted"></div>
        </div>
        <button class="mini" id="inlineCardexClose">بستن</button>
      </div>
      <div class="mk-modal-toolbar" style="padding:10px 18px;border-bottom:1px solid #e5edf8;background:#fbfdff">
        <label class="small muted" for="inlineCardexStockSelect">انتخاب انبار در همین پنجره</label>
        <select id="inlineCardexStockSelect" style="min-width:260px;margin-inline-start:8px"></select>
      </div>
      <div id="inlineCardexBody" class="mk-modal-body"></div>
    </div>`;
    document.getElementById('inlineCardexClose').onclick=()=>uiModalController.close();
    const sel=document.getElementById('inlineCardexStockSelect');
    sel.innerHTML='<option value="">همه انبارها</option>';
    try{
      const stocks=(typeof loadStocks==='function') ? await loadStocks() : [];
      sel.innerHTML='<option value="">همه انبارها</option>'+(stocks||[]).map(s=>`<option value="${safe(s.stockNumber)}">${safe(s.stockNumber)} - ${safe(s.stockName||'')}</option>`).join('');
    }catch(e){ console.warn('stock selector load failed',e); }
    sel.value=initialStock;
    async function reloadCardex(){
      const sn=sel.value||'';
      document.getElementById('inlineCardexTitle').textContent=`کاردکس: ${code}`;
      document.getElementById('inlineCardexSub').textContent=sn?`فیلتر انبار: ${sn}`:'نمایش همه انبارها';
      await renderKardex(product, '#inlineCardexBody', sn);
    }
    sel.onchange=reloadCardex;
    modal.style.display='flex';uiModalController.open(modal,document.activeElement);
    await reloadCardex();
  };

  window.renderInventoryRows = renderInventoryRows = function(rows,target,selectable=false){
    const liveRows=(rows||[]).filter(x=>qtyOf(x)>0);
    const el=$(target); if(!el) return;
    if(!liveRows.length){el.innerHTML='<div class="warn">موجودی قابل فروش پیدا نشد.</div>';return;}
    let h='<table class="table inventory-table"><thead><tr><th>کاردکس</th><th>نام کالا</th><th>کد کالا</th><th>انبار</th><th>موجودی</th><th>قیمت پایه</th><th>انتخاب</th></tr></thead><tbody>';
    h+=liveRows.map(x=>{const row=JSON.stringify(x).replace(/'/g,'&#39;');return `<tr><td><button class="mini cardex-btn-inline" data-row='${safe(row)}'>کاردکس</button></td><td>${safe(itemDesc(x))}</td><td>${safe(itemCode(x))}</td><td>${safe(stockNo(x))} - ${safe(stockName(x))}</td><td>${nfmt(qtyOf(x))}</td><td>${nfmt(priceOf(x))}</td><td>${selectable?`<button class="btn green pick-stock-search" data-row='${safe(row)}'>انتخاب</button>`:''}</td></tr>`}).join('');
    el.innerHTML=h+'</tbody></table>';
    el.querySelectorAll('.cardex-btn-inline').forEach(b=>b.onclick=(ev)=>{ev.preventDefault();ev.stopPropagation();const raw=JSON.parse(b.dataset.row);openInventoryCardexModal({...productFromRow(raw),stockNumber:stockNo(raw)});});
    if(selectable) el.querySelectorAll('.pick-stock-search').forEach(b=>b.onclick=async(ev)=>{ev.preventDefault();ev.stopPropagation();const raw=JSON.parse(b.dataset.row);await selectSaleStock(productFromRow(raw),stockFromRow(raw));});
  };

  async function verifyLiveInventory(code, stockNumber=''){
    const url=`/api/items/${encodeURIComponent(code)}/inventory${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`;
    const r=await api(url);
    return {ok:!!r.ok, rows:(r.list||[]).filter(x=>qtyOf(x)>0), error:r.error||''};
  }

  const previousSelectSaleStock = window.selectSaleStock || selectSaleStock;
  window.selectSaleStock = selectSaleStock = async function(item,stock){
    const code=item?.itemCode||stock?.itemCode; const sn=stock?.stockNumber||'';
    const box=$('#saleInventory'); if(box) box.innerHTML='<div class="info">در حال کنترل موجودی لحظه‌ای شایگان برای کالای انتخاب‌شده...</div>';
    const live=await verifyLiveInventory(code,sn);
    if(!live.ok){ if(box) box.innerHTML=`<div class="error">کنترل موجودی زنده ناموفق بود: ${safe(live.error)}</div>`; return; }
    const row=live.rows.find(x=>stockNo(x)===String(sn)) || live.rows[0];
    if(!row){
      state.selectedItem=null; state.selectedStock=null;
      const st=$('#STNumber'); if(st) st.value='';
      if(box) box.innerHTML='<div class="warn">این کالا در این لحظه در شایگان موجودی قابل فروش ندارد. انتخاب برای فاکتور فروش مجاز نیست.</div>';
      return;
    }
    return previousSelectSaleStock(productFromRow(row), stockFromRow(row));
  };

  window.renderInventory = renderInventory = async function(code,target,selectable=false,stockNumber=''){
    const el=$(target); if(el) el.innerHTML='در حال خواندن موجودی لحظه‌ای شایگان برای کالای انتخاب‌شده...';
    const live=await verifyLiveInventory(code,stockNumber);
    if(!live.ok){ if(el) el.innerHTML=`<div class="error">${safe(live.error)}</div>`; return; }
    if(!live.rows.length){ if(el) el.innerHTML='<div class="warn">برای این کالا موجودی قابل فروش در شایگان پیدا نشد.</div>'; return; }
    renderInventoryRows(live.rows,target,selectable);
  };

  window.renderInventorySearch = renderInventorySearch = async function(query,target,selectable=false,stockNumber=''){
    const el=$(target); if(el) el.innerHTML='در حال جستجوی سریع کالا در کاتالوگ...';
    const r=await searchAllItemsRows(query,120,false);
    const list=(r.list||[]).map(productFromRow).filter(x=>x.itemCode);
    if(!list.length){ if(el) el.innerHTML='<div class="warn">کالایی پیدا نشد. اگر کاتالوگ ناقص است، Sync All Items Catalog را اجرا کنید.</div>'; return; }
    let h=`<div class="small muted">${list.length} کالا پیدا شد | جستجو سریع است؛ موجودی فقط بعد از انتخاب کالا از شایگان کنترل می‌شود.</div><table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>موجودی/کاردکس</th></tr></thead><tbody>`;
    h+=list.map(x=>`<tr><td>${safe(x.itemCode)}</td><td>${safe(x.itemDescription)}</td><td><button class="btn check-inventory-product" data-code="${safe(x.itemCode)}" data-desc="${safe(x.itemDescription)}" data-guid="${safe(x.itemGuid)}">بررسی موجودی زنده</button> <button class="mini open-cardex-product" data-code="${safe(x.itemCode)}" data-desc="${safe(x.itemDescription)}" data-guid="${safe(x.itemGuid)}" data-stock-number="${safe(stockNumber)}">کاردکس</button></td></tr>`).join('');
    el.innerHTML=h+'</tbody></table>';
    el.querySelectorAll('.check-inventory-product').forEach(b=>b.onclick=()=>renderInventory(b.dataset.code,target,selectable,stockNumber));
    el.querySelectorAll('.open-cardex-product').forEach(b=>b.onclick=()=>openInventoryCardexModal({itemCode:b.dataset.code,itemDescription:b.dataset.desc,itemGuid:b.dataset.guid,stockNumber:b.dataset.stockNumber||''}));
  };

  // Fast autocomplete: product catalog only. No live inventory scan while typing.
  window.bindItemSearch = bindItemSearch = function(prefix,onPick,opts={}){
    const q=$(`#${prefix}Q`), box=$(`#${prefix}List`), msg=$(`#${prefix}Msg`); if(!q||!box) return;
    const limit=Number(opts.limit||80); let seq=0,requestController=null;
    const managedPopup=true;
    uiPageLifecycle.add(()=>{seq++;if(requestController)requestController.abort();requestController=null;});
    async function fastSearch(showBox=true){
      const val=q.value.trim();
      if(val.length<2){box.innerHTML='';if(managedPopup)popupSuggestionController.close({restoreFocus:false});else box.style.display='none';if(msg)msg.textContent='';return []}
      const my=++seq;if(requestController)requestController.abort();requestController=new AbortController();
      if(showBox){box.style.display='block';box.innerHTML='<div class="floating-empty">در حال جستجوی سریع کالا...</div>';if(managedPopup)popupSuggestionController.open({popup:box,trigger:q,optionSelector:'.product-row'});}
      if(msg) msg.textContent='جستجوی سریع کالا؛ موجودی بعد از انتخاب کنترل می‌شود.';
      let r;try{r=await searchAllItemsRows(val,limit,false,{signal:requestController.signal});}catch(e){if(e.name==='AbortError')return [];throw e;} if(my!==seq) return [];
      const list=(r.list||[]).map(productFromRow).filter(x=>x.itemCode);
      if(msg) msg.textContent=`${list.length} کالا | ${r.source||''}${r.cacheCount?' | کش: '+r.cacheCount:''}${r.scannedPages?' | '+r.scannedPages+' صفحه سریع':''}${r.note?' | '+r.note:''}`;
      if(showBox){
        box.style.display='block';
        box.innerHTML=list.map(x=>`<div class="product-row" data-code="${safe(x.itemCode)}" data-desc="${safe(x.itemDescription)}" data-guid="${safe(x.itemGuid)}"><b>${safe(x.itemDescription)}</b><div class="small muted">کد: ${safe(x.itemCode)} | موجودی پس از انتخاب کنترل می‌شود</div></div>`).join('') || '<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>';
        box.querySelectorAll('.product-row').forEach(el=>el.onclick=()=>{const item={itemCode:el.dataset.code,itemDescription:el.dataset.desc,itemGuid:el.dataset.guid};$(`#${prefix}Selected`).value=`${item.itemCode} - ${item.itemDescription}`;if(managedPopup)popupSuggestionController.close();else box.style.display='none';onPick(item,list)});
        if(managedPopup)popupSuggestionController.open({popup:box,trigger:q,optionSelector:'.product-row'});
      }
      return list;
    }
    const deb=debounce(()=>fastSearch(true),250);
    q.addEventListener('input',deb);
    q.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();const list=await fastSearch(false);box.style.display='none';if(opts.onEnter) opts.onEnter(q.value.trim(),list);else if(list.length===1) onPick(list[0],list)}});
    if(opts.filterElement){opts.filterElement.addEventListener('change',()=>{const val=q.value.trim(); if(val.length>=2 && opts.onEnter) opts.onEnter(val,[]);});}
  };

  // Capture old inventory-cardex buttons that earlier functions may still render.
  if(!window.__mkcrmCardexDelegation0913){
    window.__mkcrmCardexDelegation0913=true;
    document.addEventListener('click',function(ev){
      const b=ev.target.closest && ev.target.closest('.cardex-btn,.cardex-btn-inline,.kardex-stock-row');
      if(!b) return;
      ev.preventDefault(); ev.stopPropagation();
      try{
        if(b.dataset.row){const raw=JSON.parse(b.dataset.row); return openInventoryCardexModal({...productFromRow(raw),stockNumber:stockNo(raw)});}
        const tr=b.closest('tr');
        const cells=tr ? Array.from(tr.children).map(td=>td.textContent.trim()) : [];
        const code=b.dataset.code || cells[2] || '';
        const desc=b.dataset.desc || cells[1] || '';
        const sn=b.dataset.stockNumber || (cells[3]||'').split('-')[0].trim() || '';
        if(code) return openInventoryCardexModal({itemCode:code,itemDescription:desc,stockNumber:sn});
      }catch(e){ console.error('cardex open failed',e); }
    }, true);
  }
})();

/* FIX 0.9.13.2: sale/stocks search bulk live-inventory check
   - Remove per-product live inventory buttons from search-result table.
   - Add one top action: check live inventory for current visible search results.
   - Keep final selection live verification unchanged.
*/
(function(){
  const V='0.9.13.2-bulk-live-inventory-search-results';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function qtyOf(x){return Number(x?.quantity ?? x?.RemainQ ?? x?.Quantity1 ?? 0)}
  function itemCode(x){return String(x?.itemCode ?? x?.ItemCode ?? '')}
  function itemDesc(x){return String(x?.itemDescription ?? x?.ItemDesc ?? x?.ItemDescription ?? '')}
  function itemGuid(x){return String(x?.itemGuid ?? x?.ItemGuId ?? x?.ItemGuid ?? '')}
  function productFromRow(x){return {itemCode:itemCode(x),itemDescription:itemDesc(x),itemGuid:itemGuid(x)}}
  async function readLiveInventoryForProduct(product, stockNumber=''){
    const url=`/api/items/${encodeURIComponent(product.itemCode)}/inventory${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`;
    const r=await api(url);
    if(!r.ok) return {ok:false, product, rows:[], error:r.error||'خطا در خواندن موجودی'};
    const rows=(r.list||[]).filter(x=>qtyOf(x)>0).map(x=>Object.assign({}, x, {
      itemCode: itemCode(x) || product.itemCode,
      itemDescription: itemDesc(x) || product.itemDescription,
      itemGuid: itemGuid(x) || product.itemGuid
    }));
    return {ok:true, product, rows};
  }
  async function checkProductsWithLimit(products, stockNumber, progressEl){
    const out=[]; const errors=[];
    for(let i=0;i<products.length;i++){
      if(progressEl) progressEl.textContent=`در حال بررسی موجودی زنده ${i+1} از ${products.length}...`;
      try{
        const r=await readLiveInventoryForProduct(products[i], stockNumber);
        if(r.ok) out.push(...r.rows); else errors.push(`${products[i].itemCode}: ${r.error}`);
      }catch(e){errors.push(`${products[i].itemCode}: ${e.message||e}`)}
      await new Promise(res=>setTimeout(res,20));
    }
    return {rows:out, errors};
  }

  window.renderInventorySearch = renderInventorySearch = async function(query,target,selectable=false,stockNumber=''){
    const el=$(target); if(!el) return;
    el.innerHTML='در حال جستجوی سریع کالا در کاتالوگ...';
    const r=await searchAllItemsRows(query,120,false);
    const list=(r.list||[]).map(productFromRow).filter(x=>x.itemCode);
    if(!list.length){el.innerHTML='<div class="warn">کالایی پیدا نشد. اگر کاتالوگ ناقص است، Sync All Items Catalog را اجرا کنید.</div>';return;}
    const maxLive = selectable ? 20 : 30;
    const canCheck = list.length <= maxLive;
    let h=`<div class="actions" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div class="small muted">${nfmt(list.length)} کالا پیدا شد | سرچ سریع از کاتالوگ است؛ موجودی زنده فقط با دکمه بالای جدول برای همین نتایج بررسی می‌شود.</div>
      <button class="btn ${canCheck?'':'disabled'}" id="bulkLiveInventoryCheck" ${canCheck?'':'disabled'}>بررسی موجودی نتایج فعلی</button>
    </div>`;
    if(!canCheck){
      h+=`<div class="warn">تعداد نتایج زیاد است (${nfmt(list.length)}). برای جلوگیری از کندی، عبارت جستجو را دقیق‌تر کنید. سقف بررسی زنده این بخش ${nfmt(maxLive)} کالا است.</div>`;
    } else {
      h+=`<div class="info">با زدن دکمه بالا، موجودی زنده همین ${nfmt(list.length)} کالا از شایگان خوانده می‌شود و سپس فقط انبارهای دارای موجودی قابل انتخاب هستند.</div>`;
    }
    h+=`<div id="bulkInventoryProgress" class="small muted"></div><table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>کاردکس</th></tr></thead><tbody>`;
    h+=list.map(x=>`<tr><td>${safe(x.itemCode)}</td><td>${safe(x.itemDescription)}</td><td><button class="mini open-cardex-product" data-code="${safe(x.itemCode)}" data-desc="${safe(x.itemDescription)}" data-guid="${safe(x.itemGuid)}" data-stock-number="${safe(stockNumber)}">کاردکس</button></td></tr>`).join('');
    h+='</tbody></table><div id="bulkInventoryRows"></div>';
    el.innerHTML=h;
    el.querySelectorAll('.open-cardex-product').forEach(b=>b.onclick=()=>openInventoryCardexModal({itemCode:b.dataset.code,itemDescription:b.dataset.desc,itemGuid:b.dataset.guid,stockNumber:b.dataset.stockNumber||''}));
    const btn=el.querySelector('#bulkLiveInventoryCheck');
    if(btn){
      btn.onclick=async()=>{
        btn.disabled=true;
        const progress=el.querySelector('#bulkInventoryProgress');
        const rowsBox=el.querySelector('#bulkInventoryRows');
        rowsBox.innerHTML='';
        const checked=list.slice(0,maxLive);
        const res=await checkProductsWithLimit(checked,stockNumber,progress);
        if(progress) progress.textContent=`بررسی تمام شد: ${nfmt(res.rows.length)} ردیف موجودی قابل فروش از ${nfmt(checked.length)} کالا`;
        if(res.errors.length){rowsBox.innerHTML=`<div class="warn">${nfmt(res.errors.length)} خطا در خواندن موجودی رخ داد. موارد بدون پاسخ نمایش داده نشدند.</div>`;}
        const wrap=document.createElement('div');
        wrap.id='bulkInventoryRowsTable';
        rowsBox.appendChild(wrap);
        if(!res.rows.length){wrap.innerHTML='<div class="warn">برای نتایج فعلی موجودی قابل فروش پیدا نشد.</div>';return;}
        renderInventoryRows(res.rows,'#bulkInventoryRowsTable',selectable);
        btn.disabled=false;
      };
    }
  };
})();

/* FULL 0.9.13.3: fastest sale item selection from local positive-inventory snapshot
   Rule: sale typing never calls Shaygan. It reads Mongo itemInventoryCatalog only.
   Live Shaygan is called only once after choosing a specific item/stock, as final verification.
*/
(function(){
  const V='0.9.17.7-customer-search-js-guard';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function qtyOf(x){return Number(x?.quantity ?? x?.RemainQ ?? x?.Quantity1 ?? 0)}
  function debounceLocal(fn,ms){let t;return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
  function stockRowToItemStock(row){
    const item={itemCode:String(row.itemCode||''),itemDescription:String(row.itemDescription||''),itemGuid:String(row.itemGuid||'')};
    const stock={stockNumber:String(row.stockNumber||''),stockName:String(row.stockName||''),stockGuid:String(row.stockGuid||''),quantity:Number(row.quantity||0),averageCost:Number(row.averageCost||0),remainCost:Number(row.remainCost||0),snapshotSyncedAt:row.syncedAt||null};
    return {item,stock};
  }
  function renderSaleSnapshotGroups(box, groups){
    if(!groups.length){ box.innerHTML='<div class="floating-empty">کالای دارای موجودی پیدا نشد. عبارت را دقیق‌تر کنید.</div>'; return; }
    box.innerHTML=groups.map(g=>{
      const stocks=(g.stocks||[]).map(st=>`<button class="mini choose-sale-snapshot-stock" data-row='${safe(JSON.stringify(st))}'>${safe(st.stockNumber)} - ${safe(st.stockName)} | موجودی ${nfmt(st.quantity)}</button>`).join(' ');
      return `<div class="stock-group sale-snapshot-group"><div><b>${safe(g.itemDescription)}</b></div><div class="small muted">کد: ${safe(g.itemCode)} | جمع موجودی snapshot: ${nfmt(g.totalQty)}${g.lastSyncAt?' | آخرین sync: '+safe(String(g.lastSyncAt).slice(0,19).replace('T',' ')):''}</div><div class="stock-actions mt6">${stocks}</div></div>`;
    }).join('');
  }
  async function verifyAndSelectSaleStock(item, stock){
    const box=$('#saleInventory');
    if(box) box.innerHTML=`<div class="info">انبار انتخاب شد. در حال کنترل نهایی موجودی زنده همین کالا/انبار...</div>`;
    // Optimistic selection keeps UI fast; live check below will clear it if Shaygan says zero.
    state.selectedItem=item; state.selectedStock=stock; state.selectedSerials=[]; state.serialInfo=null;
    if($('#STNumber')) $('#STNumber').value=`${stock.stockNumber} - ${stock.stockName} (${stock.quantity})`;
    try{
      const r=await api(`/api/items/${encodeURIComponent(item.itemCode)}/inventory`);
      if(!r.ok) throw new Error(r.error||'خطا در کنترل موجودی زنده');
      const live=(r.list||[]).find(x=>String(x.stockNumber||x.STNumber||'')===String(stock.stockNumber));
      if(!live || qtyOf(live)<=0){
        state.selectedItem=null; state.selectedStock=null;
        if($('#STNumber')) $('#STNumber').value='';
        if(box) box.innerHTML='<div class="error">این کالا در انبار انتخاب‌شده دیگر موجودی زنده ندارد. دوباره از نتایج موجودی انتخاب کنید.</div>';
        return;
      }
      const liveStock={...stock, stockNumber:live.stockNumber||stock.stockNumber, stockName:live.stockName||stock.stockName, stockGuid:live.stockGuid||stock.stockGuid, quantity:qtyOf(live), averageCost:Number(live.averageCost||stock.averageCost||0), remainCost:Number(live.remainCost||stock.remainCost||0)};
      selectSaleStock(item, liveStock);
      if(box) box.innerHTML=`<div class="success">موجودی زنده تأیید شد: ${safe(item.itemDescription)} | ${safe(liveStock.stockNumber)} - ${safe(liveStock.stockName)} | موجودی ${nfmt(liveStock.quantity)}</div>`;
    }catch(e){
      state.selectedItem=null; state.selectedStock=null;
      if($('#STNumber')) $('#STNumber').value='';
      if(box) box.innerHTML=`<div class="error">کنترل نهایی موجودی زنده ناموفق بود: ${safe(e.message||e)}. ردیف به فاکتور اضافه نشد.</div>`;
    }
  }
  function bindSaleSnapshotSearch(){
    const q=$('#saleQ'), list=$('#saleList'), msg=$('#saleMsg');
    if(!q||!list) return;
    let seq=0, lastGroups=[];
    const search=debounceLocal(async()=>{
      const val=q.value.trim();
      state.selectedItem=null; state.selectedStock=null;
      if($('#STNumber')) $('#STNumber').value='';
      if($('#saleInventory')) $('#saleInventory').innerHTML='';
      if(val.length<2){list.style.display='none';list.innerHTML='';if(msg)msg.textContent='';return;}
      const my=++seq;
      list.style.display='block'; list.innerHTML='<div class="floating-empty">در حال جستجوی موجودی فعال CRM...</div>';
      if(msg) msg.textContent='سرچ فروش و موجودی از موتور یکپارچه موجودی فعال CRM.';
      try{
        const r=await api(`/api/sale/inventory-snapshot-search?q=${encodeURIComponent(val)}&limit=30`);
        if(my!==seq) return;
        lastGroups=r.groups||[];
        if(msg) msg.innerHTML=`${nfmt(lastGroups.length)} کالا دارای موجودی فعال | ${safe(r.source||'snapshot')}${r.stale?' | <span class="warn-inline">snapshot موجودی فعال است؛ در صورت خطا Sync موجودی را بررسی کنید</span>':''}`;
        renderSaleSnapshotGroups(list,lastGroups);
        list.querySelectorAll('.choose-sale-snapshot-stock').forEach(btn=>btn.onclick=async(ev)=>{
          ev.stopPropagation();
          const row=JSON.parse(btn.dataset.row||'{}');
          const {item,stock}=stockRowToItemStock(row);
          q.value=item.itemDescription||item.itemCode;
          $('#saleSelected').value=`${item.itemCode} - ${item.itemDescription}`;
          list.style.display='none';
          await verifyAndSelectSaleStock(item,stock);
        });
      }catch(e){
        if(my!==seq) return;
        list.innerHTML=`<div class="floating-empty">${safe(e.message||e)}</div>`;
        if(msg) msg.textContent='خطا در جستجوی snapshot موجودی';
      }
    },220);
    q.addEventListener('input',search);
    q.addEventListener('keydown',async e=>{
      if(e.key==='Enter'){
        e.preventDefault();
        const first=lastGroups?.[0]?.stocks?.[0];
        if(first){const {item,stock}=stockRowToItemStock(first); list.style.display='none'; $('#saleSelected').value=`${item.itemCode} - ${item.itemDescription}`; await verifyAndSelectSaleStock(item,stock);}
      }
    });
    document.addEventListener('click',e=>{if(list&&!list.contains(e.target)&&e.target!==q)list.style.display='none'});
  }
  window.bindSaleSnapshotSearch = bindSaleSnapshotSearch;
  const oldAddSaleLine = window.addSaleLine || addSaleLine;
  window.addSaleLine = addSaleLine = function(){
    if(!state.selectedItem||!state.selectedStock) return alert('اول کالا و انبار دارای موجودی را از لیست snapshot انتخاب کنید');
    return oldAddSaleLine();
  };
  const oldPageSale = window.pageSale || pageSale;
  window.pageSale = pageSale = async function(){
    state.saleLines=[];state.selectedItem=null;state.selectedStock=null;state.invoiceNumber=null;
    setPage('فاکتور فروش جدید',`<main class="main-content"><div class="card"><div class="card-header danger"><h5>فاکتور فروش جدید</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>نام خریدار</label><input id="buyerName"></div><div class="form-group"><label>موبایل</label><input id="buyerMobile"></div><div class="form-group"><label>کد ملی</label><input id="buyerNational"></div><div class="form-group"><label>Lead ID</label><input id="leadId"></div></div><div id="sellerMappingBox" class="mapping-box"></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا - سریع از موجودی آماده‌شده</h5></div><div class="card-body"><div class="info">جستجو از snapshot موجودی CRM انجام می‌شود؛ هنگام انتخاب انبار، موجودی زنده از WebService شایگان کنترل می‌شود.</div>${itemSearchWidget('sale')}<div id="saleInventory" class="mt"></div><div class="row three mt"><div class="form-group"><label>انبار انتخاب‌شده</label><input id="STNumber" readonly></div><div class="form-group"><label>تعداد</label><input id="Quan" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="Price" type="number"></div></div><div id="priceWarn"></div><div id="serialBox" class="mt"></div><div class="actions"><button class="btn green" id="addLineBtn">افزودن ردیف و رفتن به کالای بعدی</button></div><div id="saleLines" class="mt"></div><div class="actions"><button class="btn red" id="issueBtn">صدور فاکتور</button><div class="muted">شماره قطعی فاکتور در لحظه صدور مستقیم از شایگان خوانده و کنترل می‌شود.</div></div><div id="saleOut"></div></div></div></main>`);
    renderSellerMappingBox().catch(e=>{$('#sellerMappingBox').innerHTML=`<div class="error">خطا در خواندن اتصال صندوق/نماینده: ${safe(e.message)}</div>`});
    bindSaleSnapshotSearch();
    $('#Price').addEventListener('input',checkBelowCost);
    $('#addLineBtn').onclick=addSaleLine;
    renderSaleLines();
    const reserveBtn=$('#reserveBtn'); if(reserveBtn) reserveBtn.style.display='none';
    $('#issueBtn').onclick=issueSale;
  };
})();


/* FULL 0.9.13.4: snapshot route fix + stocks menu is positive-inventory snapshot only
   - Adds client use of /api/sale/inventory-snapshot-search (server route exists in this build).
   - Stocks menu search shows only rows with quantity > 0 from local inventory snapshot.
   - Removes the redundant "check current results live" workflow from stocks; live is only for single item final sale verification.
*/
(function(){
  const V='0.9.19.21-inventory-sale-search-unified';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function nfmt(v){try{return fmt(v);}catch{return Number(v||0).toLocaleString('fa-IR')}}
  function qsel(x){return document.querySelector(x)}
  function qtyOf(x){return Number(x?.quantity ?? x?.RemainQ ?? x?.Quantity1 ?? 0)}
  function itemCode(x){return String(x?.itemCode ?? x?.ItemCode ?? '')}
  function itemDesc(x){return String(x?.itemDescription ?? x?.ItemDesc ?? x?.ItemDescription ?? '')}
  function itemGuid(x){return String(x?.itemGuid ?? x?.ItemGuId ?? x?.ItemGuid ?? '')}
  function stockNo(x){return String(x?.stockNumber ?? x?.STNumber ?? '')}
  function stockName(x){return String(x?.stockName ?? x?.StDesc ?? '')}
  async function snapshotSearch(q, stockNumber='', limit=80){
    const url=`/api/inventory/search?q=${encodeURIComponent(q||'')}&limit=${Number(limit||80)}${stockNumber?`&stockNumber=${encodeURIComponent(stockNumber)}`:''}`;
    return await api(url);
  }
  async function warehouseInventory(stockNumber, limit=10000){
    return await api(`/api/inventory/by-stock?stockNumber=${encodeURIComponent(stockNumber||'')}&limit=${Number(limit||10000)}`);
  }
  function renderPositiveInventoryTable(rows, target, selectable=false){
    const el=qsel(target); if(!el) return;
    const positive=(rows||[]).filter(x=>qtyOf(x)>0);
    if(!positive.length){el.innerHTML='<div class="warn">کالای دارای موجودی پیدا نشد. عبارت را دقیق‌تر کنید.</div>';return;}
    let h='<table class="table"><thead><tr><th>کاردکس</th><th>نام کالا</th><th>کد کالا</th><th>انبار</th><th>موجودی</th><th>قیمت پایه</th><th>انتخاب</th></tr></thead><tbody>';
    h+=positive.map(x=>{
      const row=JSON.stringify(x).replace(/'/g,'&#39;');
      return `<tr><td><button class="mini cardex-btn-inline" data-row='${safe(row)}'>کاردکس</button></td><td>${safe(itemDesc(x))}</td><td>${safe(itemCode(x))}</td><td>${safe(stockNo(x))} - ${safe(stockName(x))}</td><td>${nfmt(qtyOf(x))}</td><td>${nfmt(x.averageCost||x.Price||0)}</td><td>${selectable?`<button class="btn green pick-stock-search" data-row='${safe(row)}'>انتخاب</button>`:''}</td></tr>`;
    }).join('');
    el.innerHTML=h+'</tbody></table>';
    el.querySelectorAll('.cardex-btn-inline').forEach(b=>b.onclick=(ev)=>{ev.preventDefault();ev.stopPropagation();const raw=JSON.parse(b.dataset.row||'{}');openInventoryCardexModal({itemCode:itemCode(raw),itemDescription:itemDesc(raw),itemGuid:itemGuid(raw),stockNumber:stockNo(raw)});});
    if(selectable) el.querySelectorAll('.pick-stock-search').forEach(b=>b.onclick=async(ev)=>{ev.preventDefault();ev.stopPropagation();const raw=JSON.parse(b.dataset.row||'{}');const item={itemCode:itemCode(raw),itemDescription:itemDesc(raw),itemGuid:itemGuid(raw)};const stock={stockNumber:stockNo(raw),stockName:stockName(raw),stockGuid:raw.stockGuid||raw.STGuId||'',quantity:qtyOf(raw),averageCost:Number(raw.averageCost||raw.Price||0)};await selectSaleStock(item,stock);});
  }
  window.renderInventorySearch = renderInventorySearch = async function(query,target,selectable=false,stockNumber=''){
    const el=qsel(target); if(el) el.innerHTML='در حال جستجوی موجودی فعال CRM...';
    const r=await snapshotSearch(query,stockNumber,120);
    if(!r.ok){ if(el) el.innerHTML=`<div class="error">${safe(r.error||'خطا در جستجوی موجودی snapshot')}</div>`; return; }
    const rows=(r.list||[]).filter(x=>qtyOf(x)>0);
    if(!rows.length){ if(el) el.innerHTML='<div class="warn">در snapshot موجودی، کالای دارای موجودی برای این عبارت پیدا نشد.</div>'; return; }
    if(el) el.innerHTML=`<div class="small muted">${nfmt(rows.length)} ردیف موجودی مثبت از snapshot | ${safe(r.source||'inventory-snapshot-positive')}</div><div id="stockRowsBox"></div>`;
    renderPositiveInventoryTable(rows,'#stockRowsBox',selectable);
  };
  window.pageStocks = pageStocks = function(){
    setPage('موجودی انبارها',`<main class="main-content"><div class="card overflow-hidden"><div class="page-header"><h2>موجودی انبارها</h2><div class="row two">${itemSearchWidget('stock')}${stockFilterWidget('stock')}</div><div class="actions"><button class="btn" id="showSelectedWarehouseBtn">نمایش کل موجودی انبار انتخاب‌شده</button></div><div class="small muted">جستجو از snapshot موجودی CRM (WebService) انجام می‌شود. برای انبارگردانی یا کنترل موجودی کامل، ابتدا انبار را انتخاب کن و «نمایش کل موجودی انبار انتخاب‌شده» را بزن.</div></div><div class="card-body"><div id="stockResults"></div></div></div></main>`);
    fillStockFilter('stock');
    const filter=qsel('#stockStockFilter');
    const q=qsel('#stockQ'), box=qsel('#stockList'), msg=qsel('#stockMsg');
    let timer=null;
    async function doSearch(){
      const val=(q?.value||'').trim(); const sn=(typeof getStockFilter==='function')?getStockFilter('stock'):'';
      if(val.length<2){ if(box){box.style.display='none';box.innerHTML='';} if(msg)msg.textContent=''; qsel('#stockResults').innerHTML=''; return; }
      if(msg) msg.textContent='در حال جستجوی موجودی snapshot...';
      const r=await snapshotSearch(val,sn,80);
      const rows=(r.list||[]).filter(x=>qtyOf(x)>0);
      if(msg) msg.textContent=`${nfmt(rows.length)} ردیف موجودی مثبت | ${safe(r.source||'snapshot')}`;
      renderPositiveInventoryTable(rows,'#stockResults',false);
    }
    async function showSelectedWarehouse(){
      const sn=(typeof getStockFilter==='function')?getStockFilter('stock'):(filter?.value||'');
      const el=qsel('#stockResults');
      if(!sn){ if(el) el.innerHTML='<div class="warn">برای انبارگردانی ابتدا یک انبار مشخص انتخاب کن؛ نمایش کل موجودی برای «همه انبارها» عمداً غیرفعال است تا صفحه سنگین نشود.</div>'; return; }
      if(msg) msg.textContent='در حال خواندن موجودی انبار انتخاب‌شده از WebService/snapshot...';
      if(el) el.innerHTML='<div class="info">در حال خواندن کل موجودی انبار انتخاب‌شده...</div>';
      try{
        const r=await warehouseInventory(sn,10000);
        const rows=(r.list||[]).filter(x=>qtyOf(x)>0);
        if(msg) msg.textContent=`${nfmt(rows.length)} ردیف موجودی مثبت انبار ${safe(sn)} | ${safe(r.source||'sql')}`;
        if(!rows.length){ if(el) el.innerHTML='<div class="warn">برای این انبار موجودی مثبت پیدا نشد.</div>'; return; }
        if(el) el.innerHTML=`<div class="small muted">${nfmt(rows.length)} ردیف موجودی مثبت برای انبار ${safe(sn)}. مناسب کنترل انبارگردانی.</div><div id="stockRowsBox"></div>`;
        renderPositiveInventoryTable(rows,'#stockRowsBox',false);
      }catch(e){ if(el) el.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
    }
    if(q){q.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(doSearch,250)});q.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doSearch();}});}
    if(filter) filter.onchange=()=>{ if((q?.value||'').trim().length>=2) doSearch(); };
    const btn=qsel('#showSelectedWarehouseBtn'); if(btn) btn.onclick=showSelectedWarehouse;
  };
})();

/* FULL 0.9.14.1: Shaygan fiscal database selector
   - Default behavior: auto-select latest CY database from SQL Server.
   - Admin can switch to manual database selection from Settings.
   - All SQL-read modules use the active fiscal database; WebService writes remain unchanged.
*/
(function(){
  const V='0.9.19.21-inventory-sale-search-unified';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function fmtDate(v){if(!v)return '';try{return new Date(v).toLocaleString('fa-IR');}catch{return String(v)}}
  async function pageSettingsFiscal(){
    setPage('تنظیمات',`<main class="main-content">
      <div class="card"><div class="card-header"><h5>تنظیمات دوره مالی شایگان</h5></div>
      <div class="card-body">
        <div class="info">اتصال مستقیم دیتابیس حذف شده است؛ خواندن‌ها از WebService و cache MongoDB انجام می‌شود.</div>
        <div id="fiscalStatus" class="mt">در حال خواندن دوره‌های مالی...</div>
        <div class="row three mt">
          <div class="form-group"><label>حالت انتخاب دوره</label><select id="fiscalMode"><option value="auto">خودکار - آخرین دیتابیس CY</option><option value="manual">دستی - انتخاب مدیر</option></select></div>
          <div class="form-group"><label>دوره مالی / دیتابیس</label><select id="fiscalDatabase"></select></div>
          <div class="form-group"><label>&nbsp;</label><button class="btn green" id="saveFiscalDb">ذخیره و اعمال</button></div>
        </div>
        <div id="fiscalMsg" class="mt"></div>
      </div></div>
      <div class="card"><div class="card-header"><h5>انبارهای فعال CRM</h5></div>
        <div class="card-body">
          <div class="info">فقط انبارهای انتخاب‌شده در سرچ، موجودی، کاردکس و گزارش خواب کالا نمایش/محاسبه می‌شوند. «همه انبارها» یعنی همه انبارهای فعال. اگر هیچ انباری انتخاب نشود، سیستم بدون محدودیت کار می‌کند.</div>
          <div class="actions"><button class="btn" id="loadActiveWarehouses">خواندن انبارها از شایگان</button><button class="btn green" id="saveActiveWarehouses">ذخیره انبارهای فعال</button></div>
          <div id="activeWarehouseMsg" class="mt"></div>
          <div id="activeWarehouseList" class="mt"></div>
        </div>
      </div>
      <div class="card"><div class="card-header"><h5>کنترل وضعیت WebService</h5></div><div class="card-body"><button class="btn" id="checkSqlHealth">وضعیت اتصال قدیمی غیرفعال</button><div id="sqlHealthOut" class="mt"></div></div></div>
    </main>`);
    async function load(){
      const r=await api('/api/shaygan/fiscal-databases');
      const list=r.list||[];
      $('#fiscalMode').value=(r.mode||r.savedMode||'auto')==='manual'?'manual':'auto';
      $('#fiscalDatabase').innerHTML=list.map(x=>`<option value="${safe(x.name)}">${safe(x.name)} - ایجاد: ${safe(fmtDate(x.create_date))}${x.name===r.latestDatabase?' - آخرین':''}</option>`).join('');
      $('#fiscalDatabase').value=r.selectedDatabase||r.activeDatabase||r.latestDatabase||list[0]?.name||'';
      $('#fiscalStatus').innerHTML=`<div class="success">دوره فعال فعلی: <b>${safe(r.activeDatabase||'')}</b> | آخرین دوره شناسایی‌شده: <b>${safe(r.latestDatabase||'')}</b> | حالت: <b>${(r.mode||'auto')==='manual'?'دستی':'خودکار'}</b></div>`;
      $('#fiscalDatabase').disabled=$('#fiscalMode').value!=='manual';
      $('#fiscalMode').onchange=()=>{$('#fiscalDatabase').disabled=$('#fiscalMode').value!=='manual'};
    }
    $('#saveFiscalDb').onclick=async()=>{
      $('#fiscalMsg').innerHTML='در حال اعمال...';
      try{
        const mode=$('#fiscalMode').value;
        const database=$('#fiscalDatabase').value;
        const r=await post('/api/shaygan/fiscal-database',{mode,database});
        $('#fiscalMsg').innerHTML=`<div class="success">ذخیره شد. دیتابیس فعال: <b>${safe(r.activeDatabase||'')}</b></div>`;
        await load();
      }catch(e){$('#fiscalMsg').innerHTML=`<div class="error">${safe(e.message)}</div>`;}
    };
    async function loadActiveWarehouses(){
      const msg=$('#activeWarehouseMsg'), box=$('#activeWarehouseList');
      if(!msg || !box) return;
      msg.innerHTML='در حال خواندن انبارها...'; box.innerHTML='';
      try{
        const r=await api('/api/settings/active-warehouses');
        const active=new Set((r.activeWarehouseNumbers||[]).map(String));
        const stocks=r.stocks||[];
        msg.innerHTML=r.unrestricted?'<div class="warn">هیچ انبار فعالی انتخاب نشده؛ فعلاً همه انبارهای شایگان مجاز هستند.</div>':`<div class="success">${safe(active.size)} انبار فعال انتخاب شده است.</div>`;
        box.innerHTML=`<div class="actions"><button class="mini" id="selectAllWh">انتخاب همه</button><button class="mini" id="clearAllWh">حذف انتخاب‌ها</button></div>`+
          `<div class="warehouse-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">`+
          stocks.map(st=>{const sn=String(st.stockNumber||st.STNumber||st.StockNumber||'');return `<label class="checkline"><input type="checkbox" class="active-wh" value="${safe(sn)}" ${active.has(sn)?'checked':''}> ${safe(sn)} - ${safe(st.stockName||st.StockName||'')}</label>`}).join('')+
          `</div>`;
        const boxes=()=>Array.from(document.querySelectorAll('.active-wh'));
        $('#selectAllWh').onclick=()=>boxes().forEach(x=>x.checked=true);
        $('#clearAllWh').onclick=()=>boxes().forEach(x=>x.checked=false);
      }catch(e){msg.innerHTML=`<div class="error">${safe(e.message)}</div>`;}
    }
    const loadWhBtn=$('#loadActiveWarehouses'); if(loadWhBtn) loadWhBtn.onclick=loadActiveWarehouses;
    const saveWhBtn=$('#saveActiveWarehouses'); if(saveWhBtn) saveWhBtn.onclick=async()=>{
      const activeWarehouseNumbers=Array.from(document.querySelectorAll('.active-wh:checked')).map(x=>x.value);
      if(!activeWarehouseNumbers.length && !confirm('هیچ انباری انتخاب نشده؛ یعنی همه انبارها مجاز می‌مانند. ادامه؟')) return;
      const r=await post('/api/settings/active-warehouses',{activeWarehouseNumbers});
      $('#activeWarehouseMsg').innerHTML=r.ok?'<div class="success">انبارهای فعال ذخیره شد. اثر آن روی سرچ، موجودی، کاردکس و خواب کالا اعمال می‌شود.</div>':`<div class="error">${safe(r.error||'خطا')}</div>`;
      state.stocks=null; state._stocks=null;
    };
    $('#checkSqlHealth').onclick=async()=>{
      $('#sqlHealthOut').innerHTML='در حال تست...';
      try{const r=await api('/api/shaygan/sql-health');$('#sqlHealthOut').innerHTML=`<pre class="debug-pre">${safe(JSON.stringify(r,null,2))}</pre>`;}catch(e){$('#sqlHealthOut').innerHTML=`<div class="error">${safe(e.message)}</div>`;}
    };
    try{await load();}catch(e){$('#fiscalStatus').innerHTML=`<div class="error">${safe(e.message)}</div>`;}
  }
  window.pageSettings = pageSettingsFiscal;
  window.route = route = async function(){
    let p=location.hash.slice(1)||firstAllowedPage();
    if(!canPage(p)){p=firstAllowedPage();location.hash=p;return;}
    if(p==='dashboard')return dashboard();
    if(p==='stocks')return pageStocks();
    if(p==='cardex')return pageCardex();
    if(p==='sale')return pageSale();
    if(p==='proforma')return pageProforma();
    if(p==='proforma-list')return pageProformaArchive();
    if(p==='turnover')return pageTurnover();
    if(p==='account-set')return pageAccountSet();
    if(p==='settings')return pageSettingsFiscal();
    if(p==='users')return pageUsers();
    if(p==='seller-profit')return pageSellerProfit();if(p==='reports')return pageReports();
    if(p==='customers')return pageCustomers();
    if(p==='buy')return pagePurchaseDraft();
    if(p==='purchase-drafts')return pagePurchaseDraftArchive();
    if(p==='app-logs')return pageAppLogs();
    return placeholder($$('.navbtn').find(b=>b.dataset.page===p)?.textContent||p);
  };
})();

/* FULL 0.9.14.2: restore customer bank search on sale page after SQL/fiscal pageSale override
   - Reason: 0.9.14 SQL sale page replaced pageSale and bypassed older 0.9.6 customer-bank wrapper.
   - Fix: after the final sale page renders, inject CRM customer search/autofill again.
   - Backend customer bank endpoints remain unchanged: /api/customers/search, /api/customers/stats, /api/customers/sync-shaygan-sales.
*/
(function(){
  const V='0.9.14.2-sql-fiscal-customer-bank-restore';
  window.MKCRM_VERSION = V;
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function labelCustomer(c){
    return `${c.fullName||c.customerName||'بدون نام'} ${c.mobile?' | '+c.mobile:''} ${c.nationalCode?' | کد ملی '+c.nationalCode:''} ${c.purchaseCount?` | ${c.purchaseCount} خرید`:''}`;
  }
  function fillSaleCustomer(c){
    if(!c) return;
    const name=c.fullName||c.customerName||c.name||'';
    if($('#buyerName')) $('#buyerName').value=name;
    if($('#buyerMobile')) $('#buyerMobile').value=c.mobile||'';
    if($('#buyerNational')) $('#buyerNational').value=c.nationalCode||'';
    const hint=$('#saleCustomerHint');
    if(hint) hint.innerHTML=`<div class="success">مشتری از بانک CRM انتخاب شد: ${safe(labelCustomer(c))}</div>`;
  }
  function installSaleCustomerSearch(){
    if(!$('#buyerName') || $('#saleCustomerSearchBox')) return;
    const buyerRow=$('#buyerName').closest('.row') || $('#buyerName').parentElement?.parentElement;
    if(!buyerRow || !buyerRow.parentElement) return;
    const wrap=document.createElement('div');
    wrap.id='saleCustomerSearchBox';
    wrap.className='card customer-autofill-card';
    wrap.innerHTML=`<div class="card-body">
      <div class="info">بانک مشتریان CRM: با نام، موبایل یا کد ملی جستجو کن و اطلاعات مشتری را به فاکتور فروش منتقل کن.</div>
      <div class="form-group account-picker">
        <label>جستجوی مشتری</label>
        <input id="saleCustomerSearch" placeholder="نام / موبایل / کد ملی" autocomplete="off">
        <div id="saleCustomerResults" class="floating-list account-list"></div>
      </div>
      <div id="saleCustomerHint" class="mt6"></div>
    </div>`;
    buyerRow.parentElement.appendChild(wrap);
    const input=$('#saleCustomerSearch');
    const list=$('#saleCustomerResults');
    let timer=null;
    input.addEventListener('input',()=>{
      clearTimeout(timer);
      const q=input.value.trim();
      if(q.length<2){list.style.display='none';list.innerHTML='';return;}
      timer=setTimeout(async()=>{
        try{
          const r=await api(`/api/customers/search?q=${encodeURIComponent(q)}&limit=20`);
          const arr=r.list||[];
          list.style.display='block';
          list.innerHTML=arr.length?arr.map((c,i)=>`<div class="floating-item customer-pick" data-i="${i}"><b>${safe(c.fullName||c.customerName||'بدون نام')}</b><br><span>${safe(c.mobile||'')} ${c.nationalCode?' | '+safe(c.nationalCode):''}</span><br><small>تعداد خرید: ${safe(c.purchaseCount||0)} | آخرین خرید: ${safe(c.lastPurchaseDate||'')}</small></div>`).join(''):'<div class="floating-empty">مشتری پیدا نشد</div>';
          list.querySelectorAll('.customer-pick').forEach(el=>el.onclick=()=>{const c=arr[Number(el.dataset.i)]; fillSaleCustomer(c); input.value=labelCustomer(c); list.style.display='none';});
        }catch(e){
          list.style.display='block';
          list.innerHTML=`<div class="floating-empty">خطا در جستجوی مشتری: ${safe(e.message||e)}</div>`;
        }
      },250);
    });
    ['buyerName','buyerMobile','buyerNational'].forEach(id=>{
      const el=$('#'+id);
      if(!el || el.dataset.customerBankBlurBound==='1') return;
      el.dataset.customerBankBlurBound='1';
      el.addEventListener('blur',async()=>{
        const q=el.value.trim();
        if(q.length<3) return;
        try{
          const r=await api(`/api/customers/search?q=${encodeURIComponent(q)}&limit=1`);
          const c=(r.list||[])[0];
          if(c){
            const hint=$('#saleCustomerHint');
            if(hint) hint.innerHTML=`<div class="info">مشتری مشابه پیدا شد: <button class="btn small" id="fillSimilarCustomer">تکمیل اطلاعات</button> ${safe(labelCustomer(c))}</div>`;
            const btn=$('#fillSimilarCustomer');
            if(btn) btn.onclick=()=>fillSaleCustomer(c);
          }
        }catch{}
      });
    });
  }
  const activePageSale = window.pageSale || pageSale;
  if(typeof activePageSale==='function'){
    window.pageSale = pageSale = async function(){
      await activePageSale();
      setTimeout(installSaleCustomerSearch,120);
    };
  }
})();


/* PATCH 0.9.15.6: Supplier ledger cleaner + check pressure fix */
(function(){
  function safe2(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function money(n){return Number(n||0).toLocaleString('fa-IR')}
  function riskFa(r){return ({high:'بالا',medium:'متوسط',low:'پایین'}[String(r||'')]||r||'')}
  function riskClass(r){return r==='high'?'error':r==='medium'?'warn':'success'}
  function payFa(x){return ({cash:'نقدی',check:'چکی',mixed:'ترکیبی',manual:'دستی/نامشخص'}[String(x||'mixed')]||x||'ترکیبی')}
  function basisFa(x){return ({inventory_date:'از تاریخ ورود/فاکتور خرید',purchase_commitment:'از تاریخ تعهد خرید'}[String(x||'inventory_date')]||x||'')}
  async function loadSelectedSuppliers(){const r=await api('/api/supplier-aging/selected');return r.list||[];}
  async function populateSupplierLayerFilter(){const sel=$('#supLayerSupplier');if(!sel)return;const list=await loadSelectedSuppliers();const active=list.filter(x=>x.isActive!==false);const cur=sel.value||'';sel.innerHTML='<option value="">همه منشاهای محاسبه‌شده</option>'+active.map(x=>`<option value="${x.accountId}">${safe2(x.accountName||x.accountId)}</option>`).join('');if(cur&&active.some(x=>String(x.accountId)===String(cur)))sel.value=cur;}
  function supplierLayerQuery(){const v=$('#supLayerSupplier')?.value||'';return v?`?supplierAccountId=${encodeURIComponent(v)}`:'';}
  function supplierRow(x){return `<tr><td>${safe2(x.accountId)}</td><td>${safe2(x.accountName||'')}</td><td>${safe2(x.group||'')}</td><td>${payFa(x.paymentMethod)}</td><td>${safe2(x.manualSettlementDays??'محاسباتی')}</td><td>${safe2(x.checkDueDays??'-')}</td><td>${safe2(x.goodsDelayDays??0)}</td><td>${x.isActive!==false?'فعال':'غیرفعال'}</td><td><button class="mini" data-edit-sup="${safe2(x.accountId)}">ویرایش</button> <button class="mini" data-toggle-sup="${safe2(x.accountId)}">${x.isActive!==false?'غیرفعال':'فعال'}</button> <button class="mini" data-del-sup="${safe2(x.accountId)}">حذف</button></td></tr>`}
  async function editSupplierTerms(cur){
    const group=prompt('گروه تأمین‌کننده؟', cur.group || ''); if(group===null)return;
    const method=prompt('نوع تسویه: cash / check / mixed / manual', cur.paymentMethod || 'mixed'); if(method===null)return;
    const basisDefault = cur.settlementBasis || (method==='check'?'purchase_commitment':'inventory_date');
    const basis=prompt('مبنای راس: inventory_date یا purchase_commitment', basisDefault); if(basis===null)return;
    const manual=prompt('راس تسویه دستی. خالی = محاسباتی', cur.manualSettlementDays ?? ''); if(manual===null)return;
    const checkDue=prompt('راس چک از روز تعهد خرید. برای ماتریس نمونه: 10. خالی = ندارد', cur.checkDueDays ?? ''); if(checkDue===null)return;
    const delay=prompt('میانگین تأخیر ورود کالا به انبار بعد از خرید. برای ماتریس نمونه: 2', cur.goodsDelayDays ?? 0); if(delay===null)return;
    await post('/api/supplier-aging/selected',{...cur,group:group||'',paymentMethod:method||'mixed',settlementBasis:basis||basisDefault,manualSettlementDays:manual===''?null:Number(manual),checkDueDays:checkDue===''?null:Number(checkDue),goodsDelayDays:delay===''?0:Number(delay),isActive:true});
    await renderSelectedSuppliers();
  }
  async function renderSelectedSuppliers(){const list=await loadSelectedSuppliers();const box=$('#supSelected');if(!box)return;box.innerHTML=list.length?`<table class="table"><thead><tr><th>ID</th><th>تأمین‌کننده</th><th>گروه</th><th>نوع تسویه</th><th>راس دستی</th><th>راس چک</th><th>تأخیر ورود</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${list.map(supplierRow).join('')}</tbody></table><div class="small muted">برای حساب چکی مثل ماتریس: اگر چک ۱۰ روزه و ورود کالا ۲ روز بعد است، فشار مالی از ۸ روز بعد از ورود کالا محاسبه می‌شود.</div>`:'<div class="muted">هنوز تأمین‌کننده‌ای انتخاب نشده است.</div>';box.querySelectorAll('[data-edit-sup]').forEach(btn=>btn.onclick=async()=>{const id=Number(btn.dataset.editSup);const cur=list.find(x=>Number(x.accountId)===id);if(cur)await editSupplierTerms(cur);});box.querySelectorAll('[data-toggle-sup]').forEach(btn=>btn.onclick=async()=>{const id=Number(btn.dataset.toggleSup);const cur=list.find(x=>Number(x.accountId)===id);await post('/api/supplier-aging/selected',{...cur,isActive:cur.isActive===false});await renderSelectedSuppliers();});box.querySelectorAll('[data-del-sup]').forEach(btn=>btn.onclick=async()=>{if(!confirm('حذف شود؟'))return;await api(`/api/supplier-aging/selected?accountId=${encodeURIComponent(btn.dataset.delSup)}`,{method:'DELETE'});await renderSelectedSuppliers();});}
  async function searchSupplierCandidates(){const q=$('#supSearchQ')?.value||'';const box=$('#supCandidates');if(!box)return;box.innerHTML='<div class="info">در حال جستجوی تأمین‌کننده‌های دارای خرید...</div>';const r=await api(`/api/supplier-aging/candidates?q=${encodeURIComponent(q)}&limit=80`);const arr=r.list||[];box.innerHTML=arr.length?`<table class="table"><thead><tr><th>نام</th><th>کد</th><th>تعداد فاکتور</th><th>خرید دوره</th><th>وضعیت</th><th>افزودن</th></tr></thead><tbody>${arr.map((x,i)=>`<tr><td>${safe2(x.accountName)}</td><td>${safe2(x.accountNumber||x.accountId)}</td><td>${money(x.purchaseInvoiceCount)}</td><td>${money(x.purchaseRial)}</td><td>${x.selected?'انتخاب‌شده':'-'}</td><td><button class="mini" data-add-cand="${i}">افزودن/ویرایش</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">نتیجه‌ای نبود.</div>';box.querySelectorAll('[data-add-cand]').forEach(btn=>btn.onclick=async()=>{const x=arr[Number(btn.dataset.addCand)];const cur=x.selectedDoc||{accountId:x.accountId,accountNumber:x.accountNumber,accountName:x.accountName,group:'',paymentMethod:'mixed',manualSettlementDays:null,goodsDelayDays:0,checkDueDays:null,settlementBasis:'inventory_date',isActive:true};await editSupplierTerms(cur);await searchSupplierCandidates();});}
  async function loadSupplierAgingReport(){const box=$('#supReport');if(!box)return;box.innerHTML='<div class="info">در حال محاسبه گزارش اولیه روی تأمین‌کننده‌های منتخب...</div>';try{const r=await api('/api/supplier-aging/report'+supplierLayerQuery());const suppliers=r.suppliers||[];const origin=r.originSummary||{};const origins=origin.origins||[];let h='<h4>منشا کل موجودی انبارهای فعال</h4>';h+=`<div class="info">کل موجودی انبارهای فعال: ${money(origin.totalInventoryValue||0)} ریال | تعداد کالا: ${money(origin.totalItemCount||0)} | تعداد کل: ${money(origin.totalInventoryQty||0)} | انبارهای فعال: ${(origin.activeWarehouseNumbers||[]).join('، ')||'همه'}</div>`;h+=origins.length?`<table class="table"><thead><tr><th>منشا مانده کالا</th><th>ارزش مانده</th><th>درصد از کل</th><th>تعداد کالا</th><th>تعداد لایه</th><th>میانگین سن</th><th>جزئیات</th></tr></thead><tbody>${origins.map(x=>`<tr><td>${safe2(x.accountName||x.supplierName)}</td><td>${money(x.inventoryValue)}</td><td>${x.sharePct==null?'':safe2(x.sharePct+'٪')}</td><td>${money(x.itemCount)}</td><td>${money(x.layerCount)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td><button class="mini" data-origin-sup="${safe2(x.accountId||0)}">نمایش کالاها</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">منشا موجودی محاسبه نشد.</div>';h+='<h4 class="mt">خلاصه تأمین‌کننده‌محور منتخب</h4>';h+=suppliers.length?`<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره</th><th>پرداخت واقعی</th><th>چک معتبر</th><th>تعدیلات</th><th>چک خنثی/باطل</th><th>افتتاحیه</th><th>مانده حساب</th><th>موجودی مانده</th><th>میانگین سن فیزیکی</th><th>نوع</th><th>راس خام</th><th>تأخیر ورود</th><th>مهلت بعد از ورود</th><th>فشار مالی</th><th>سود FIFO</th><th>اعتماد</th><th>ریسک</th></tr></thead><tbody>${suppliers.map(x=>`<tr><td>${safe2(x.accountName)}</td><td>${money(x.totalPurchaseRial)}</td><td>${money(x.totalPaidRial)}</td><td>${money(x.validCheckPaidRial)}</td><td>${money((x.adjustmentDebit||0)+(x.adjustmentCredit||0))}</td><td>${money((x.canceledCheckDebit||0)+(x.canceledCheckCredit||0))}</td><td>${money((x.openingDebit||0)+(x.openingCredit||0))}</td><td>${money(x.payableBalance)}</td><td>${money(x.inventoryValue)}</td><td>${money(x.averageInventoryAgeDays)}</td><td>${payFa(x.paymentMethod)}</td><td>${x.rawPaymentTermDays==null?'نامشخص':money(x.rawPaymentTermDays)}</td><td>${money(x.goodsDelayDays||0)}</td><td>${x.financialGraceDays==null?'نامشخص':money(x.financialGraceDays)}</td><td>${x.overdueDays==null?'نامشخص':money(x.overdueDays)}</td><td>${money(x.estimatedProfit)} ${x.estimatedProfitPct!=null?'('+x.estimatedProfitPct+'٪)':''}</td><td>${safe2(x.ledgerConfidence||'')}</td><td><div class="${riskClass(x.risk)}">${riskFa(x.risk)}</div></td></tr>`).join('')}</tbody></table>`:'<div class="muted">تأمین‌کننده فعالی وجود ندارد.</div>';const layers=r.itemLayers||[];const ls=r.layerSummary||{};h+='<h4 class="mt">لایه‌های کالایی، تفکیک خواب فیزیکی و فشار مالی</h4>';h+=`<div class="info">فیلتر فعلی: ${$('#supLayerSupplier')?.selectedOptions?.[0]?.textContent||'همه'} | تعداد لایه: ${money(ls.layerCount||layers.length)} | ارزش مانده: ${money(ls.totalRemainingValue||0)} | میانگین خواب فیزیکی: ${money(ls.averagePhysicalAgeDays||0)} | میانگین فشار مالی: ${ls.averageFinancialPressureDays==null?'نامشخص':money(ls.averageFinancialPressureDays)}</div>`;h+=layers.length?`<table class="table"><thead><tr><th>تأمین‌کننده</th><th>کالا</th><th>تعداد مانده</th><th>ارزش مانده</th><th>فاکتور خرید</th><th>تاریخ ورود/خرید</th><th>سن فیزیکی</th><th>سررسید مالی تقریبی</th><th>فشار مالی</th><th>ریسک</th><th>اطمینان</th></tr></thead><tbody>${layers.slice(0,150).map(x=>`<tr><td>${safe2(x.supplierName)}</td><td>${safe2(x.itemCode)}<br>${safe2(x.itemDescription)}</td><td>${money(x.remainingQty)}</td><td>${money(x.remainingValue)}</td><td>${safe2(x.purchaseInvoiceNo)}</td><td>${safe2(toJalaliDisplay(x.purchaseDate))}</td><td>${money(x.ageDays)}</td><td>${x.financialDueDate?safe2(toJalaliDisplay(x.financialDueDate)):'نامشخص'}</td><td>${x.overdueDays==null?'نامشخص':money(x.overdueDays)}</td><td><div class="${riskClass(x.risk)}">${riskFa(x.risk)}</div></td><td>${safe2(x.confidence)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">لایه کالایی پیدا نشد.</div>';h+=`<div class="small muted">منبع: ${(r.meta&&r.meta.source)||''} | این گزارش از کل موجودی انبارهای فعال شروع می‌کند و مانده نامشخص را جدا نشان می‌دهد.</div>`;box.innerHTML=h;box.querySelectorAll('[data-origin-sup]').forEach(btn=>btn.onclick=async()=>{const id=String(btn.dataset.originSup||'');const sel=$('#supLayerSupplier');if(sel){let opt=[...sel.options].find(o=>String(o.value)===id);if(!opt&&id!=='0'){opt=new Option('تأمین‌کننده '+id,id);sel.add(opt);}sel.value=id==='0'?'':id;} if(id==='0'){box.insertAdjacentHTML('afterbegin','<div class="warning">منشا نامشخص/مانده از قبل حساب تأمین‌کننده ندارد؛ لایه‌های نامشخص در گزارش کلی نمایش داده می‌شود.</div>');return;} await loadSupplierAgingReport();});}catch(e){box.innerHTML=`<div class="error">${safe2(e.message||e)}</div>`}}
  window.pageSupplierAging = async function(){setPage('خواب کالا - تأمین‌کننده',`<main class="main-content"><div class="card"><div class="card-header"><h5>تنظیم تأمین‌کننده‌های تحلیل خواب کالا</h5></div><div class="card-body"><div class="info">در این نسخه سود تأمین‌کننده با FIFO خرید به فروش محاسبه می‌شود؛ افتتاحیه، چک خنثی/باطل و تعدیلات از پرداخت واقعی جدا می‌شود.</div><div class="actions"><button class="btn green" id="supSeed">به‌روزرسانی/افزودن ۳ تأمین‌کننده پیش‌فرض</button></div><div id="supSelected" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>جستجو و افزودن تأمین‌کننده</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>نام یا کد تأمین‌کننده</label><input id="supSearchQ" placeholder="مثلاً ماندگار، ماتریس، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="supSearchBtn">جستجوی حساب‌های دارای خرید</button></div></div><div id="supCandidates" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>گزارش خواب و فشار مالی تأمین‌کننده</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>فیلتر لایه‌های کالایی بر اساس تأمین‌کننده</label><select id="supLayerSupplier"><option value="">همه منشاهای محاسبه‌شده</option></select><div class="small muted">برای انبارگردانی/تصمیم خرید، تأمین‌کننده را انتخاب کن تا فقط موجودی منتسب به همان حساب نمایش داده شود.</div></div><div class="form-group"><label>&nbsp;</label><button class="btn red" id="supReportBtn">محاسبه گزارش</button></div></div><div id="supReport" class="mt"></div></div></div></main>`);$('#supSeed').onclick=async()=>{await post('/api/supplier-aging/seed',{});await renderSelectedSuppliers();await populateSupplierLayerFilter();};$('#supSearchBtn').onclick=searchSupplierCandidates;$('#supSearchQ').addEventListener('keydown',e=>{if(e.key==='Enter')searchSupplierCandidates();});$('#supReportBtn').onclick=loadSupplierAgingReport;await renderSelectedSuppliers();await populateSupplierLayerFilter();};
  const prevRoute = window.route || route;
  window.route = route = async function(){const p=location.hash.slice(1)||firstAllowedPage();if(p==='supplier-aging')return pageSupplierAging();return prevRoute();};
})();

/* PATCH 0.9.15.2: Real user edit form + issued-user edit lock */
(function(){
  function roleTitle(r){return ({admin:'مدیر سیستم',seller:'فروشنده',accounting:'حسابداری',warehouse:'انبار',purchase:'بازرگانی',seller_buyer:'فروشنده-خریدار'}[r]||r||'')}
  function userFull(u){return (u.fullName||((u.firstName||'')+' '+(u.lastName||'')).trim()||u.username||'')}
  function setUserFormLocked(locked){
    ['uFirst','uLast','uUsername','uRole','uMobile','uCanPurchase'].forEach(id=>{const el=$('#'+id); if(el) el.disabled=!!locked;}); ['uPass','uPass2'].forEach(id=>{const el=$('#'+id); if(el) el.disabled=false;});
    const hint=$('#userLockHint');
    if(hint) hint.innerHTML=locked?'<div class="warn">این کاربر قبلاً با اکانت خود در CRM فاکتور صادر کرده است؛ اطلاعات هویتی/نام کاربری/گروه قابل ویرایش نیست. ادمین همیشه می‌تواند رمز عبور و وضعیت فعال/غیرفعال را تغییر دهد.</div>':'<div class="info">برای ویرایش، روی دکمه «ویرایش» کنار کاربر کلیک کن. اطلاعات در فرم بالا لود می‌شود و با «ذخیره کاربر» در دیتابیس ثبت می‌شود.</div>';
  }
  function clearUserForm(){
    $('#uOriginalUsername').value=''; $('#uFirst').value=''; $('#uLast').value=''; $('#uUsername').value=''; $('#uPass').value=''; $('#uPass2').value=''; $('#uMobile').value=''; $('#uRole').value='seller'; $('#uCanPurchase').checked=false; $('#uIsActive').value='1'; state.userAccessDraft=[]; setUserFormLocked(false); _showUserAccessSection(); _renderUserAccessDraft(); $('#userMsg').innerHTML='';
  }
  async function loadUserIntoForm(u){
    $('#uOriginalUsername').value=u.username||'';
    $('#uFirst').value=u.firstName||'';
    $('#uLast').value=u.lastName||'';
    $('#uUsername').value=u.username||'';
    $('#uRole').value=u.role||'seller';
    $('#uMobile').value=u.mobile||'';
    $('#uCanPurchase').checked=u.canPurchase===true;
    if($('#uCanViewPurchaseInvoices')) $('#uCanViewPurchaseInvoices').checked=u.canViewPurchaseInvoices===true;
    if($('#uCanPostPurchaseToBoard')) $('#uCanPostPurchaseToBoard').checked=u.canPostPurchaseToBoard===true;
    if($('#uCanManageBoardEvents')) $('#uCanManageBoardEvents').checked=u.canManageBoardEvents===true;
    $('#uIsActive').value=(u.isActive===false?'0':'1');
    $('#uPass').value=''; $('#uPass2').value='';
    setUserFormLocked(u.editLocked===true);
    _showUserAccessSection();
    await _loadUserAccess(u.username);
    const msg = u.editLocked ? `کاربر انتخاب شد اما قفل ویرایش هویتی است. تعداد سوابق فاکتور/تبدیل/رزرو مصرف‌شده: ${Number(u.issuedCount||0).toLocaleString('fa-IR')}. رمز عبور و وضعیت فعال/غیرفعال همچنان قابل تغییر است.` : 'کاربر انتخاب شد و آماده ویرایش است. بعد از اصلاح، ذخیره کاربر را بزن.';
    $('#userMsg').innerHTML=`<div class="${u.editLocked?'warn':'info'}">${esc(msg)}</div>`;
    window.scrollTo({top:0,behavior:'smooth'});
  }
  window.pageUsers = pageUsers = async function(){
    state.userAccessDraft=[];
    setPage('کاربران',`<main class="main-content"><div class="card"><div class="card-header"><h5>افزودن / ویرایش کاربر</h5></div><div class="card-body"><input type="hidden" id="uOriginalUsername"><div id="userLockHint"></div><div class="row three"><div class="form-group"><label>نام</label><input id="uFirst"></div><div class="form-group"><label>نام خانوادگی</label><input id="uLast"></div><div class="form-group"><label>نام کاربری</label><input id="uUsername"></div><div class="form-group"><label>رمز ورود</label><input id="uPass" type="password" placeholder="فقط برای تغییر رمز پر شود"></div><div class="form-group"><label>تکرار رمز ورود</label><input id="uPass2" type="password"></div><div class="form-group"><label>گروه کاربری</label><select id="uRole"><option value="admin">مدیر سیستم</option><option value="seller">فروشنده</option><option value="accounting">حسابداری</option><option value="warehouse">انبار</option><option value="purchase">بازرگانی</option><option value="seller_buyer">فروشنده-خریدار</option></select></div><div class="form-group"><label>شماره موبایل</label><input id="uMobile"></div><div class="form-group"><label>وضعیت کاربر</label><select id="uIsActive"><option value="1">فعال</option><option value="0">غیرفعال</option></select></div><div class="form-group"><label>دسترسی خرید برای فروشنده</label><label class="checkline"><input type="checkbox" id="uCanPurchase"> فعال‌سازی فاکتور/پیش‌نویس خرید</label><label class="checkline"><input type="checkbox" id="uCanViewPurchaseInvoices"> مرور فاکتورهای خرید شایگان</label><label class="checkline"><input type="checkbox" id="uCanPostPurchaseToBoard"> اعلام ورود کالا در تابلو</label><label class="checkline"><input type="checkbox" id="uCanManageBoardEvents"> مدیریت وضعیت‌های تابلو</label></div></div><div id="userAccessBox" class="mapping-box" style="display:none"><h4>حساب‌های مجاز گردش حساب برای این فروشنده</h4><p class="small muted">صندوق و جاری کارکنان از «تعریف صندوق/نماینده» خودکار مجاز هستند.</p><div class="row two"><div class="form-group account-picker"><label>جستجوی حساب شایگان برای دسترسی مجاز</label><input id="uAccessSearch" placeholder="نام یا کد حساب"><div id="uAccessResults" class="floating-list account-list"></div></div><div><label>حساب‌های انتخاب‌شده</label><div id="userAccessList" class="access-list"></div></div></div></div><button class="btn green" id="saveUserBtn">ذخیره کاربر</button><button class="btn gray" id="newUserBtn">کاربر جدید</button><button class="btn" id="repairUserLinksBtn">اصلاح اتصال کاربران</button><div id="userMsg"></div></div></div><div class="card"><div class="card-header"><h5>لیست کاربران</h5></div><div class="card-body"><div class="info">برای ویرایش، روی دکمه «ویرایش» کنار کاربر کلیک کن؛ ردیف‌های قفل‌شده سابقه فاکتور دارند؛ هویت/نام کاربری/گروه قفل است، اما رمز عبور و فعال/غیرفعال همیشه توسط ادمین قابل تغییر است.</div><div id="usersTable">در حال بارگذاری...</div></div></div></main>`);
    $('#uRole').onchange=_showUserAccessSection;
    bindAccountPicker('uAccessSearch','uAccessResults',(acc)=>{if(!(state.userAccessDraft||[]).find(x=>String(x.accountNumber)===String(acc.accountNumber))){state.userAccessDraft.push({accountNumber:acc.accountNumber,accountName:acc.accountName,accountGuid:acc.guId||acc.accountGuid||'',guId:acc.guId||acc.accountGuid||'',accountKey:acc.accountKey||''});_renderUserAccessDraft();}});
    $('#newUserBtn').onclick=clearUserForm;
    $('#saveUserBtn').onclick=saveUser;
    const repairBtn=$('#repairUserLinksBtn'); if(repairBtn) repairBtn.onclick=async()=>{ if(!confirm('اتصالات تکراری و خراب کاربران بررسی و اصلاح شود؟'))return; const r=await post('/api/users/repair-links',{}); $('#userMsg').innerHTML=r.ok?`<div class="success">اصلاح انجام شد. کاربران: ${r.users} | اتصال‌های تکراری حذف‌شده: ${r.fixedMappings} | دسترسی‌های تکراری حذف‌شده: ${r.fixedAccess} | اتصال جدید ساخته‌شده: ${r.created}</div>`:`<div class="error">${esc(r.error||'خطا')}</div>`; state.mappings=null; await renderUsersTable(); };
    setUserFormLocked(false); _showUserAccessSection(); _renderUserAccessDraft(); await renderUsersTable();
  };
  window.saveUser = saveUser = async function(){
    const firstName=$('#uFirst').value.trim(), lastName=$('#uLast').value.trim(), username=$('#uUsername').value.trim(), password=$('#uPass').value, password2=$('#uPass2').value, role=$('#uRole').value, mobile=$('#uMobile').value.trim(), originalUsername=$('#uOriginalUsername').value.trim(), canPurchase=$('#uCanPurchase')?.checked===true, canViewPurchaseInvoices=$('#uCanViewPurchaseInvoices')?.checked===true, canPostPurchaseToBoard=$('#uCanPostPurchaseToBoard')?.checked===true, canManageBoardEvents=$('#uCanManageBoardEvents')?.checked===true, isActive=$('#uIsActive')?.value!=='0';
    if(!firstName||!lastName||!username||!role)return $('#userMsg').innerHTML='<div class="error">نام، نام خانوادگی، نام کاربری و گروه کاربری الزامی است.</div>';
    if(password!==password2)return $('#userMsg').innerHTML='<div class="error">رمز ورود و تکرار آن برابر نیست.</div>';
    const r=await post('/api/users',{firstName,lastName,username,password,role,mobile,canPurchase,canViewPurchaseInvoices,canPostPurchaseToBoard,canManageBoardEvents,isActive,originalUsername,updatedBy:state.user?.username||'admin'});
    if(!r.ok)return $('#userMsg').innerHTML=`<div class="error">${esc(r.error||'خطا')}</div>`;
    const ar=await _saveUserAccessIfNeeded(username,role);
    state.mappings=null;
    $('#userMsg').innerHTML=`<div class="success">کاربر ذخیره شد${isActive?'':' و غیرفعال شد'}${canPurchase?' و دسترسی خرید فعال است':''}${ar.skipped?'':' و حساب‌های مجاز گردش حساب هم ثبت شد'}.</div>`;
    $('#uOriginalUsername').value=username; await renderUsersTable();
  };
  window.renderUsersTable = renderUsersTable = async function(){
    const r=await api('/api/users'); const roles={admin:'مدیر سیستم',seller:'فروشنده',accounting:'حسابداری',warehouse:'انبار',purchase:'بازرگانی',seller_buyer:'فروشنده-خریدار'}; const maps=(await api('/api/user-mappings')).list||[];
    let h='<table class="table"><thead><tr><th>عملیات</th><th>نام</th><th>نام کاربری</th><th>گروه کاربری</th><th>موبایل</th><th>وضعیت</th><th>قفل ویرایش</th><th>خرید</th><th>تابلو/فاکتور خرید</th><th>اتصال شایگان</th></tr></thead><tbody>';
    h+=(r.list||[]).map((u,i)=>{const m=maps.find(x=>x.username===u.username);const payload=encodeURIComponent(JSON.stringify(u));return `<tr class="user-row ${u.editLocked?'locked-row':''}" data-user="${payload}"><td><button class="mini edit-user" data-i="${i}">ویرایش</button></td><td>${esc(userFull(u))}</td><td>${esc(u.username)}</td><td>${esc(roles[u.role]||u.role||'')}</td><td>${esc(u.mobile||'')}</td><td>${u.isActive===false?'<span class="warntext">غیرفعال</span>':'<span class="oktext">فعال</span>'}</td><td>${u.editLocked?'<span class="warntext">فاکتور دارد</span><br><small>'+Number(u.issuedCount||0).toLocaleString('fa-IR')+'</small>':'<span class="oktext">آزاد</span>'}</td><td>${u.canPurchase?'<span class="oktext">فعال</span>':'-'}</td><td>${(u.canViewPurchaseInvoices||u.canPostPurchaseToBoard||u.canManageBoardEvents)?'<span class="oktext">فعال</span>':'-'}</td><td>${m&&m.cashboxAccountNumber&&m.employeeAccountNumber?'<span class="oktext">متصل</span>':'<span class="warntext">نیازمند اتصال</span>'}</td></tr>`}).join('');
    $('#usersTable').innerHTML=h+'</tbody></table>';
    $$('.user-row').forEach(tr=>tr.onclick=async(e)=>{const u=JSON.parse(decodeURIComponent(tr.dataset.user)); await loadUserIntoForm(u);});
    $$('.edit-user').forEach(btn=>btn.onclick=async(e)=>{e.stopPropagation(); const tr=btn.closest('.user-row'); const u=JSON.parse(decodeURIComponent(tr.dataset.user)); await loadUserIntoForm(u);});
  };
})();

// --- 0.9.15.4 Mapping edit/delete repair: override account-set page ---
(function(){
  async function _mappingDelete(username){
    return await api('/api/user-mappings?username='+encodeURIComponent(username), { method:'DELETE' });
  }
  async function _renderMappingTableNew(loadUserCb){
    const r = await api('/api/user-mappings');
    state.mappings = r.list || [];
    let userMap = {};
    try { ((await api('/api/users')).list || []).forEach(u => userMap[u.username] = u); } catch {}
    let h = '<table class="table"><thead><tr><th>عملیات</th><th>کاربر</th><th>نام</th><th>گروه</th><th>فروشگاه</th><th>صندوق</th><th>جاری کارکنان/نماینده</th><th>وضعیت</th></tr></thead><tbody>';
    h += state.mappings.map(m => `<tr><td><button class="mini edit-map" data-u="${esc(m.username)}" type="button">ویرایش</button> <button class="mini del-map" data-u="${esc(m.username)}" type="button">حذف اتصال</button></td><td>${esc(m.username)}</td><td>${esc(m.fullName || userMap[m.username]?.fullName || '')}</td><td>${esc(m.role || userMap[m.username]?.role || '')}</td><td>${esc(m.storeName || '')}</td><td>${esc(m.cashboxAccountNumber || '')}<br><small>${esc(m.cashboxAccountName || '')}</small></td><td>${esc(m.employeeAccountNumber || '')}<br><small>${esc(m.employeeAccountName || '')}</small></td><td>${m.isActive===false?'<span class="warntext">غیرفعال</span>':'<span class="oktext">فعال</span>'}</td></tr>`).join('');
    $('#mappingList').innerHTML = h + '</tbody></table>';
    $$('.edit-map').forEach(btn => btn.onclick = async () => {
      const u = btn.dataset.u;
      const sel = $('#mapUser');
      if (sel) { sel.value = u; await loadUserCb(u); window.scrollTo({top:0, behavior:'smooth'}); $('#mappingMsg').innerHTML = '<div class="info">اتصال برای ویرایش در فرم بالا بارگذاری شد.</div>'; }
    });
    $$('.del-map').forEach(btn => btn.onclick = async () => {
      const u = btn.dataset.u;
      if (!confirm(`اتصال صندوق/جاری کارکنان کاربر ${u} حذف شود؟ خود کاربر حذف نمی‌شود.`)) return;
      try {
        const r = await _mappingDelete(u);
        $('#mappingMsg').innerHTML = r.ok ? '<div class="success">اتصال حذف شد</div>' : `<div class="error">${esc(r.error || 'خطا')}</div>`;
        await _renderMappingTableNew(loadUserCb);
        if ($('#mapUser')?.value === u) await loadUserCb(u);
      } catch(e) { $('#mappingMsg').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
    });
  }
  window.pageAccountSet = pageAccountSet = async function(){
    setPage('تعریف صندوق/نماینده', `<main class="main-content"><div class="card"><div class="card-header"><h5>اتصال کاربران CRM به حساب‌های شایگان</h5></div><div class="card-body"><p class="small muted">اگر صندوق یا جاری کارکنان اشتباه وصل شده، از همین صفحه می‌توانی اتصال را ویرایش، خالی، غیرفعال یا کامل حذف کنی. حذف اتصال، خود کاربر را حذف نمی‌کند.</p><div class="row three"><div class="form-group"><label>کاربر CRM</label><select id="mapUser"></select></div><div class="form-group"><label>نام نمایشی / فروشگاه</label><input id="mapFullName" placeholder="نام فروشنده"><input id="mapStore" class="mt6" placeholder="فروشگاه"></div><div class="form-group"><label>وضعیت اتصال</label><select id="mapActive"><option value="1">فعال</option><option value="0">غیرفعال</option></select></div></div><div class="row two"><div class="form-group account-picker"><label>صندوق فروشنده در شایگان</label><input id="cashSearch" placeholder="نام یا کد صندوق"><div id="cashResults" class="floating-list account-list"></div><input id="cashSelected" readonly class="readonly" placeholder="صندوق انتخاب‌شده"><button class="btn gray mt6" id="clearCashBtn" type="button">پاک کردن صندوق</button></div><div class="form-group account-picker"><label>جاری کارکنان / نماینده فروش در شایگان</label><input id="repSearch" placeholder="نام یا کد جاری کارکنان"><div id="repResults" class="floating-list account-list"></div><input id="repSelected" readonly class="readonly" placeholder="جاری کارکنان انتخاب‌شده"><button class="btn gray mt6" id="clearRepBtn" type="button">پاک کردن جاری کارکنان</button></div></div><div class="actions"><button class="btn green" id="saveMappingBtn">ذخیره / اصلاح اتصال</button><button class="btn red" id="deleteMappingBtn">حذف کامل اتصال این کاربر</button></div><div id="mappingMsg"></div><hr><h5>دسترسی گردش حساب خاص</h5><p class="small muted">صندوق و جاری کارکنان از اتصال بالا خودکار مجاز هستند؛ حساب‌های اضافی را اینجا اضافه یا حذف کن.</p><div class="row two"><div class="form-group account-picker"><label>جستجوی حساب برای افزودن دسترسی</label><input id="accessAccountSearch" placeholder="نام یا کد حساب"><div id="accessAccountResults" class="floating-list account-list"></div></div><div class="form-group"><label>حساب‌های مجاز این کاربر</label><div id="accessAccountsBox" class="access-list"></div></div></div><button class="btn" id="saveAccessBtn">ذخیره دسترسی گردش حساب</button><hr><div id="mappingList">در حال بارگذاری...</div></div></div></main>`);
    const users = (await api('/api/users')).list || [];
    let maps = (await api('/api/user-mappings')).list || [];
    state.mappings = maps;
    const sel = $('#mapUser');
    sel.innerHTML = users.map(u => `<option value="${esc(u.username)}">${esc(u.fullName || u.username)} | ${esc(u.username)} | ${esc(u.role || '')}</option>`).join('');
    state.mapDraft = {};
    state.accessDraft = [];
    async function refreshMaps(){ maps = (await api('/api/user-mappings')).list || []; state.mappings = maps; }
    function currentMap(username){ return maps.find(m => m.username === username) || {}; }
    function renderAccessDraft(){
      const box = $('#accessAccountsBox');
      box.innerHTML = state.accessDraft.length ? state.accessDraft.map((a,i)=>`<div class="access-pill"><b>${esc(a.accountNumber)}</b> ${esc(a.accountName||'')} <button class="mini del-access" data-i="${i}" type="button">حذف</button></div>`).join('') : '<div class="small muted">حسابی انتخاب نشده است.</div>';
      $$('.del-access').forEach(b => b.onclick = () => { state.accessDraft.splice(Number(b.dataset.i),1); renderAccessDraft(); });
    }
    async function loadUser(username){
      await refreshMaps();
      const u = users.find(x => x.username === username) || {};
      const m = currentMap(username);
      $('#mapFullName').value = m.fullName || u.fullName || '';
      $('#mapStore').value = m.storeName || '';
      $('#mapActive').value = m.isActive === false ? '0' : '1';
      $('#cashSelected').value = m.cashboxAccountNumber ? `${m.cashboxAccountNumber} - ${m.cashboxAccountName || ''}` : '';
      $('#repSelected').value = m.employeeAccountNumber ? `${m.employeeAccountNumber} - ${m.employeeAccountName || ''}` : '';
      state.mapDraft = { username, cashboxAccountNumber:m.cashboxAccountNumber||'', cashboxAccountName:m.cashboxAccountName||'', employeeAccountNumber:m.employeeAccountNumber||'', employeeAccountName:m.employeeAccountName||'' };
      const ar = await api('/api/user-account-access?username=' + encodeURIComponent(username));
      state.accessDraft = ar.list || [];
      renderAccessDraft();
    }
    sel.onchange = () => loadUser(sel.value);
    bindAccountPicker('cashSearch','cashResults',(acc)=>{ state.mapDraft.cashboxAccountNumber = acc.accountNumber; state.mapDraft.cashboxAccountName = acc.accountName; $('#cashSelected').value = `${acc.accountNumber} - ${acc.accountName}`; });
    bindAccountPicker('repSearch','repResults',(acc)=>{ state.mapDraft.employeeAccountNumber = acc.accountNumber; state.mapDraft.employeeAccountName = acc.accountName; $('#repSelected').value = `${acc.accountNumber} - ${acc.accountName}`; });
    bindAccountPicker('accessAccountSearch','accessAccountResults',(acc)=>{ if(!state.accessDraft.find(x => String(x.accountNumber) === String(acc.accountNumber))) state.accessDraft.push({ accountNumber:acc.accountNumber, accountName:acc.accountName, accountGuid:acc.guId||acc.accountGuid||'', guId:acc.guId||acc.accountGuid||'' }); renderAccessDraft(); });
    $('#clearCashBtn').onclick = () => { state.mapDraft.cashboxAccountNumber=''; state.mapDraft.cashboxAccountName=''; $('#cashSelected').value=''; $('#cashSearch').value=''; };
    $('#clearRepBtn').onclick = () => { state.mapDraft.employeeAccountNumber=''; state.mapDraft.employeeAccountName=''; $('#repSelected').value=''; $('#repSearch').value=''; };
    $('#saveMappingBtn').onclick = async () => {
      const body = { username:sel.value, fullName:$('#mapFullName').value, storeName:$('#mapStore').value, role:(users.find(u=>u.username===sel.value)||{}).role||'seller', cashboxAccountNumber:state.mapDraft.cashboxAccountNumber||'', cashboxAccountName:state.mapDraft.cashboxAccountName||'', employeeAccountNumber:state.mapDraft.employeeAccountNumber||'', employeeAccountName:state.mapDraft.employeeAccountName||'', isActive:$('#mapActive').value==='1', updatedBy:state.user?.username||'admin' };
      if (!body.cashboxAccountNumber || !body.employeeAccountNumber) { if(!confirm('صندوق یا جاری کارکنان کامل نیست. همین حالت ناقص ذخیره شود؟')) return; }
      const r = await post('/api/user-mappings', body);
      $('#mappingMsg').innerHTML = r.ok ? '<div class="success">اتصال ذخیره/اصلاح شد.</div>' : `<div class="error">${esc(r.error||'خطا')}</div>`;
      state.mappings = null;
      await _renderMappingTableNew(loadUser);
      await loadUser(sel.value);
    };
    $('#deleteMappingBtn').onclick = async () => {
      const username = sel.value;
      if (!confirm(`اتصال صندوق/جاری کارکنان کاربر ${username} کامل حذف شود؟ خود کاربر حذف نمی‌شود.`)) return;
      const r = await _mappingDelete(username);
      $('#mappingMsg').innerHTML = r.ok ? '<div class="success">اتصال این کاربر حذف شد.</div>' : `<div class="error">${esc(r.error||'خطا')}</div>`;
      state.mappings = null;
      await _renderMappingTableNew(loadUser);
      await loadUser(username);
    };
    $('#saveAccessBtn').onclick = async () => {
      const r = await post('/api/user-account-access', { username:sel.value, accounts:state.accessDraft, updatedBy:state.user?.username||'admin' });
      $('#mappingMsg').innerHTML = r.ok ? '<div class="success">دسترسی گردش حساب ذخیره شد.</div>' : `<div class="error">${esc(r.error||'خطا')}</div>`;
    };
    await loadUser(sel.value);
    await _renderMappingTableNew(loadUser);
  };
})();


/* 0.9.16.0 Manual Lead ID pilot
   - No live DB/API connection to Lead ID.
   - Closer manually enters Lead ID in sale invoice.
   - Empty Lead ID remains allowed during pilot, but is clearly flagged for commission deduction.
*/
(function(){
  const V='0.9.16.3-lead-control-reports-logo';
  window.MKCRM_VERSION=V;
  function $(s){return document.querySelector(s)}
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function normLead(v){return String(v||'').trim().replace(/[\u200c\u200f\u202a-\u202e]/g,'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').slice(0,80)}
  function decorateLeadField(){
    const inp=$('#leadId'); if(!inp || inp.dataset.manualLeadDecorated) return;
    inp.dataset.manualLeadDecorated='1';
    inp.placeholder='مثلاً LEAD ID ثبت‌شده در برنامه لید';
    const box=document.createElement('div');
    box.id='leadManualPilotBox';
    box.className='lead-manual-pilot info';
    box.innerHTML='دوره آزمایشی: ثبت فاکتور بدون Lead ID مجاز است، اما در گزارش کسر پورسانت علامت می‌خورد. فروشنده باید در برنامه Lead ID خودش را Closer ثبت کند و کد لید را اینجا وارد کند.';
    inp.closest('.form-group')?.appendChild(box);
    const msg=document.createElement('div'); msg.id='leadManualStatus'; msg.className='small muted'; inp.closest('.form-group')?.appendChild(msg);
    const update=()=>{ const v=normLead(inp.value); if(inp.value!==v) inp.value=v; msg.innerHTML=v?`Lead ID ثبت می‌شود: <b>${safe(v)}</b>`:'<span class="warn-inline">بدون Lead ID: مشمول بررسی/کسر پورسانت</span>'; };
    inp.addEventListener('input',update); inp.addEventListener('blur',update); update();
  }
  const oldPageSale=window.pageSale || pageSale;
  window.pageSale=pageSale=async function(){
    const r=await oldPageSale.apply(this,arguments);
    setTimeout(decorateLeadField,60);
    return r;
  };
  const oldIssueSale=window.issueSale || issueSale;
  window.issueSale=issueSale=async function(){
    const lead=$('#leadId');
    if(lead){
      lead.value=normLead(lead.value);
      if(!lead.value){
        const out=$('#saleOut');
        if(out) out.innerHTML='<div class="warn">این فاکتور بدون Lead ID ثبت می‌شود و در گزارش کسر پورسانت علامت خواهد خورد.</div>';
      }
    }
    return oldIssueSale.apply(this,arguments);
  };
  const style=document.createElement('style');
  style.textContent='.lead-manual-pilot{margin-top:6px;padding:8px;border:1px solid #fde68a;background:#fffbeb;border-radius:8px;color:#7c2d12}.warn-inline{color:#b91c1c;font-weight:700}';
  document.head.appendChild(style);
})();

/* 0.9.16.1: supplier aging layer filter by supplierAccountId + sale lead audit report UI/backend compatibility. */


/* 0.9.16.2: Lead Audit must be an in-CRM page, not a raw/test API link.
   Canonical UI: مدیریت > گزارش فاکتور/Lead
   Canonical API: /api/lead-audit/sales?days=31
   Compatibility aliases still supported by server for older calls.
*/
(function(){
  const V='0.9.16.3-lead-control-reports-logo';
  window.MKCRM_VERSION=V;
  function $q(s){return document.querySelector(s)}
  function $qa(s){return Array.from(document.querySelectorAll(s))}
  function html(v){try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}}
  function fmtNum(n){try{return Number(n||0).toLocaleString('fa-IR')}catch{return String(n||0)}}
  function fmtDate(v){try{ return v ? new Date(v).toLocaleString('fa-IR') : '' }catch{return html(v||'')}}
  async function loadLeadAudit(){
    const out=$q('#leadAuditOut'); if(!out) return;
    const days=Number($q('#leadAuditDays')?.value||31);
    const mode=$q('#leadAuditMode')?.value||'';
    const qs=new URLSearchParams(); qs.set('days', String(days));
    if(mode==='without') qs.set('withoutLead','1');
    out.innerHTML='<div class="info">در حال خواندن گزارش از CRM...</div>';
    try{
      const r=await api('/api/lead-audit/sales?'+qs.toString());
      const list=r.list||[]; const sm=r.summary||{};
      let h=`<div class="grid3"><div class="stat"><b>${fmtNum(sm.total||0)}</b><span>کل فاکتور</span></div><div class="stat danger"><b>${fmtNum(sm.withoutLead||0)}</b><span>بدون Lead ID</span></div><div class="stat ok"><b>${fmtNum(sm.withLead||0)}</b><span>دارای Lead ID</span></div></div>`;
      h+=`<div class="small muted">مسیر گزارش داخل CRM است. لینک خام API فقط برای تست سرور است: /api/lead-audit/sales?days=${days}</div>`;
      h+=list.length?`<table class="table"><thead><tr><th>تاریخ</th><th>شماره فاکتور</th><th>فروشنده/Closer</th><th>مشتری</th><th>Lead ID</th><th>وضعیت</th><th>مشمول کسر</th></tr></thead><tbody>${list.map(x=>`<tr><td>${html(fmtDate(x.issuedAt))}</td><td>${html(x.invoiceNumber||'')}</td><td>${html(x.fullName||x.mappingUsername||'')}</td><td>${html(x.customerName||'')}<br><span class="small muted">${html(x.mobile||'')}</span></td><td>${x.leadId?`<b>${html(x.leadId)}</b>`:'<span class="badge danger">خالی</span>'}</td><td>${x.invoiceWithoutLead?'<span class="badge danger">بدون لید</span>':'<span class="badge ok">ثبت شده</span>'}</td><td>${x.leadPenaltyEligible?'<span class="badge danger">بله</span>':'خیر'}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">موردی برای بازه انتخاب‌شده پیدا نشد.</div>';
      out.innerHTML=h;
    }catch(e){out.innerHTML=`<div class="error">گزارش فعال نشد یا مسیر API خطا داد: ${html(e.message||e)}</div>`;}
  }
  window.pageLeadAudit = async function(){
    setPage('گزارش فاکتور / Lead ID', `<main class="main-content"><div class="card"><div class="card-header"><h5>گزارش کنترل Lead ID در فاکتور فروش</h5></div><div class="card-body"><div class="info">این گزارش فقط از داده‌های MKCRM می‌خواند؛ به دیتابیس برنامه Lead ID وصل نمی‌شود. هدف دوره آزمایشی: فاکتور بدون Lead ID برای کسر پورسانت مشخص شود.</div><div class="row three"><div class="form-group"><label>بازه روز</label><input id="leadAuditDays" type="number" value="31" min="1" max="180"></div><div class="form-group"><label>فیلتر</label><select id="leadAuditMode"><option value="">همه</option><option value="without">فقط بدون Lead ID</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn red" id="leadAuditLoad">نمایش گزارش</button></div></div><div id="leadAuditOut" class="mt"></div></div></div></main>`);
    $q('#leadAuditLoad').onclick=loadLeadAudit;
    await loadLeadAudit();
  };
  const oldRenderMenu = window.renderMenu || renderMenu;
  window.renderMenu = renderMenu = function(){
    try{ oldRenderMenu.apply(this, arguments); }catch(e){}
    const m=$q('#menu'); if(!m) return;
    if($q('[data-page="lead-audit"]')) return;
    const reportsBtn=$q('[data-page="reports"]');
    const btn=document.createElement('button'); btn.className='navbtn'; btn.dataset.page='lead-audit'; btn.textContent='گزارش فاکتور/Lead';
    btn.onclick=(e)=>{e.preventDefault();location.hash='lead-audit';route();};
    if(reportsBtn) reportsBtn.parentNode.insertBefore(btn,reportsBtn); else m.appendChild(btn);
  };
  const oldRoute = window.route || route;
  window.route = route = async function(){
    let p=location.hash.slice(1)||firstAllowedPage();
    if(p==='lead-audit') return pageLeadAudit();
    return oldRoute.apply(this, arguments);
  };
  const st=document.createElement('style');
  st.textContent='.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:10px 0}.stat{border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff}.stat b{font-size:22px;display:block}.stat span{color:#64748b}.stat.danger{border-color:#fecaca;background:#fef2f2}.stat.ok{border-color:#bbf7d0;background:#f0fdf4}.badge{padding:2px 7px;border-radius:999px;font-size:12px}.badge.danger{background:#fee2e2;color:#991b1b}.badge.ok{background:#dcfce7;color:#166534}';
  document.head.appendChild(st);
  setTimeout(()=>{try{if($q('#menu'))renderMenu(); if(state.user)route();}catch(e){console.error('0.9.16.2 lead-audit activation',e)}},80);
})();


/* 0.9.16.3 Lead Control - CRM-only pilot, no direct Lead ID database/API dependency */
(function(){
  const V='0.9.16.3-lead-control-reports-logo';
  window.MKCRM_VERSION=V;
  function q(s){return document.querySelector(s)}
  function qa(s){return Array.from(document.querySelectorAll(s))}
  function h(v){try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}}
  function n(v){try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}}
  function d(v){try{return v?new Date(v).toLocaleString('fa-IR'):''}catch{return String(v||'')}}
  let lastLeadControlRows=[];
  function csvDownload(rows){
    const cols=[['issuedAt','تاریخ'],['invoiceNumber','شماره فاکتور'],['mappingUsername','کاربر'],['fullName','فروشنده'],['customerName','مشتری'],['mobile','موبایل'],['leadId','Lead ID'],['invoiceWithoutLead','بدون لید'],['leadPenaltyEligible','مشمول کسر'],['duplicateLead','لید تکراری'],['badLeadFormat','فرمت مشکوک']];
    const escCsv=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
    const lines=[cols.map(c=>escCsv(c[1])).join(',')].concat(rows.map(r=>cols.map(c=>escCsv(c[0]==='issuedAt'?d(r[c[0]]):r[c[0]])).join(',')));
    const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mkcrm-lead-control.csv';a.click();URL.revokeObjectURL(a.href);
  }
  async function loadLeadControl(){
    const out=q('#leadControlOut'); if(!out) return;
    const days=Number(q('#leadControlDays')?.value||31);
    const mode=q('#leadControlMode')?.value||'';
    const seller=(q('#leadControlSeller')?.value||'').trim();
    const qs=new URLSearchParams({days:String(days),limit:'1000'});
    if(mode) qs.set('mode',mode);
    if(seller) qs.set('seller',seller);
    out.innerHTML='<div class="info">در حال محاسبه کنترل Lead از داده‌های داخلی CRM...</div>';
    try{
      const r=await api('/api/lead-control/sales?'+qs.toString());
      const sm=r.summary||{}, rows=r.list||[], by=r.bySeller||[]; lastLeadControlRows=rows;
      let x=`<div class="lead-control-kpi"><div class="stat"><b>${n(sm.total)}</b><span>کل فاکتور فروش</span></div><div class="stat ok"><b>${n(sm.withLead)}</b><span>دارای Lead ID</span></div><div class="stat danger"><b>${n(sm.withoutLead)}</b><span>بدون Lead ID</span></div><div class="stat danger"><b>${n(sm.penaltyEligible)}</b><span>مشمول کسر</span></div><div class="stat warn"><b>${n(sm.duplicateLead)}</b><span>Lead تکراری روی فاکتور</span></div><div class="stat warn"><b>${n(sm.badLeadFormat)}</b><span>فرمت مشکوک</span></div></div>`;
      x+=`<div class="info">این صفحه فقط از دیتای MKCRM می‌خواند. اتصال مستقیم به برنامه Lead ID ندارد. هدف: کنترل دوره آزمایشی و آماده‌سازی گزارش کسر پورسانت.</div>`;
      if(by.length){x+=`<h4>خلاصه فروشنده/Closer</h4><table class="table"><thead><tr><th>فروشنده</th><th>کل</th><th>دارای Lead</th><th>بدون Lead</th><th>مشمول کسر</th><th>Lead تکراری</th><th>فرمت مشکوک</th></tr></thead><tbody>${by.map(s=>`<tr><td>${h(s.fullName||s.seller)}</td><td>${n(s.total)}</td><td>${n(s.withLead)}</td><td>${n(s.withoutLead)}</td><td>${n(s.penaltyEligible)}</td><td>${n(s.duplicateLead)}</td><td>${n(s.badLeadFormat)}</td></tr>`).join('')}</tbody></table>`;}
      x+=rows.length?`<h4>جزئیات فاکتورها</h4><table class="table"><thead><tr><th>تاریخ</th><th>شماره</th><th>Closer</th><th>مشتری</th><th>Lead ID</th><th>وضعیت</th><th>کنترل</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${h(d(r.issuedAt))}</td><td>${h(r.invoiceNumber)}</td><td>${h(r.fullName||r.mappingUsername)}</td><td>${h(r.customerName||'')}<br><span class="small muted">${h(r.mobile||'')}</span></td><td>${r.leadId?`<b>${h(r.leadId)}</b>`:'<span class="badge danger">خالی</span>'}</td><td>${r.invoiceWithoutLead?'<span class="badge danger">بدون لید</span>':'<span class="badge ok">دارای لید</span>'}</td><td>${r.duplicateLead?'<span class="badge warn">Lead تکراری</span> ':''}${r.badLeadFormat?'<span class="badge warn">فرمت مشکوک</span> ':''}${r.leadPenaltyEligible?'<span class="badge danger">کسر پورسانت</span>':''}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">موردی برای بازه/فیلتر انتخاب‌شده پیدا نشد.</div>';
      out.innerHTML=x;
    }catch(e){out.innerHTML=`<div class="error">گزارش کنترل Lead فعال نشد: ${h(e.message||e)}</div>`;}
  }
  window.pageLeadAudit = async function(){
    setPage('کنترل Lead فروش', `<main class="main-content"><div class="card"><div class="card-header"><h5>کنترل Lead ID فاکتورهای فروش</h5></div><div class="card-body"><div class="info">در دوره آزمایشی، فاکتور بدون Lead ID مسدود نمی‌شود؛ اما اینجا برای کسر پورسانت، Lead تکراری و فرمت مشکوک کنترل می‌شود.</div><div class="row three"><div class="form-group"><label>بازه روز</label><input id="leadControlDays" type="number" value="31" min="1" max="180"></div><div class="form-group"><label>فیلتر</label><select id="leadControlMode"><option value="">همه</option><option value="without">فقط بدون Lead ID</option><option value="with">فقط دارای Lead ID</option><option value="duplicate">Lead ID تکراری</option><option value="bad">فرمت مشکوک</option></select></div><div class="form-group"><label>فروشنده/نام کاربری</label><input id="leadControlSeller" placeholder="مثلاً masoud یا مسعود"></div></div><div class="lead-control-tools"><button class="btn red" id="leadControlLoad">نمایش گزارش</button><button class="btn" id="leadControlCsv">خروجی CSV</button></div><div id="leadControlOut" class="mt"></div></div></div></main>`);
    q('#leadControlLoad').onclick=loadLeadControl;
    q('#leadControlCsv').onclick=()=>csvDownload(lastLeadControlRows||[]);
    await loadLeadControl();
  };
  const prevRoute=window.route||route;
  window.route=route=async function(){const p=location.hash.slice(1)||firstAllowedPage(); if(p==='lead-audit'||p==='lead-control') return pageLeadAudit(); return prevRoute.apply(this,arguments);};
  const prevRender=window.renderMenu||renderMenu;
  window.renderMenu=renderMenu=function(){try{prevRender.apply(this,arguments);}catch(e){} const m=q('#menu'); if(!m) return; let b=q('[data-page="lead-audit"]'); if(!b){b=document.createElement('button');b.className='navbtn';b.dataset.page='lead-audit';b.onclick=(e)=>{e.preventDefault();location.hash='lead-audit';route();};const reports=q('[data-page="reports"]'); if(reports) reports.parentNode.insertBefore(b,reports); else m.appendChild(b);} b.textContent='کنترل Lead فروش';};
  setTimeout(()=>{try{if(q('#menu'))renderMenu();}catch(e){console.error('lead control menu',e)}},120);
})();


/* 0.9.16.4: sale form reset after successful issue + persistent logo safeguard */
(function(){
  window.MKCRM_VERSION='0.9.16.8-proforma-live-total-persian-search';
  const st=document.createElement('style');
  st.textContent='.brand.brand-with-logo{padding:14px 18px 7px!important;display:flex!important;flex-direction:column!important;align-items:center!important;gap:6px!important}.brand-logo-img{width:210px!important;max-width:100%!important;height:auto!important;background:#fff!important;border-radius:10px!important;padding:6px!important;box-shadow:0 3px 10px rgba(0,0,0,.20)!important;display:block!important}.brand-system{font-size:12px!important;letter-spacing:.4px!important;color:#e5e7eb!important}';
  document.head.appendChild(st);
})();

/* 0.9.17.0 Customer Bank + Data Quality */
(function(){
  window.MKCRM_VERSION='0.9.17.5-customer-search-money-format-purchase-sql';
  function q(s){return document.querySelector(s)}
  function h(v){try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}}
  function n(v){try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}}
  function d(v){try{return v?new Date(v).toLocaleDateString('fa-IR'):''}catch{return String(v||'')}}
  async function loadCustomerReports(type=''){
    const out=q('#custReportOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال محاسبه گزارش بانک مشتریان...</div>';
    const r=await api('/api/customers/reports'+(type?`?type=${encodeURIComponent(type)}&limit=150`:''));
    const s=r.summary||{};
    let x=`<div class="lead-control-kpi grid3"><div class="stat"><b>${n(s.total)}</b><span>کل مشتریان</span></div><div class="stat ok"><b>${n(s.repeated)}</b><span>مشتری تکراری</span></div><div class="stat danger"><b>${n(s.invalid)}</b><span>اطلاعات نامعتبر</span></div><div class="stat warn"><b>${n(s.partial)}</b><span>ناقص/نیمه‌کامل</span></div><div class="stat danger"><b>${n(s.missingMobile)}</b><span>بدون موبایل</span></div><div class="stat danger"><b>${n(s.missingNational)}</b><span>بدون کد ملی</span></div><div class="stat warn"><b>${n(s.duplicateMobiles)}</b><span>موبایل تکراری</span></div><div class="stat warn"><b>${n(s.duplicateNationalCodes)}</b><span>کد ملی تکراری</span></div><div class="stat"><b>${n(s.inactive90)}</b><span>غیرفعال ۹۰ روزه</span></div></div>`;
    const list=r.list||[];
    if(list.length){x+=`<h4>ریزگزارش</h4><table class="table"><thead><tr><th>نام</th><th>موبایل</th><th>کد ملی</th><th>خرید</th><th>جمع خرید</th><th>آخرین خرید</th><th>کیفیت</th><th>پروفایل</th></tr></thead><tbody>${list.map(c=>`<tr><td>${h(c.fullName)}</td><td>${h(c.mobile)}</td><td>${h(c.nationalCode)}</td><td>${n(c.purchaseCount)}</td><td>${n(c.totalPurchaseAmount)}</td><td>${h(d(c.lastPurchaseDate))}</td><td>${h(c.dataQualityStatus||'')}<br><span class="small muted">${h((c.dataQualityFlags||[]).join('، '))}</span></td><td><button class="mini custProfile" data-key="${h(c.customerKey)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;} else x+='<div class="muted">برای دیدن ریز، یکی از فیلترهای کیفیت را انتخاب کن.</div>';
    out.innerHTML=x; document.querySelectorAll('.custProfile').forEach(b=>b.onclick=()=>loadCustomerProfile(b.dataset.key));
  }
  async function loadCustomerProfile(key){
    const out=q('#custProfileOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال خواندن پروفایل مشتری...</div>';
    const r=await api('/api/customers/profile/'+encodeURIComponent(key));
    if(!r.ok){out.innerHTML=`<div class="error">${h(r.error||'مشتری پیدا نشد')}</div>`;return;}
    const c=r.customer||{}, hist=r.history||[];
    out.innerHTML=`<div class="card"><div class="card-header"><h5>پروفایل مشتری: ${h(c.fullName||'بدون نام')}</h5></div><div class="card-body"><div class="row three"><div><b>موبایل:</b> ${h(c.mobile||'')}</div><div><b>کد ملی:</b> ${h(c.nationalCode||'')}</div><div><b>وضعیت کیفیت:</b> ${h(c.dataQualityStatus||'')}</div><div><b>تعداد خرید:</b> ${n(c.purchaseCount)}</div><div><b>جمع خرید:</b> ${n(c.totalPurchaseAmount)}</div><div><b>آخرین خرید:</b> ${h(d(c.lastPurchaseDate))}</div></div><div class="small muted">Flags: ${h((c.dataQualityFlags||[]).join('، '))}</div><h4>تاریخچه خرید</h4><table class="table"><thead><tr><th>دوره</th><th>شماره</th><th>تاریخ</th><th>مبلغ</th><th>Lead ID</th><th>فروشنده</th><th>منبع</th></tr></thead><tbody>${hist.map(x=>`<tr><td>${h(x.fiscalDb||'')}</td><td>${h(x.invNo)}</td><td>${h(d(x.invDate))}</td><td>${n(x.totalAmount)}</td><td>${h(x.leadId||'')}</td><td>${h(x.sellerName||x.accountName||'')}</td><td>${h(x.source||'')}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  async function loadDuplicates(kind='mobile'){
    const out=q('#custReportOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال خواندن موارد تکراری...</div>';
    const r=await api('/api/customers/quality/duplicates?kind='+encodeURIComponent(kind));
    const list=r.list||[];
    out.innerHTML=list.length?`<table class="table"><thead><tr><th>${kind==='national'?'کد ملی':'موبایل'}</th><th>تعداد</th><th>نام‌ها</th><th>مشتریان</th></tr></thead><tbody>${list.map(x=>`<tr><td>${h(x._id)}</td><td>${n(x.count)}</td><td>${h((x.names||[]).join('، '))}</td><td>${(x.customers||[]).map(c=>`<button class="mini custProfile" data-key="${h(c.customerKey)}">${h(c.fullName||c.customerKey)}</button>`).join(' ')}</td></tr>`).join('')}</tbody></table>`:'<div class="success">مورد تکراری پیدا نشد.</div>';
    document.querySelectorAll('.custProfile').forEach(b=>b.onclick=()=>loadCustomerProfile(b.dataset.key));
  }
  window.pageCustomers=async function(){
    setPage('بانک مشتریان', `<main class="main-content"><div class="card"><div class="card-header"><h5>بانک مشتریان و کنترل کیفیت اطلاعات</h5></div><div class="card-body"><div class="info">منبع بانک مشتریان: اطلاعات شایگان سال‌های مالی ۱۴۰۴ و ۱۴۰۵ + فاکتورهای جدید CRM. Lead ID فقط در تاریخچه فاکتور نمایش داده می‌شود و منبع هویتی مشتری نیست.</div><div class="row three"><input id="cn" placeholder="نام"><input id="cm" placeholder="موبایل"><input id="cc" placeholder="کد ملی"></div><div class="actions"><button class="btn green" id="saveC">ذخیره/آپدیت مشتری</button><button class="btn red" id="syncCustSql">Sync ۱۴۰۴ و ۱۴۰۵ از شایگان</button><button class="btn" id="refreshCustRep">گزارش کلی</button></div><pre id="co"></pre></div></div><div class="card"><div class="card-header"><h5>جستجو و گزارش</h5></div><div class="card-body"><div class="row three"><input id="custQ" placeholder="نام، موبایل، کد ملی"><select id="custFilter"><option value="">گزارش کلی</option><option value="missing-mobile">بدون موبایل</option><option value="missing-national">بدون کد ملی</option><option value="invalid">نامعتبر</option><option value="partial">ناقص/نیمه‌کامل</option><option value="repeated">مشتریان تکراری</option></select><button class="btn" id="custSearch">جستجو/نمایش</button></div><div class="actions"><button class="btn" id="dupMob">موبایل تکراری</button><button class="btn" id="dupNc">کد ملی تکراری</button></div><div id="custReportOut" class="mt"></div><div id="custProfileOut" class="mt"></div></div></div></main>`);
    q('#saveC').onclick=async()=>q('#co').textContent=JSON.stringify(await post('/api/customers',{fullName:q('#cn').value,mobile:q('#cm').value,nationalCode:q('#cc').value}),null,2);
    q('#syncCustSql').onclick=async()=>{ if(!confirm('Sync مشتریان از CY000002 و CY000001 اجرا شود؟ این عملیات ممکن است چند دقیقه طول بکشد.')) return; q('#co').textContent='در حال Sync...'; q('#co').textContent=JSON.stringify(await post('/api/customers/sync-sql-fiscal',{databases:['CY000002','CY000001'],maxRowsPerDb:50000}),null,2); await loadCustomerReports(); };
    q('#refreshCustRep').onclick=()=>loadCustomerReports();
    q('#custSearch').onclick=async()=>{const term=q('#custQ').value.trim(), type=q('#custFilter').value; if(term){const r=await api('/api/customers/search?q='+encodeURIComponent(term)+'&limit=50'); q('#custReportOut').innerHTML=`<table class="table"><thead><tr><th>نام</th><th>موبایل</th><th>کد ملی</th><th>خرید</th><th>کیفیت</th><th>پروفایل</th></tr></thead><tbody>${(r.list||[]).map(c=>`<tr><td>${h(c.fullName)}</td><td>${h(c.mobile)}</td><td>${h(c.nationalCode)}</td><td>${n(c.purchaseCount)}</td><td>${h(c.dataQualityStatus||'')}</td><td><button class="mini custProfile" data-key="${h(c.customerKey)}">نمایش</button></td></tr>`).join('')}</tbody></table>`; document.querySelectorAll('.custProfile').forEach(b=>b.onclick=()=>loadCustomerProfile(b.dataset.key));} else loadCustomerReports(type);};
    q('#dupMob').onclick=()=>loadDuplicates('mobile'); q('#dupNc').onclick=()=>loadDuplicates('national');
    await loadCustomerReports();
  };
})();

/* 0.9.17.1 Customer Intelligence Reports */
(function(){
  window.MKCRM_VERSION='0.9.17.1-customer-intelligence-reports';
  function q(s){return document.querySelector(s)}
  function h(v){try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}}
  function n(v){try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}}
  function d(v){try{return v?new Date(v).toLocaleDateString('fa-IR'):''}catch{return String(v||'')}}
  async function customerProfile(key){
    const out=q('#custProfileOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال خواندن پروفایل مشتری...</div>';
    const r=await api('/api/customers/profile/'+encodeURIComponent(key));
    if(!r.ok){out.innerHTML=`<div class="error">${h(r.error||'مشتری پیدا نشد')}</div>`;return;}
    const c=r.customer||{}, hist=r.history||[];
    out.innerHTML=`<div class="card"><div class="card-header"><h5>پروفایل مشتری: ${h(c.fullName||'بدون نام')}</h5></div><div class="card-body"><div class="row three"><div><b>موبایل:</b> ${h(c.mobile||'')}</div><div><b>کد ملی:</b> ${h(c.nationalCode||'')}</div><div><b>کیفیت:</b> ${h(c.dataQualityStatus||'')}</div><div><b>تعداد خرید:</b> ${n(c.purchaseCount)}</div><div><b>جمع خرید:</b> ${n(c.totalPurchaseAmount)}</div><div><b>آخرین خرید:</b> ${h(d(c.lastPurchaseDate))}</div><div><b>آخرین کانال:</b> ${h(c.lastSalesChannel||'')}</div><div><b>آخرین واحد:</b> ${h(c.lastBusinessUnit||'')}</div><div><b>آخرین فروشگاه:</b> ${h(c.lastSellerStore||c.lastSourceStore||'')}</div></div><div class="small muted">Flags: ${h((c.dataQualityFlags||[]).join('، '))}</div><h4>تاریخچه خرید</h4><table class="table"><thead><tr><th>دوره</th><th>شماره</th><th>تاریخ</th><th>مبلغ</th><th>کانال</th><th>واحد</th><th>فروشگاه/صندوق</th><th>Lead ID</th><th>فروشنده</th></tr></thead><tbody>${hist.map(x=>`<tr><td>${h(x.fiscalDb||'')}</td><td>${h(x.invNo)}</td><td>${h(d(x.invDate))}</td><td>${n(x.totalAmount)}</td><td>${h(x.channelLabel||x.salesChannel||'')}</td><td>${h(x.businessUnit||'')}</td><td>${h(x.sellerStore||x.sourceStore||x.accountName||'')}</td><td>${h(x.leadId||'')}</td><td>${h(x.sellerName||'')}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  function customerRows(list){
    return `<table class="table"><thead><tr><th>نام</th><th>موبایل</th><th>کد ملی</th><th>تعداد خرید</th><th>جمع خرید</th><th>آخرین خرید</th><th>کانال/واحد</th><th>پروفایل</th></tr></thead><tbody>${(list||[]).map(c=>`<tr><td>${h(c.fullName)}</td><td>${h(c.mobile)}</td><td>${h(c.nationalCode)}</td><td>${n(c.purchaseCount)}</td><td>${n(c.totalPurchaseAmount)}</td><td>${h(d(c.lastPurchaseDate))}</td><td>${h(c.lastSalesChannel||'')} / ${h(c.lastBusinessUnit||'')}</td><td><button class="mini custProfile" data-key="${h(c.customerKey)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;
  }
  function historyRows(list){
    return `<table class="table"><thead><tr><th>مشتری</th><th>موبایل</th><th>کد ملی</th><th>شماره فاکتور</th><th>تاریخ</th><th>مبلغ</th><th>کانال</th><th>واحد</th><th>فروشگاه/صندوق</th><th>Lead ID</th><th>فروشنده</th></tr></thead><tbody>${(list||[]).map(x=>`<tr><td>${h(x.fullName||x.accountName)}</td><td>${h(x.mobile)}</td><td>${h(x.nationalCode)}</td><td>${h(x.invNo)}</td><td>${h(d(x.invDate))}</td><td>${n(x.totalAmount)}</td><td>${h(x.channelLabel||x.salesChannel||'')}</td><td>${h(x.businessUnit||'')}</td><td>${h(x.sellerStore||x.sourceStore||x.accountName||'')}</td><td>${h(x.leadId||'')}</td><td>${h(x.sellerName||'')}</td></tr>`).join('')}</tbody></table>`;
  }
  async function loadBaseCustomerReports(type=''){
    const out=q('#custReportOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال محاسبه گزارش بانک مشتریان...</div>';
    const r=await api('/api/customers/reports'+(type?`?type=${encodeURIComponent(type)}&limit=150`:''));
    const s=r.summary||{};
    let x=`<div class="lead-control-kpi grid3"><div class="stat"><b>${n(s.total)}</b><span>کل مشتریان</span></div><div class="stat ok"><b>${n(s.repeated)}</b><span>مشتری پرتکرار</span></div><div class="stat"><b>${n(s.highValue)}</b><span>خرید بالا</span></div><div class="stat"><b>${n(s.siteInvoices)}</b><span>فاکتور سایت</span></div><div class="stat"><b>${n(s.consoleInvoices)}</b><span>فاکتور کنسول</span></div><div class="stat warn"><b>${n(s.withoutLeadInvoices)}</b><span>خرید CRM بدون Lead</span></div><div class="stat danger"><b>${n(s.missingMobile)}</b><span>بدون موبایل</span></div><div class="stat danger"><b>${n(s.missingNational)}</b><span>بدون کد ملی</span></div><div class="stat danger"><b>${n(s.invalid)}</b><span>نامعتبر</span></div></div>`;
    if((r.list||[]).length) x+=customerRows(r.list); else x+='<div class="muted">برای ریزگزارش، یکی از فیلترها یا گزارش‌های مدیریتی را انتخاب کن.</div>';
    out.innerHTML=x; document.querySelectorAll('.custProfile').forEach(b=>b.onclick=()=>customerProfile(b.dataset.key));
  }
  async function loadIntelligence(type){
    const out=q('#custReportOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال خواندن گزارش مدیریتی مشتریان...</div>';
    const minAmount=q('#custMinAmount')?.value||'';
    const minPurchases=q('#custMinPurchases')?.value||'';
    const days=q('#custDays')?.value||'';
    const r=await api(`/api/customers/intelligence?type=${encodeURIComponent(type)}&limit=200&minAmount=${encodeURIComponent(minAmount)}&minPurchases=${encodeURIComponent(minPurchases)}&days=${encodeURIComponent(days)}`);
    const titles={frequent:'مشتریان پرتکرار', 'high-value':'مشتریان با خرید بالا', new:'مشتریان جدید', returned:'مشتریان برگشتی ۱۴۰۴ به ۱۴۰۵', inactive:'مشتریان غیرفعال'};
    out.innerHTML=`<h4>${h(titles[type]||type)}</h4>`+customerRows(r.list||[]);
    document.querySelectorAll('.custProfile').forEach(b=>b.onclick=()=>customerProfile(b.dataset.key));
  }
  async function loadHistoryReport(type){
    const out=q('#custReportOut'); if(!out) return;
    out.innerHTML='<div class="info">در حال خواندن گزارش تاریخچه خرید...</div>';
    const r=await api(`/api/customers/history-report?type=${encodeURIComponent(type)}&limit=300`);
    const titles={site:'مشتریان/فاکتورهای سایت - صندوق مشهد کالا', console:'مشتریان/فاکتورهای کنسول', store:'مشتریان فروشگاه‌ها از فاکتورهای جدید CRM', 'without-lead':'مشتریان خریدکرده بدون Lead ID'};
    out.innerHTML=`<h4>${h(titles[type]||type)}</h4>`+historyRows(r.list||[]);
  }
  window.pageCustomers=async function(){
    setPage('بانک مشتریان', `<main class="main-content"><div class="card"><div class="card-header"><h5>بانک مشتریان و گزارش‌های مدیریتی</h5></div><div class="card-body"><div class="info">بانک مشتریان بر اساس شایگان ۱۴۰۴ و ۱۴۰۵ + فاکتورهای جدید CRM ساخته می‌شود. فاکتورهای صندوق مشهد کالا به‌عنوان مشتریان سایت و صندوق کنسول به‌عنوان مشتریان بخش کنسول تفکیک می‌شوند. تفکیک فروشگاه‌ها از امروز به بعد بر اساس فروشگاه کاربر صادرکننده فاکتور CRM دقیق‌تر است.</div><div class="row three"><input id="cn" placeholder="نام"><input id="cm" placeholder="موبایل"><input id="cc" placeholder="کد ملی"></div><div class="actions"><button class="btn green" id="saveC">ذخیره/آپدیت مشتری</button><button class="btn red" id="syncCustSql">Sync ۱۴۰۴ و ۱۴۰۵ از شایگان</button><button class="btn" id="refreshCustRep">گزارش کلی</button></div><pre id="co"></pre></div></div><div class="card"><div class="card-header"><h5>گزارش‌های اصلی بانک مشتریان</h5></div><div class="card-body"><div class="row three"><input id="custQ" placeholder="نام، موبایل، کد ملی"><input id="custMinPurchases" placeholder="حداقل تعداد خرید" value="2"><input id="custMinAmount" placeholder="حداقل مبلغ خرید" value="1000000000"></div><div class="row three"><input id="custDays" placeholder="بازه روز برای جدید/غیرفعال" value="90"><select id="custFilter"><option value="">کیفیت: گزارش کلی</option><option value="missing-mobile">بدون موبایل</option><option value="missing-national">بدون کد ملی</option><option value="invalid">نامعتبر</option><option value="partial">ناقص/نیمه‌کامل</option><option value="repeated">تکراری</option></select><button class="btn" id="custSearch">جستجو/کیفیت</button></div><div class="actions"><button class="btn primary" id="repFrequent">مشتریان پرتکرار</button><button class="btn primary" id="repHighValue">خرید بالا</button><button class="btn" id="repNew">مشتریان جدید</button><button class="btn" id="repReturned">برگشتی ۱۴۰۴→۱۴۰۵</button><button class="btn" id="repInactive">غیرفعال</button></div><div class="actions"><button class="btn green" id="repSite">مشتریان سایت</button><button class="btn green" id="repConsole">مشتریان کنسول</button><button class="btn" id="repStore">فروشگاه‌ها از امروز</button><button class="btn warn" id="repWithoutLead">خرید بدون Lead</button><button class="btn" id="dupMob">موبایل تکراری</button><button class="btn" id="dupNc">کد ملی تکراری</button></div><div id="custReportOut" class="mt"></div><div id="custProfileOut" class="mt"></div></div></div></main>`);
    q('#saveC').onclick=async()=>q('#co').textContent=JSON.stringify(await post('/api/customers',{fullName:q('#cn').value,mobile:q('#cm').value,nationalCode:q('#cc').value}),null,2);
    q('#syncCustSql').onclick=async()=>{ if(!confirm('Sync مشتریان از CY000002 و CY000001 اجرا شود؟ این عملیات ممکن است چند دقیقه طول بکشد.')) return; q('#co').textContent='در حال Sync...'; q('#co').textContent=JSON.stringify(await post('/api/customers/sync-sql-fiscal',{databases:['CY000002','CY000001'],maxRowsPerDb:50000}),null,2); await loadBaseCustomerReports(); };
    q('#refreshCustRep').onclick=()=>loadBaseCustomerReports();
    q('#custSearch').onclick=async()=>{const term=q('#custQ').value.trim(), type=q('#custFilter').value; if(term){const r=await api('/api/customers/search?q='+encodeURIComponent(term)+'&limit=80'); q('#custReportOut').innerHTML=customerRows(r.list||[]); document.querySelectorAll('.custProfile').forEach(b=>b.onclick=()=>customerProfile(b.dataset.key));} else loadBaseCustomerReports(type);};
    q('#repFrequent').onclick=()=>loadIntelligence('frequent'); q('#repHighValue').onclick=()=>loadIntelligence('high-value'); q('#repNew').onclick=()=>loadIntelligence('new'); q('#repReturned').onclick=()=>loadIntelligence('returned'); q('#repInactive').onclick=()=>loadIntelligence('inactive');
    q('#repSite').onclick=()=>loadHistoryReport('site'); q('#repConsole').onclick=()=>loadHistoryReport('console'); q('#repStore').onclick=()=>loadHistoryReport('store'); q('#repWithoutLead').onclick=()=>loadHistoryReport('without-lead');
    q('#dupMob').onclick=async()=>{const r=await api('/api/customers/quality/duplicates?kind=mobile');q('#custReportOut').innerHTML=`<h4>موبایل تکراری</h4><table class="table"><thead><tr><th>موبایل</th><th>تعداد</th><th>نام‌ها</th></tr></thead><tbody>${(r.list||[]).map(x=>`<tr><td>${h(x._id)}</td><td>${n(x.count)}</td><td>${h((x.names||[]).join('، '))}</td></tr>`).join('')}</tbody></table>`};
    q('#dupNc').onclick=async()=>{const r=await api('/api/customers/quality/duplicates?kind=national');q('#custReportOut').innerHTML=`<h4>کد ملی تکراری</h4><table class="table"><thead><tr><th>کد ملی</th><th>تعداد</th><th>نام‌ها</th></tr></thead><tbody>${(r.list||[]).map(x=>`<tr><td>${h(x._id)}</td><td>${n(x.count)}</td><td>${h((x.names||[]).join('، '))}</td></tr>`).join('')}</tbody></table>`};
    await loadBaseCustomerReports();
  };
})();


/* 0.9.17.5: regression guard - sale customer search restore, money input comma formatting, purchase item SQL search */
(function(){
  window.MKCRM_VERSION='0.9.17.5-customer-search-money-format-purchase-sql';
  function qs(s){return document.querySelector(s)}
  function qsa(s){return Array.from(document.querySelectorAll(s))}
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}}
  function faToEnDigits(v){return String(v??'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));}
  function rawNumber(v){return faToEnDigits(v).replace(/[,،\s]/g,'').replace(/[^0-9.\-]/g,'');}
  function formatMoney(v){const raw=rawNumber(v); if(raw===''||raw==='-'||raw==='.') return raw; const neg=raw.startsWith('-'); const [i,d]=raw.replace('-','').split('.'); const out=(i||'0').replace(/^0+(?=\d)/,'').replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg?'-':'')+out+(d!==undefined?'.'+d.slice(0,2):'');}
  const moneyIds=new Set(['Price','saleDiscount','pfPrice','buyPrice','discountAmount','invoiceDiscount','salePrice','purchasePrice']);
  function isMoneyInput(el){return el && el.tagName==='INPUT' && moneyIds.has(el.id)}
  function prepareMoneyInputs(){
    moneyIds.forEach(id=>{const el=qs('#'+id); if(el){el.type='text'; el.inputMode='numeric'; el.autocomplete='off'; if(el.value) el.value=formatMoney(el.value);}});
  }
  function cleanMoneyInputs(){moneyIds.forEach(id=>{const el=qs('#'+id); if(el) el.value=rawNumber(el.value);});}
  function reformatMoneyInputs(){moneyIds.forEach(id=>{const el=qs('#'+id); if(el && document.activeElement!==el && el.value) el.value=formatMoney(el.value);});}
  document.addEventListener('input', function(e){ if(isMoneyInput(e.target)){ const pos=e.target.selectionStart; e.target.value=formatMoney(e.target.value); try{e.target.setSelectionRange(e.target.value.length,e.target.value.length)}catch{} } }, false);
  document.addEventListener('focusin', function(e){ if(isMoneyInput(e.target)) e.target.value=rawNumber(e.target.value); }, true);
  document.addEventListener('focusout', function(e){ if(isMoneyInput(e.target)) e.target.value=formatMoney(e.target.value); }, true);
  document.addEventListener('click', function(e){ const id=e.target && e.target.id; if(['addLineBtn','issueBtn','pfAdd','pfSave','buyAdd','buySave'].includes(id)) cleanMoneyInputs(); }, true);
  document.addEventListener('submit', cleanMoneyInputs, true);

  function customerLabel(c){return `${c.fullName||c.customerName||'بدون نام'} ${c.mobile?' | '+c.mobile:''} ${c.nationalCode?' | کد ملی '+c.nationalCode:''} ${c.purchaseCount?` | ${c.purchaseCount} خرید`:''}`;}
  function fillSaleCustomer(c){
    if(!c) return;
    if(qs('#buyerName')) qs('#buyerName').value=c.fullName||c.customerName||'';
    if(qs('#buyerMobile')) qs('#buyerMobile').value=c.mobile||'';
    if(qs('#buyerNational')) qs('#buyerNational').value=c.nationalCode||'';
    const hint=qs('#saleCustomerHint');
    if(hint) hint.innerHTML=`<div class="success">مشتری از بانک CRM تکمیل شد: ${safe(customerLabel(c))}</div>`;
  }
  function installSaleCustomerSearchFinal(){
    if(!qs('#buyerName') || qs('#saleCustomerSearchBox')) return;
    const row=qs('#buyerName').closest('.row') || qs('#buyerName').parentElement?.parentElement;
    if(!row || !row.parentElement) return;
    const wrap=document.createElement('div');
    wrap.id='saleCustomerSearchBox';
    wrap.className='card customer-autofill-card';
    wrap.innerHTML=`<div class="card-body"><div class="info">بانک مشتریان CRM فعال است: نام، موبایل یا کد ملی را جستجو کن و مشخصات را به فاکتور منتقل کن.</div><div class="form-group account-picker"><label>جستجوی مشتری</label><input id="saleCustomerSearch" placeholder="نام / موبایل / کد ملی" autocomplete="off"><div id="saleCustomerResults" class="floating-list account-list"></div></div><div id="saleCustomerHint" class="mt6"></div></div>`;
    row.parentElement.appendChild(wrap);
    const input=qs('#saleCustomerSearch'), list=qs('#saleCustomerResults');
    let timer=null,last=[];
    input.addEventListener('input',()=>{
      clearTimeout(timer);
      const term=input.value.trim();
      if(term.length<2){list.style.display='none';list.innerHTML='';return;}
      timer=setTimeout(async()=>{
        list.style.display='block'; list.innerHTML='<div class="floating-empty">در حال جستجوی مشتری...</div>';
        try{
          const r=await api(`/api/customers/search?q=${encodeURIComponent(term)}&limit=30`);
          last=r.list||[];
          list.innerHTML=last.length?last.map((c,i)=>`<div class="floating-item customer-pick" data-i="${i}"><b>${safe(c.fullName||c.customerName||'بدون نام')}</b><br><span>${safe(c.mobile||'')} ${c.nationalCode?' | کد ملی '+safe(c.nationalCode):''}</span><br><small>خرید: ${safe(c.purchaseCount||0)} | جمع: ${Number(c.totalPurchaseAmount||0).toLocaleString('fa-IR')} | آخرین: ${safe(c.lastPurchaseDate||'')}</small></div>`).join(''):'<div class="floating-empty">مشتری پیدا نشد</div>';
          list.querySelectorAll('.customer-pick').forEach(el=>el.onclick=()=>{const c=last[Number(el.dataset.i)]; fillSaleCustomer(c); input.value=customerLabel(c); list.style.display='none';});
        }catch(err){list.innerHTML=`<div class="floating-empty error">${safe(err.message||err)}</div>`;}
      },250);
    });
    ['buyerName','buyerMobile','buyerNational'].forEach(id=>{const el=qs('#'+id); if(!el)return; el.addEventListener('blur',async()=>{const term=el.value.trim(); if(term.length<3)return; try{const r=await api(`/api/customers/search?q=${encodeURIComponent(term)}&limit=1`); const c=(r.list||[])[0]; if(c){const hint=qs('#saleCustomerHint'); if(hint) hint.innerHTML=`<div class="info">مشتری مشابه پیدا شد: <button class="btn small" id="fillSimilarCustomer">تکمیل اطلاعات</button> ${safe(customerLabel(c))}</div>`; const b=qs('#fillSimilarCustomer'); if(b)b.onclick=()=>fillSaleCustomer(c);}}catch{}});});
  }
  const finalPageSale=window.pageSale||pageSale;
  if(typeof finalPageSale==='function'){
    window.pageSale=pageSale=async function(){const r=await finalPageSale.apply(this,arguments); setTimeout(()=>{installSaleCustomerSearchFinal(); prepareMoneyInputs();},180); return r;};
  }
  const finalPageProforma=window.pageProforma||pageProforma;
  if(typeof finalPageProforma==='function'){
    window.pageProforma=pageProforma=async function(){const r=await finalPageProforma.apply(this,arguments); setTimeout(prepareMoneyInputs,120); return r;};
  }
  const finalPagePurchase=window.pagePurchaseDraft||pagePurchaseDraft;
  if(typeof finalPagePurchase==='function'){
    window.pagePurchaseDraft=pagePurchaseDraft=async function(){const r=await finalPagePurchase.apply(this,arguments); setTimeout(()=>{prepareMoneyInputs(); const msg=qs('#buyItemMsg'); if(msg) msg.textContent='جستجوی نام کالا از WebService شایگان انجام می‌شود.';},150); return r;};
  }
  const finalIssueSale=window.issueSale||issueSale;
  if(typeof finalIssueSale==='function'){
    window.issueSale=issueSale=async function(){cleanMoneyInputs(); const r=await finalIssueSale.apply(this,arguments); setTimeout(reformatMoneyInputs,80); return r;};
  }
  const finalRoute=window.route||route;
  window.route=route=async function(){const r=await finalRoute.apply(this,arguments); setTimeout(prepareMoneyInputs,220); return r;};
  const st=document.createElement('style');
  st.textContent='.customer-autofill-card{margin-top:10px;border:1px solid #dbeafe;background:#eff6ff}.customer-autofill-card .floating-list{max-height:280px;overflow:auto}.floating-item.customer-pick{padding:8px;border-bottom:1px solid #e5e7eb;cursor:pointer}.floating-item.customer-pick:hover{background:#fef3c7} input[inputmode="numeric"]{direction:ltr;text-align:left;font-family:Tahoma,Arial}';
  document.head.appendChild(st);
})();


/* 0.9.17.6: HARD RESTORE sale customer bank search + invoice customer upsert guard
   - Final pageSale override does not call older sale renderers that referenced removed reserveBtn.
   - Adds one separate customer search box + live search on buyerName/buyerMobile/buyerNational.
   - Keeps final invoice number guard, Lead soft sync, money formatting, Persian search, and all previous fixes.
*/
(function(){
  window.MKCRM_VERSION='0.9.17.6-customer-search-hard-restore';
  function qs(s){return document.querySelector(s)}
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}}
  function faToEnDigits(v){return String(v??'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));}
  function rawNumber(v){return faToEnDigits(v).replace(/[,،\s]/g,'').replace(/[^0-9.\-]/g,'');}
  function formatMoney(v){const raw=rawNumber(v); if(raw===''||raw==='-'||raw==='.') return raw; const neg=raw.startsWith('-'); const [i,d]=raw.replace('-','').split('.'); const out=(i||'0').replace(/^0+(?=\d)/,'').replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg?'-':'')+out+(d!==undefined?'.'+d.slice(0,2):'');}
  function n(v){try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}}
  function customerLabel(c){return `${c.fullName||c.customerName||'بدون نام'}${c.mobile?' | '+c.mobile:''}${c.nationalCode?' | کد ملی '+c.nationalCode:''}${c.purchaseCount?` | ${c.purchaseCount} خرید`:''}`;}
  function fillSaleCustomer(c){
    if(!c) return;
    if(qs('#buyerName')) qs('#buyerName').value=c.fullName||c.customerName||c.name||'';
    if(qs('#buyerMobile')) qs('#buyerMobile').value=c.mobile||'';
    if(qs('#buyerNational')) qs('#buyerNational').value=c.nationalCode||'';
    const hint=qs('#saleCustomerHint');
    if(hint) hint.innerHTML=`<div class="success">مشتری از بانک CRM انتخاب شد: ${safe(customerLabel(c))}</div>`;
  }
  function customerResultHtml(arr){
    return arr.length?arr.map((c,i)=>`<div class="floating-item customer-pick" data-i="${i}"><b>${safe(c.fullName||c.customerName||'بدون نام')}</b><br><span>${safe(c.mobile||'')}${c.nationalCode?' | کد ملی '+safe(c.nationalCode):''}</span><br><small>خرید: ${safe(c.purchaseCount||0)} | جمع خرید: ${n(c.totalPurchaseAmount||0)} | آخرین: ${safe(c.lastPurchaseDate||'')}</small></div>`).join(''):'<div class="floating-empty">مشتری پیدا نشد</div>';
  }
  function installSaleCustomerHardSearch(){
    if(!qs('#buyerName')) return;
    if(!qs('#saleCustomerSearchBox')){
      const row=qs('#buyerName').closest('.row') || qs('#buyerName').parentElement?.parentElement;
      if(row && row.parentElement){
        const wrap=document.createElement('div');
        wrap.id='saleCustomerSearchBox';
        wrap.className='card customer-autofill-card';
        wrap.innerHTML=`<div class="card-body"><div class="info">بانک مشتریان CRM فعال است. در فیلد جداگانه یا مستقیم در نام، موبایل یا کد ملی تایپ کن؛ با انتخاب مشتری، اطلاعات فاکتور تکمیل می‌شود.</div><div class="form-group account-picker"><label>جستجوی مشتری</label><input id="saleCustomerSearch" placeholder="نام / موبایل / کد ملی" autocomplete="off"><div id="saleCustomerResults" class="floating-list account-list"></div></div><div id="saleCustomerHint" class="mt6"></div></div>`;
        row.parentElement.appendChild(wrap);
      }
    }
    const resultBox=qs('#saleCustomerResults');
    let timer=null,last=[],requestSeq=0,requestController=null,dismissedByEscape=false,restoringFocusAfterEscape=false;
    function cancelCustomerSearch(){clearTimeout(timer);timer=null;requestSeq++;if(requestController)requestController.abort();requestController=null;}
    function dismissCustomerSearch(){dismissedByEscape=true;restoringFocusAfterEscape=true;cancelCustomerSearch();queueMicrotask(()=>{restoringFocusAfterEscape=false;});}
    function openCustomerResults(trigger){popupSuggestionController.open({popup:resultBox,trigger,optionSelector:'.customer-pick',onEscape:dismissCustomerSearch});}
    uiPageLifecycle.add(cancelCustomerSearch);
    async function runCustomerSearch(term,trigger=qs('#saleCustomerSearch')||document.activeElement){
      if(!resultBox) return;
      const q=String(term||'').trim();
      if(q.length<2){popupSuggestionController.close({restoreFocus:false});resultBox.innerHTML='';return;}
      const seq=++requestSeq;if(requestController)requestController.abort();requestController=new AbortController();
      resultBox.style.display='block'; resultBox.innerHTML='<div class="floating-empty">در حال جستجوی مشتری...</div>';
      openCustomerResults(trigger);
      try{
        const r=await api(`/api/customers/search?q=${encodeURIComponent(q)}&limit=30`,{signal:requestController.signal});if(seq!==requestSeq)return;
        last=r.list||[];
        resultBox.innerHTML=customerResultHtml(last);
        resultBox.querySelectorAll('.customer-pick').forEach(el=>el.onclick=()=>{const c=last[Number(el.dataset.i)]; dismissedByEscape=false;fillSaleCustomer(c); const si=qs('#saleCustomerSearch'); if(si) si.value=customerLabel(c); popupSuggestionController.close();});
        openCustomerResults(trigger);
      }catch(e){if(e.name==='AbortError')return;popupSuggestionController.close({restoreFocus:false});resultBox.innerHTML=`<div class="floating-empty error">خطا در جستجوی مشتری: ${safe(e.message||e)}</div>`;}
    }
    function bindLive(id){
      const el=qs('#'+id); if(!el || el.dataset.customerHardBound==='1') return;
      el.dataset.customerHardBound='1';
      el.addEventListener('input',()=>{dismissedByEscape=false;clearTimeout(timer); const q=el.value.trim(); timer=setTimeout(()=>runCustomerSearch(q,el),260);});
      el.addEventListener('focus',()=>{if(restoringFocusAfterEscape||!dismissedByEscape)return;dismissedByEscape=false;clearTimeout(timer);const q=el.value.trim();if(q.length>=2)timer=setTimeout(()=>runCustomerSearch(q,el),260);});
    }
    ['saleCustomerSearch','buyerName','buyerMobile','buyerNational'].forEach(bindLive);
  }
  function prepareSaleMoney(){
    ['Price','saleDiscount','discountAmount','invoiceDiscount'].forEach(id=>{const el=qs('#'+id); if(el){el.type='text'; el.inputMode='numeric'; el.autocomplete='off'; if(el.value) el.value=formatMoney(el.value);}});
  }
  // Replace sale page renderer completely to avoid older reserveBtn handler and preserve customer search.
  window.pageSale=pageSale=async function(){
    state.saleLines=[]; state.selectedItem=null; state.selectedStock=null; state.invoiceNumber=null;
    setPage('فاکتور فروش جدید',`<main class="main-content"><div class="card"><div class="card-header danger"><h5>فاکتور فروش جدید</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>نام خریدار</label><input id="buyerName" autocomplete="off"></div><div class="form-group"><label>موبایل</label><input id="buyerMobile" autocomplete="off"></div><div class="form-group"><label>کد ملی</label><input id="buyerNational" autocomplete="off"></div><div class="form-group"><label>Lead ID</label><input id="leadId" autocomplete="off"></div></div><div id="sellerMappingBox" class="mapping-box"></div></div></div><div class="card"><div class="card-header"><h5>افزودن کالا - سرچ یکپارچه موجودی فعال CRM</h5></div><div class="card-body"><div class="info">شماره قطعی فاکتور فقط در لحظه صدور از شایگان خوانده می‌شود. دکمه رزرو شماره حذف شده است.</div>${itemSearchWidget('sale')}<div id="saleInventory" class="mt"></div><div class="row three mt"><div class="form-group"><label>انبار انتخاب‌شده</label><input id="STNumber" readonly></div><div class="form-group"><label>تعداد</label><input id="Quan" type="number" value="1"></div><div class="form-group"><label>قیمت</label><input id="Price" inputmode="numeric"></div></div><div id="priceWarn"></div><div id="serialBox" class="mt"></div><div class="actions"><button class="btn green" id="addLineBtn">افزودن ردیف و رفتن به کالای بعدی</button></div><div id="saleLines" class="mt"></div><div class="actions"><button class="btn red" id="issueBtn">صدور فاکتور</button><div class="muted">مشتری جدید بعد از صدور موفق، در بانک مشتریان CRM ثبت/آپدیت می‌شود.</div></div><div id="saleOut"></div></div></div></main>`);
    renderSellerMappingBox().catch(e=>{const el=qs('#sellerMappingBox'); if(el) el.innerHTML=`<div class="error">خطا در خواندن اتصال صندوق/نماینده: ${safe(e.message)}</div>`});
    (window.bindSaleSnapshotSearch || function(){})();
    installSaleCustomerHardSearch();
    prepareSaleMoney();
    const price=qs('#Price'); if(price) price.addEventListener('input',checkBelowCost);
    const add=qs('#addLineBtn'); if(add) add.onclick=addSaleLine;
    renderSaleLines();
    const issue=qs('#issueBtn'); if(issue) issue.onclick=async()=>{try{cleanMoneyInputs&&cleanMoneyInputs();}catch{}; return issueSale();};
  };
  const finalRoute=window.route||route;
  window.route=route=async function(){const r=await finalRoute.apply(this,arguments); if((location.hash.slice(1)||'')==='sale') setTimeout(()=>{installSaleCustomerHardSearch(); prepareSaleMoney();},220); return r;};
  const style=document.createElement('style');
  style.textContent='.customer-autofill-card{margin:10px 0;border:1px solid #bfdbfe;background:#eff6ff}.customer-autofill-card .floating-list{max-height:300px;overflow:auto}.floating-item.customer-pick{padding:8px;border-bottom:1px solid #e5e7eb;cursor:pointer}.floating-item.customer-pick:hover{background:#fef3c7}';
  document.head.appendChild(style);
})();

/* 0.9.18.1: Shaygan invoice view from account ledger - supports historical Shaygan invoices and CRM-issued invoices */
(function(){
  window.MKCRM_VERSION='0.9.19.6-supplier-aging-origin-summary';
  const qs=s=>document.querySelector(s);
  const qsa=s=>Array.from(document.querySelectorAll(s));
  const safe=v=>{try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}};
  const money=v=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return safe(v)}};
  const canAnnotate=()=>['admin','accounting'].includes(String(state.user?.role||''));
  function ledgerText(row){return [row?.Comment,row?.Description,row?.Desc,row?.RowDesc,row?.RowDescription,row?.Detail,row?.DetailDesc,row?.DocumentType,row?.DocType].map(x=>String(x||'')).join(' ')}
  function isInvoiceLedgerRow(row){
    if(row?.InvNo || row?.InvoiceNumber || row?.InvoiceNo || row?.invoiceNo) return true;
    const t=ledgerText(row);
    // Do not make ordinary سند / حقوق / واریز / انتقال rows clickable. Only explicit invoice rows.
    return /(فاکتور|فاكتور|invoice|inv)/i.test(t);
  }
  function invoiceTypeOfLedgerRow(row){
    const explicit=Number(row?.InvTyp || row?.InvoiceType || row?.invoiceType || 0);
    if(explicit===2 || explicit===3) return explicit;
    const t=ledgerText(row);
    if(/خرید|purchase/i.test(t)) return 3;
    return 2;
  }
  function extractInvoiceNo(row){
    if(!isInvoiceLedgerRow(row)) return '';
    const raw = row?.InvNo || row?.InvoiceNumber || row?.InvoiceNo || row?.invoiceNo || '';
    if(raw) return String(raw).replace(/[^0-9]/g,'');
    const fields=[row?.DocumentNumber,row?.DocNo,row?.SanadNo,row?.VouchNumber,ledgerText(row)].map(x=>String(x||''));
    for(const f of fields){ const m=f.match(/(?:فاکتور|فاكتور|invoice|inv)\s*[:#\-\/]?\s*([0-9]{3,})/i); if(m) return m[1]; }
    return '';
  }
  async function fetchInvoiceAnnotations(invNo, invType=2){try{return await api(`/api/invoices/${encodeURIComponent(invNo)}/annotations?invType=${invType}`)}catch(e){return {ok:false,list:[],error:e.message}}}
  function invoiceRowsHtml(rows){
    return `<table class="table"><thead><tr><th>#</th><th>کد کالا</th><th>نام کالا</th><th>انبار</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>${(rows||[]).map((x,i)=>{const qty=Number(x.Quan||x.Quantity||x.quantity||0); const price=Number(x.Price||x.UnitPrice||x.price||0); const amount=Number(x.Amount||x.TotalPrice||qty*price||0); return `<tr><td>${i+1}</td><td>${safe(x.ItemNumber||x.ItemCode||x.itemCode||'')}</td><td>${safe(x.ItemDescription||x.ItemName||x.itemDescription||'')}</td><td>${safe(x.STNumber||x.StockNumber||x.StockName||x.stockName||'')}</td><td>${money(qty)}</td><td>${money(price)}</td><td>${money(amount)}</td></tr>`}).join('')}</tbody></table>`;
  }
  async function openInvoiceView(invNo, invType=2){
    if(!invNo) return;
    let modal=qs('#invoiceLedgerModal');
    if(!modal){modal=document.createElement('div'); modal.id='invoiceLedgerModal'; modal.className='mk-modal'; document.body.appendChild(modal);}
    modal.innerHTML=`<div class="mk-modal-backdrop"></div><div class="mk-modal-card wide"><div class="mk-modal-head"><b>فاکتور ${safe(invNo)}</b><button class="mini" id="closeInvModal">بستن</button></div><div class="mk-modal-body"><div class="small muted">در حال خواندن فاکتور از شایگان...</div></div></div>`;
    modal.style.display='block';uiModalController.open(modal,document.activeElement);qs('#closeInvModal').onclick=()=>uiModalController.close();modal.querySelector('.mk-modal-backdrop').onclick=()=>uiModalController.close();
    const body=modal.querySelector('.mk-modal-body');
    try{
      const r=await api(`/api/invoices/${encodeURIComponent(invNo)}?invType=${invType}`);
      const inv=(r.list||[])[0];
      if(!r.ok || !inv){body.innerHTML=`<div class="error">فاکتور ${safe(invNo)} در شایگان پیدا نشد یا قابل خواندن نیست: ${safe(r.error||'')}</div>`;return;}
      const rows=Array.isArray(inv.Body)?inv.Body:[];
      const gross=rows.reduce((s,x)=>s+Number(x.Amount||(Number(x.Quan||0)*Number(x.Price||0))||0),0);
      const disc=Number(inv.DiscAmount||inv.DiscountAmount||0);
      const net=Math.max(0,gross-disc);
      const ann=await fetchInvoiceAnnotations(invNo,invType);
      body.innerHTML=`<div class="info">منبع رسمی این نمایش شایگان است. فروشنده فقط مشاهده و چاپ دارد. تغییر قیمت، کالا، تعداد و تخفیف فقط از مسیر رسمی شایگان انجام می‌شود.</div>
      <div class="grid3 inv-head"><div><b>شماره:</b> ${safe(inv.InvNo||invNo)}</div><div><b>تاریخ:</b> ${safe(toJalaliDisplay(inv.InvDate||inv.CreatedDate||''))}</div><div><b>طرف حساب:</b> ${safe(inv.AccountName||inv.AccountNumber||'')}</div><div><b>توضیحات:</b> ${safe(inv.InvDescription||'')}</div><div><b>Lead ID:</b> ${safe(inv.LeadId||inv.leadId||'')}</div><div><b>نوع:</b> ${invType==3?'خرید':'فروش'}</div></div>
      ${invoiceRowsHtml(rows)}
      <div class="summary-box"><div>جمع ردیف‌ها: <b>${money(gross)} ریال</b></div><div>تخفیف: <b>${money(disc)} ریال</b></div><div>جمع کل: <b>${money(net)} ریال</b></div></div>
      <div class="actions"><a class="btn" target="_blank" href="/print/invoice/${encodeURIComponent(invNo)}?invType=${invType}">چاپ / نمایش نسخه چاپی</a></div>
      <div class="card mt"><div class="card-header"><h5>یادداشت‌ها و لاگ CRM این فاکتور</h5></div><div class="card-body" id="invoiceAnnBox">${renderAnn(ann.list||[])}</div></div>
      ${canAnnotate()?`<div class="card mt"><div class="card-header"><h5>اصلاحات مجاز CRM - بدون تغییر مالی در شایگان</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>یادداشت مدیریتی / حسابداری</label><input id="invNoteText" placeholder="علت یا توضیح"></div><div class="form-group"><label>اصلاح Lead ID در CRM</label><input id="invLeadOverride" placeholder="Lead ID جدید یا خالی"></div></div><div class="row two"><button class="btn" id="saveInvNote">ثبت یادداشت</button><button class="btn warn" id="saveInvLead">ثبت اصلاح Lead ID با علت</button></div><div class="small muted">تغییر کالا، قیمت، تعداد و تخفیف از CRM غیرفعال است و فقط در شایگان انجام می‌شود.</div></div></div>`:''}`;
      if(canAnnotate()){
        qs('#saveInvNote').onclick=async()=>{const note=qs('#invNoteText').value.trim(); if(!note)return alert('متن یادداشت الزامی است'); const rr=await post(`/api/invoices/${encodeURIComponent(invNo)}/annotations?invType=${invType}`,{note}); await openInvoiceView(invNo,invType);};
        qs('#saveInvLead').onclick=async()=>{const leadId=qs('#invLeadOverride').value.trim(); const reason=prompt('علت اصلاح Lead ID را وارد کن'); if(!reason)return; const rr=await post(`/api/invoices/${encodeURIComponent(invNo)}/crm-lead?invType=${invType}`,{leadId,reason}); await openInvoiceView(invNo,invType);};
      }
    }catch(e){body.innerHTML=`<div class="error">خطا در خواندن فاکتور: ${safe(e.message||e)}</div>`;}
  }
  function renderAnn(list){ if(!list.length) return '<div class="muted">یادداشتی ثبت نشده است.</div>'; return `<table class="table"><thead><tr><th>زمان</th><th>کاربر</th><th>نوع</th><th>شرح</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(toJalaliDisplay(x.at||''))}</td><td>${safe(x.byName||x.by||'')}</td><td>${safe(x.type||'')}</td><td>${safe(x.note||x.reason||((x.oldLeadId||x.newLeadId)?`Lead: ${x.oldLeadId||'-'} → ${x.newLeadId||'-'}`:''))}</td></tr>`).join('')}</tbody></table>`; }
  function renderTurnoverTableWithInvoices(rows, picked, body, tr){
    let h=`<div class="success">${rows.length} ردیف گردش برای ${safe(picked.accountNumber)} - ${safe(picked.accountName||'')}</div><table class="table"><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>سند/فاکتور</th></tr></thead><tbody>`;
    h+=rows.map((x,i)=>{const no=extractInvoiceNo(x); const invType=invoiceTypeOfLedgerRow(x); const doc=safe(x.DocumentNumber||x.DocNo||x.SanadNo||x.VouchNumber||''); return `<tr><td>${safe(toJalaliDisplay(x.Date||x.date||x.InvDate||x.DocDate||x.VouchDate||x.VoucherDate||''))}</td><td>${safe(x.RowDesc||x.Comment||x.Description||x.Desc||x.RowDescription||x.Detail||x.DetailDesc||'')}</td><td>${money(x.DebitAmount||x.Debit||x.Bedehkar||x.RialBed||x.CurrDebitAmount||0)}</td><td>${money(x.CreditAmount||x.Credit||x.Bestankar||x.RialBes||x.CurrCreditAmount||0)}</td><td>${money(x.RemainAccount||x.Remain||x.Balance||x.total||0)}</td><td>${doc} / ${no?`<button class="mini open-ledger-invoice" data-no="${safe(no)}" data-type="${invType}">${safe(no)}</button>`:'-'}</td></tr>`}).join('');
    const debug=`<details><summary>جزئیات تست‌های شایگان</summary><pre class="debug-pre">${safe(JSON.stringify({sent:body, diagnostics:tr.diagnostics||{}, domainUsed:tr.domainUsed||''},null,2))}</pre></details><div id="saleSellerDetailBox" class="mt"></div>`;
    qs('#turnoverOut').innerHTML=h+'</tbody></table>'+debug;
    qsa('.open-ledger-invoice').forEach(b=>b.onclick=()=>openInvoiceView(b.dataset.no,Number(b.dataset.type||2))); 
  }
  // Final override of turnover page keeps strict account identity and adds clickable invoice view.
  window.pageTurnover=pageTurnover=async function(){
    setPage('گردش حساب',`<main class="main-content"><div class="card"><div class="card-header"><h5>گردش حساب</h5></div><div class="card-body"><div class="info">با کلیک روی شماره فاکتور، فاکتور مستقیم از شایگان خوانده می‌شود. فروشنده فقط مشاهده دارد.</div><div id="turnoverAccessMsg" class="small muted"></div><div class="row four"><div id="turnoverSelectWrap" class="form-group"><label>حساب‌های مجاز</label><div id="allowedAccountsBox" class="access-list"></div></div><div id="turnoverSearchWrap" class="form-group account-picker"><label>جستجوی حساب</label><input id="turnoverAccountSearch" placeholder="نام یا کد حساب" autocomplete="off"><div id="turnoverAccountResults" class="floating-list account-list"></div><input id="turnoverPicked" class="readonly mt6" readonly placeholder="حساب انتخاب‌شده"></div><div class="form-group"><label>از تاریخ شمسی (خالی = آخرین ۳۰ گردش)</label><input id="turnoverFrom" placeholder="خالی = آخرین ۳۰ ردیف"></div><div class="form-group"><label>تا تاریخ شمسی</label><input id="turnoverTo" placeholder="خالی = همه"></div></div><button class="btn" id="loadTurnoverBtn">نمایش ۳۰ گردش آخر</button><div id="turnoverOut" class="mt"></div></div></div></main>`);
    const r=await api('/api/account-access/my'); const allowedBox=qs('#allowedAccountsBox'); const searchWrap=qs('#turnoverSearchWrap'); const input=qs('#turnoverAccountSearch'); const box=qs('#turnoverAccountResults');
    // FIX-B: بدون تاریخ پیش‌فرض
    qs('#turnoverFrom').value=''; qs('#turnoverTo').value=''; let picked=null,lastList=[];
    function ag(a){return a?.guId||a?.accountGuid||a?.AccountGuId||a?.raw?.GuId||a?.raw?.AccountGuId||''} function lab(a){return `${a.accountNumber||''} - ${a.accountName||''}${a.moinNumber?' | معین '+a.moinNumber:''}`}
    function setPicked(acc,source='search'){picked={accountNumber:String(acc.accountNumber||''), accountName:acc.accountName||'', moinNumber:acc.moinNumber||'', accountGuid:ag(acc), guId:ag(acc), accountKey:acc.accountKey||'', source}; qs('#turnoverPicked').value=lab(picked)+(picked.accountGuid?` | ${picked.accountGuid.slice(0,8)}`:''); qs('#turnoverOut').innerHTML='';}
    function renderResults(list){lastList=list||[]; box.style.display='block'; box.innerHTML=lastList.length?lastList.map((a,i)=>`<div class="account-result" data-i="${i}"><b>${safe(a.accountName||'')}</b><span>${safe(a.accountNumber||'')}</span><small>${safe(a.moinNumber||'')}${ag(a)?' | '+safe(ag(a).slice(0,8)):''}</small></div>`).join(''):'<div class="floating-empty">نتیجه‌ای پیدا نشد.</div>'; box.querySelectorAll('.account-result').forEach(el=>el.onclick=()=>{const a=lastList[Number(el.dataset.i)]; setPicked(a); input.value=lab(a); box.style.display='none';});}
    const doSearch=debounce(async()=>{const q=input.value.trim(); picked=null; qs('#turnoverPicked').value=''; if(q.length<2){box.style.display='none';return;} box.style.display='block'; box.innerHTML='<div class="floating-empty">در حال جستجو...</div>'; try{const res=await api(`/api/accounts/search?q=${encodeURIComponent(q)}&limit=120&pages=220&strict=1`); renderResults(res.list||[]);}catch(e){box.innerHTML=`<div class="floating-empty">${safe(e.message)}</div>`;}},300);
    if(r.fullAccess){qs('#turnoverAccessMsg').textContent='این گروه کاربری دسترسی کامل گردش حساب دارد.'; qs('#turnoverSelectWrap').style.display='none'; input.addEventListener('input',doSearch); input.addEventListener('keydown',e=>{if(e.key==='Enter'&&lastList.length){e.preventDefault(); const a=lastList[0]; setPicked(a,'enter'); input.value=lab(a); box.style.display='none';}});} else {searchWrap.style.display='none'; const list=r.list||[]; qs('#turnoverAccessMsg').textContent=list.length?'حساب‌های مجاز شما: روی یک حساب کلیک کن.':'هیچ حسابی برای مشاهده گردش شما تعریف نشده است.'; allowedBox.innerHTML=list.length?list.map((a,i)=>`<button class="account-chip allowed-account" data-i="${i}"><b>${safe(a.accountNumber)}</b><span>${safe(a.accountName||'')}</span><small>${safe(a.source||'')}${ag(a)?' | '+safe(ag(a).slice(0,8)):''}</small></button>`).join(''):'<div class="warn">حساب مجاز تعریف نشده است.</div>'; qsa('.allowed-account').forEach(b=>b.onclick=()=>{const a=list[Number(b.dataset.i)]; setPicked(a,'allowed'); qsa('.allowed-account').forEach(x=>x.classList.remove('active')); b.classList.add('active');}); if(list.length===1)setPicked(list[0],'allowed-auto');}
    qs('#loadTurnoverBtn').onclick=async()=>{if(!picked||!picked.accountNumber){qs('#turnoverOut').innerHTML='<div class="error">حساب را از لیست انتخاب کن.</div>';return;} qs('#turnoverOut').innerHTML=`<div class="small muted">در حال دریافت گردش حساب ${safe(picked.accountNumber)}...</div>`; const body={accountNumber:picked.accountNumber,accountName:picked.accountName,accountGuid:picked.accountGuid,accountKey:picked.accountKey,dateFrom:cleanDate8(qs('#turnoverFrom').value.trim()),dateTo:cleanDate8(qs('#turnoverTo').value.trim())}; const tr=await post('/admin/accounting/getTurnover',body); const allRows=tr.list||tr.result||[]; if(!tr.ok){qs('#turnoverOut').innerHTML=`<div class="error">${safe(tr.error||'خطا در خواندن گردش حساب')}</div>`;return;} if(!allRows.length){qs('#turnoverOut').innerHTML=`<div class="warn">گردشی برای ${safe(picked.accountNumber)} در این بازه پیدا نشد.</div>`;return;} // FIX-B: آخرین ۳۰، نزولی
      const hasDate=Boolean(body.dateFrom||body.dateTo); const rows=(hasDate?allRows:allRows.slice(0,30)); renderTurnoverTableWithInvoices(rows,picked,body,{...tr,list:rows,_totalRows:allRows.length,_mode:hasDate?'date-range':'last-30'});};
  };
  const style=document.createElement('style'); style.textContent='.mk-modal{display:none;position:fixed;inset:0;z-index:9999}.mk-modal-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.45)}.mk-modal-card{position:relative;margin:4vh auto;background:#fff;border-radius:12px;max-width:820px;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.25)}.mk-modal-card.wide{max-width:1100px}.mk-modal-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #e5e7eb}.mk-modal-body{padding:14px}.summary-box{margin:12px 0;padding:10px;border:1px solid #ddd;border-radius:8px;background:#fafafa;display:grid;gap:6px}.inv-head{margin:10px 0}'; document.head.appendChild(style);
})();


async function pageSellerProfit(){
  const ym = new Date().toISOString().slice(0,7);
  setPage('عملکرد فروشنده', `<main class="main-content"><div class="card"><div class="card-header"><h5>عملکرد فروشنده و سود FIFO</h5></div><div class="card-body"><div class="info">گزارش از فاکتورهای صادرشده CRM خوانده می‌شود و سود با FIFO مبتنی بر WebService / cache محاسبه می‌شود. برای پرداخت پورسانت، ردیف‌های سود نامشخص باید بررسی شوند.</div><div class="row four"><input id="spMonth" type="month" value="${ym}" title="ماه"><select id="spSeller"><option value="">همه فروشنده‌ها</option></select><input id="spStore" placeholder="فروشگاه اختیاری"><button class="btn primary" id="spLoad">محاسبه</button></div><div class="row four"><input id="spMinProfit" placeholder="سود بالای X ریال"><input id="spMaxProfit" placeholder="سود زیر Y ریال"><input id="spCommissionRate" value="0.18" placeholder="نرخ پورسانت؛ مثال 0.18"><button class="btn" id="spClearFilters">پاک کردن فیلتر سود</button></div><div id="spOut" class="mt"><div class="muted">ماه و فروشنده یا همه را انتخاب کن، سپس محاسبه را بزن.</div></div></div></div></main>`);
  const out=document.getElementById('spOut');
  const sel=document.getElementById('spSeller');
  try{
    const sellers=await api('/api/reports/seller-sales-profit/sellers');
    const list=sellers.list||[];
    sel.innerHTML='<option value="">همه فروشنده‌ها</option>'+list.map(x=>`<option value="${esc(x.username)}" data-store="${esc(x.storeName||'')}">${esc(x.fullName||x.username)}${x.storeName?' - '+esc(x.storeName):''}</option>`).join('');
    sel.onchange=()=>{const o=sel.options[sel.selectedIndex]; if(o&&o.dataset.store&&!document.getElementById('spStore').value) document.getElementById('spStore').value=o.dataset.store;};
  }catch(e){sel.innerHTML='<option value="">خطا در دریافت فروشندگان</option>'; out.innerHTML=`<div class="error">${esc(e.message||e)}</div>`;}
  document.getElementById('spClearFilters').onclick=()=>{document.getElementById('spMinProfit').value='';document.getElementById('spMaxProfit').value='';};
  document.getElementById('spLoad').onclick=async()=>{
    const month=document.getElementById('spMonth').value||'', seller=sel.value||'', store=document.getElementById('spStore').value||'';
    const minProfit=document.getElementById('spMinProfit').value.trim(), maxProfit=document.getElementById('spMaxProfit').value.trim(), commissionRate=document.getElementById('spCommissionRate').value.trim()||'0.18';
    out.innerHTML='<div class="info">در حال خواندن فاکتورها و محاسبه سود FIFO...</div>';
    try{
      const qs = new URLSearchParams({ month, seller, store, minProfit, maxProfit, commissionRate });
      const r=await api(`/api/reports/seller-sales-profit?${qs.toString()}`);
      if(!r.ok){out.innerHTML=`<div class="error">${esc(r.error||'خطا')}</div>`;return;}
      const sm=r.summary||{};
      let html=`<div class="info">فیلتر گروه کالا: ${r.meta?.itemGroup==='notebook'?'فقط نوت‌بوک؛ کد کالا با ۱':'همه کالاها'}</div><div class="kpis"><div class="kpi"><b>${fmt(sm.invoiceCount)}</b><span>تعداد فاکتور</span></div><div class="kpi"><b>${fmt(sm.saleRial)}</b><span>جمع فروش</span></div><div class="kpi"><b>${fmt(sm.fifoProfit)}</b><span>سود FIFO</span></div><div class="kpi"><b>${sm.avgProfitPct==null?'-':fmt(sm.avgProfitPct)+'%'}</b><span>درصد سود</span></div><div class="kpi"><b>${fmt(sm.suggestedCommission)}</b><span>پورسانت پیشنهادی</span></div><div class="kpi warn"><b>${fmt(sm.unmatchedSaleRial)}</b><span>سود نامشخص</span></div></div>`;
      html+=`<h5>جدول خلاصه فروشندگان</h5><table class="table"><thead><tr><th>نام</th><th>فروشگاه</th><th>تعداد فاکتور</th><th>جمع فروش</th><th>سود</th><th>درصد سود</th><th>سود نامشخص</th><th>Lead ندارد</th></tr></thead><tbody>${(r.sellers||[]).map(x=>`<tr><td>${esc(x.sellerName||x.sellerKey)}</td><td>${esc(x.sellerStore||'')}</td><td>${fmt(x.invoiceCount)}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${x.avgProfitPct==null?'-':fmt(x.avgProfitPct)+'%'}</td><td>${fmt(x.unmatchedSaleRial)}</td><td>${fmt(x.withoutLeadCount||0)}</td></tr>`).join('')}</tbody></table>`;
      html+=`<h5>ریز فاکتورها</h5><table class="table"><thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>فروشنده</th><th>مشتری</th><th>فروش</th><th>سود</th><th>درصد سود</th><th>Lead</th><th>نامشخص</th></tr></thead><tbody>${(r.invoices||[]).slice(0,1000).map(x=>`<tr><td>${esc(x.invoiceNo)}</td><td>${esc(x.invoiceDate)}</td><td>${esc(x.sellerName||x.sellerKey)}</td><td>${esc(x.customerName||'')}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${x.profitPct==null?'-':fmt(x.profitPct)+'%'}</td><td>${esc(x.leadId||'')}</td><td>${fmt(x.unmatchedSaleRial)}</td></tr>`).join('')}</tbody></table>`;
      html+=`<h5>جدول پورسانت پیشنهادی</h5><table class="table"><thead><tr><th>نام فروشنده</th><th>جمع فروش</th><th>سود محاسبه‌شده</th><th>نرخ پورسانت</th><th>پورسانت پیشنهادی</th><th>وضعیت Lead</th></tr></thead><tbody>${(r.sellers||[]).map(x=>`<tr><td>${esc(x.sellerName||x.sellerKey)}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${esc(String(x.commissionRate??''))}</td><td>${fmt(x.suggestedCommission)}</td><td>${x.leadStatus==='ok'?'اوکی':'نیازمند بررسی'}</td></tr>`).join('')}</tbody></table>`;
      if((r.unmatched||[]).length) html+=`<div class="warn">${fmt((r.unmatched||[]).length)} ردیف با سود نامشخص وجود دارد؛ قبل از پرداخت قطعی پورسانت بررسی شود.</div>`;
      out.innerHTML=html; wrapTables(out);
    }catch(e){out.innerHTML=`<div class="error">${esc(e.message||e)}</div>`;}
  };
}



/* PATCH 0.9.19.7: Supplier aging inventory-first UI + stability cleanup */
(function(){
  window.MKCRM_VERSION='0.9.19.44-stability-sync-sale-reset-background-jobs';
  const qsa=(s)=>Array.from(document.querySelectorAll(s));
  const qs=(s)=>document.querySelector(s);
  const safe=(v)=>{try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}};
  const money=(v)=>Number(v||0).toLocaleString('fa-IR');
  const payFa=(x)=>({cash:'نقدی',check:'چکی',mixed:'ترکیبی',manual:'دستی/نامشخص'}[String(x||'mixed')]||x||'ترکیبی');
  const riskFa=(r)=>({high:'بالا',medium:'متوسط',low:'پایین'}[String(r||'')]||r||'');
  const riskClass=(r)=>r==='high'?'error':r==='medium'?'warn':'success';

  function normalizeDateDisplay(v){
    const x=String(v||'').trim();
    if(!x) return '';
    const digits=x.replace(/[^0-9]/g,'');
    if(/^\d{8}$/.test(digits) && (digits.startsWith('13')||digits.startsWith('14'))) return `${digits.slice(0,4)}/${digits.slice(4,6)}/${digits.slice(6,8)}`;
    try { return toJalaliDisplay(x); } catch { return x; }
  }
  window.normalizeDateDisplay=normalizeDateDisplay;

  function wrapTables(root=document){
    qsa.call ? null : null;
    Array.from((root||document).querySelectorAll('table.table')).forEach(t=>{
      if(t.closest('.table-scroll')) return;
      const w=document.createElement('div');
      w.className='table-scroll';
      t.parentNode.insertBefore(w,t);
      w.appendChild(t);
    });
  }
  const style=document.createElement('style');
  style.textContent=`
    .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;max-width:100%}
    .table-scroll>.table{min-width:760px}
    .mk-modal-card{max-height:min(88vh,700px);display:flex;flex-direction:column;overflow:hidden}
    .mk-modal-card.wide{max-width:1100px}
    .mk-modal-body{flex:1;overflow-y:auto;min-height:0}
    .origin-summary-row{cursor:pointer}.origin-summary-row:hover{background:#fff7ed}
    .origin-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin:10px 0}.origin-kpi{border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff}.origin-kpi b{display:block;font-size:18px;color:#b91c1c}
  `;
  document.head.appendChild(style);
  const mo=new MutationObserver(()=>wrapTables(document));
  mo.observe(document.documentElement,{childList:true,subtree:true});
  setTimeout(()=>wrapTables(document),500);

  const prevLoadStocks=window.loadStocks || (typeof loadStocks==='function'?loadStocks:null);
  window.loadStocks=loadStocks=async function(){
    const key='mkcrm.stocks.v1';
    try{
      const cached=JSON.parse(localStorage.getItem(key)||'null');
      if(cached && cached.at && Date.now()-cached.at<5*60*1000 && Array.isArray(cached.list)) { state.stocks=cached.list; state._stocks=cached.list; return cached.list; }
    }catch{}
    const list=prevLoadStocks ? await prevLoadStocks() : ((await api('/api/stocks')).list||[]);
    const sorted=(list||[]).sort((a,b)=>String(a.stockNumber).localeCompare(String(b.stockNumber),'fa'));
    state.stocks=sorted; state._stocks=sorted;
    try{localStorage.setItem(key,JSON.stringify({at:Date.now(),list:sorted}));}catch{}
    return sorted;
  };

  window.renderKardex=renderKardex=async function(item,target,stockNumber=''){
    const el=qs(target); if(el) el.innerHTML='در حال خواندن کاردکس...';
    const code=item.itemCode||item;
    const r=await api(`/api/items/${encodeURIComponent(code)}/kardex${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`);
    const rows=r.rows||[];
    let h='<table class="table"><thead><tr><th>تاریخ</th><th>فاکتور</th><th>طرف حساب</th><th>ورود</th><th>خروج</th><th>مانده</th><th>قیمت خرید/تمام‌شده</th><th>قیمت فروش</th><th>سود</th></tr></thead><tbody>';
    h+=rows.map(x=>`<tr><td>${safe(normalizeDateDisplay(x.date||x.Date||x.InvDate||x.DocDate||x.CreatedDate||''))}</td><td>${safe(x.invoiceNumber||x.InvNo||'')}</td><td>${safe(x.accountName||x.AccountName||'')}</td><td>${money(x.inQty)}</td><td>${money(x.outQty)}</td><td>${money(x.remainQty)}</td><td>${money(x.costPrice)}</td><td>${money(x.salePrice)}</td><td>${money(x.grossProfit)}</td></tr>`).join('');
    if(el){el.innerHTML=h+'</tbody></table>'; wrapTables(el);}
  };

  async function loadSelectedSuppliers(){const r=await api('/api/supplier-aging/selected');return r.list||[];}
  async function renderSelectedSuppliersV197(){
    const list=await loadSelectedSuppliers(); const box=qs('#supSelected'); if(!box)return;
    box.innerHTML=list.length?`<table class="table"><thead><tr><th>ID</th><th>تأمین‌کننده</th><th>گروه</th><th>نوع تسویه</th><th>راس دستی</th><th>راس چک</th><th>تأخیر ورود</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountId)}</td><td>${safe(x.accountName||'')}</td><td>${safe(x.group||'')}</td><td>${payFa(x.paymentMethod)}</td><td>${safe(x.manualSettlementDays??'محاسباتی')}</td><td>${safe(x.checkDueDays??'-')}</td><td>${safe(x.goodsDelayDays??0)}</td><td>${x.isActive!==false?'فعال':'غیرفعال'}</td><td><button class="mini" data-edit-sup="${safe(x.accountId)}">ویرایش</button> <button class="mini" data-toggle-sup="${safe(x.accountId)}">${x.isActive!==false?'غیرفعال':'فعال'}</button> <button class="mini" data-del-sup="${safe(x.accountId)}">حذف</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">هنوز تأمین‌کننده‌ای انتخاب نشده است. گزارش کل موجودی فعال همچنان بدون انتخاب تأمین‌کننده قابل محاسبه است.</div>';
    box.querySelectorAll('[data-edit-sup]').forEach(btn=>btn.onclick=async()=>{const cur=list.find(x=>Number(x.accountId)===Number(btn.dataset.editSup)); if(cur) await editSupplierTermsV197(cur);});
    box.querySelectorAll('[data-toggle-sup]').forEach(btn=>btn.onclick=async()=>{const cur=list.find(x=>Number(x.accountId)===Number(btn.dataset.toggleSup)); await post('/api/supplier-aging/selected',{...cur,isActive:cur.isActive===false}); await renderSelectedSuppliersV197();});
    box.querySelectorAll('[data-del-sup]').forEach(btn=>btn.onclick=async()=>{if(!confirm('حذف شود؟'))return; await api(`/api/supplier-aging/selected?accountId=${encodeURIComponent(btn.dataset.delSup)}`,{method:'DELETE'}); await renderSelectedSuppliersV197();});
    wrapTables(box);
  }
  async function editSupplierTermsV197(cur){
    const group=prompt('گروه تأمین‌کننده؟', cur.group || ''); if(group===null)return;
    const method=prompt('نوع تسویه: cash / check / mixed / manual', cur.paymentMethod || 'mixed'); if(method===null)return;
    const basisDefault=cur.settlementBasis || (method==='check'?'purchase_commitment':'inventory_date');
    const basis=prompt('مبنای راس: inventory_date یا purchase_commitment', basisDefault); if(basis===null)return;
    const manual=prompt('راس تسویه دستی. خالی = محاسباتی', cur.manualSettlementDays ?? ''); if(manual===null)return;
    const checkDue=prompt('راس چک از روز تعهد خرید. خالی = ندارد', cur.checkDueDays ?? ''); if(checkDue===null)return;
    const delay=prompt('میانگین تأخیر ورود کالا به انبار بعد از خرید', cur.goodsDelayDays ?? 0); if(delay===null)return;
    await post('/api/supplier-aging/selected',{...cur,group:group||'',paymentMethod:method||'mixed',settlementBasis:basis||basisDefault,manualSettlementDays:manual===''?null:Number(manual),checkDueDays:checkDue===''?null:Number(checkDue),goodsDelayDays:delay===''?0:Number(delay),isActive:true});
    await renderSelectedSuppliersV197();
  }
  async function searchSupplierCandidatesV197(){
    const q=qs('#supSearchQ')?.value||''; const box=qs('#supCandidates'); if(!box)return;
    box.innerHTML='<div class="info">در حال جستجوی حساب‌های دارای خرید...</div>';
    try{
      const r=await api(`/api/supplier-aging/candidates?q=${encodeURIComponent(q)}&limit=100`); const arr=r.list||[];
      box.innerHTML=arr.length?`<table class="table"><thead><tr><th>نام</th><th>کد</th><th>تعداد فاکتور خرید</th><th>خرید دوره</th><th>وضعیت</th><th>افزودن</th></tr></thead><tbody>${arr.map((x,i)=>`<tr><td>${safe(x.accountName)}</td><td>${safe(x.accountNumber||x.accountId)}</td><td>${money(x.purchaseInvoiceCount)}</td><td>${money(x.purchaseRial)}</td><td>${x.selected?'انتخاب‌شده':'-'}</td><td><button class="mini" data-add-cand="${i}">افزودن/ویرایش</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حساب دارای خرید منطبق پیدا نشد.</div>';
      box.querySelectorAll('[data-add-cand]').forEach(btn=>btn.onclick=async()=>{const x=arr[Number(btn.dataset.addCand)]; const cur=x.selectedDoc||{accountId:x.accountId,accountNumber:x.accountNumber,accountName:x.accountName,group:'',paymentMethod:'mixed',manualSettlementDays:null,goodsDelayDays:0,checkDueDays:null,settlementBasis:'inventory_date',isActive:true}; await editSupplierTermsV197(cur); await searchSupplierCandidatesV197();});
    }catch(e){box.innerHTML=`<div class="error">خطا در جستجوی تأمین‌کننده: ${safe(e.message||e)}</div>`;}
    wrapTables(box);
  }
  function supplierReportQuery(){
    const v=qs('#supOriginFilter')?.value||'';
    if(v==='') return '';
    return `?originAccountId=${encodeURIComponent(v)}`;
  }
  async function loadSupplierAgingReportV197(){
    const box=qs('#supReport'); if(!box)return;
    box.innerHTML='<div class="info">در حال محاسبه کل موجودی انبارهای فعال و منشا مانده کالا...</div>';
    try{
      const r=await api('/api/supplier-aging/report'+supplierReportQuery());
      const origin=r.originSummary||{}, origins=origin.origins||[], layers=r.itemLayers||[], suppliers=r.suppliers||[], ls=r.layerSummary||{};
      let h='<h4>خلاصه کل موجودی انبارهای فعال بر اساس منشا مانده کالا</h4>';
      h+=`<div class="origin-kpis"><div class="origin-kpi"><span>کل موجودی فعال</span><b>${money(origin.totalInventoryValue||0)}</b><small>ریال</small></div><div class="origin-kpi"><span>تعداد کالا</span><b>${money(origin.totalItemCount||0)}</b></div><div class="origin-kpi"><span>تعداد کل</span><b>${money(origin.totalInventoryQty||0)}</b></div><div class="origin-kpi"><span>انبارها</span><b>${safe((origin.activeWarehouseNumbers||[]).join('، ')||'همه')}</b></div></div>`;
      h+=origins.length?`<table class="table"><thead><tr><th>منشا مانده کالا</th><th>ارزش مانده</th><th>سهم از کل</th><th>تعداد کالا</th><th>تعداد لایه</th><th>میانگین سن</th><th>انتخاب</th></tr></thead><tbody>${origins.map(x=>`<tr class="origin-summary-row" data-origin-id="${safe(x.accountId??0)}"><td>${safe(x.accountName||x.supplierName||'نامشخص')}</td><td>${money(x.inventoryValue)}</td><td>${x.sharePct==null?'':safe(x.sharePct+'٪')}</td><td>${money(x.itemCount)}</td><td>${money(x.layerCount)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td><button class="mini" data-origin-id="${safe(x.accountId??0)}">نمایش جزئیات</button></td></tr>`).join('')}</tbody></table>`:'<div class="warn">منشا موجودی محاسبه نشد.</div>';
      if(suppliers.length){
        h+='<h4 class="mt">خلاصه تکمیلی تأمین‌کننده انتخاب‌شده</h4>';
        h+=`<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره</th><th>تعداد فاکتور خرید</th><th>پرداخت واقعی</th><th>مانده حساب</th><th>موجودی مانده</th><th>میانگین سن</th><th>نوع تسویه</th><th>فشار مالی</th><th>ریسک</th></tr></thead><tbody>${suppliers.map(x=>`<tr><td>${safe(x.accountName)}</td><td>${money(x.totalPurchaseRial)}</td><td>${money(x.purchaseInvoiceCount)}</td><td>${money(x.totalPaidRial)}</td><td>${money(x.payableBalance)}</td><td>${money(x.inventoryValue)}</td><td>${money(x.averageInventoryAgeDays)}</td><td>${payFa(x.paymentMethod)}</td><td>${x.overdueDays==null?'نامشخص':money(x.overdueDays)}</td><td><div class="${riskClass(x.risk)}">${riskFa(x.risk)}</div></td></tr>`).join('')}</tbody></table>`;
      }
      h+='<h4 class="mt">لایه‌های کالایی منشا انتخاب‌شده</h4>';
      h+=`<div class="info">فیلتر فعلی: ${safe(qs('#supOriginFilter')?.selectedOptions?.[0]?.textContent||'همه منشاها')} | تعداد لایه: ${money(ls.layerCount||layers.length)} | ارزش مانده: ${money(ls.totalRemainingValue||0)} | میانگین خواب: ${money(ls.averagePhysicalAgeDays||0)}</div>`;
      h+=layers.length?`<table class="table"><thead><tr><th>منشا</th><th>کالا</th><th>تعداد مانده</th><th>ارزش مانده</th><th>فاکتور خرید</th><th>تاریخ ورود/خرید</th><th>سن فیزیکی</th><th>سررسید مالی تقریبی</th><th>فشار مالی</th><th>ریسک</th><th>اطمینان</th></tr></thead><tbody>${layers.slice(0,500).map(x=>`<tr><td>${safe(x.supplierName)}</td><td>${safe(x.itemCode)}<br>${safe(x.itemDescription)}</td><td>${money(x.remainingQty)}</td><td>${money(x.remainingValue)}</td><td>${safe(x.purchaseInvoiceNo)}</td><td>${safe(normalizeDateDisplay(x.purchaseDate))}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td><td>${x.financialDueDate?safe(normalizeDateDisplay(x.financialDueDate)):'نامشخص'}</td><td>${x.overdueDays==null?'نامشخص':money(x.overdueDays)}</td><td><div class="${riskClass(x.risk)}">${riskFa(x.risk)}</div></td><td>${safe(x.confidence)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">برای این فیلتر لایه کالایی پیدا نشد.</div>';
      h+=`<div class="small muted">منبع: ${safe(r.meta?.source||'')} | ${safe(r.meta?.note||'')}</div>`;
      box.innerHTML=h;
      box.querySelectorAll('[data-origin-id]').forEach(el=>el.onclick=(ev)=>{ev.stopPropagation(); const id=String(el.dataset.originId||'0'); const sel=qs('#supOriginFilter'); if(sel){ if(![...sel.options].some(o=>String(o.value)===id)){sel.add(new Option(id==='0'?'نامشخص / مانده از قبل':'تأمین‌کننده '+id,id));} sel.value=id; } loadSupplierAgingReportV197();});
    }catch(e){box.innerHTML=`<div class="error">خطا در گزارش خواب کالا: ${safe(e.message||e)}</div>`;}
    wrapTables(box);
  }
  async function populateOriginFilterFromReport(){
    const sel=qs('#supOriginFilter'); if(!sel)return;
    sel.innerHTML='<option value="">همه منشاها</option><option value="0">نامشخص / مانده از قبل</option>';
  }
  window.pageSupplierAging=pageSupplierAging=async function(){
    setPage('خواب کالا - تأمین‌کننده',`<main class="main-content"><div class="card"><div class="card-header"><h5>گزارش کل موجودی انبارهای فعال، تفکیک بر اساس منشا مانده کالا</h5></div><div class="card-body"><div class="info">این بخش از کل موجودی انبارهای فعال شروع می‌کند، سپس با FIFO معکوس مبتنی بر WebService / cache منشا مانده را به تأمین‌کننده یا نامشخص/مانده از قبل وصل می‌کند.</div><div class="row two"><div class="form-group"><label>فیلتر منشا</label><select id="supOriginFilter"><option value="">همه منشاها</option><option value="0">نامشخص / مانده از قبل</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn red" id="supReportBtn">محاسبه گزارش کل موجودی فعال</button></div></div><div id="supReport" class="mt"><div class="muted">برای دیدن خلاصه کل موجودی فعال، دکمه محاسبه را بزن.</div></div></div></div><div class="card"><div class="card-header"><h5>تأمین‌کننده‌های منتخب و تنظیمات مالی</h5></div><div class="card-body"><div class="actions"><button class="btn green" id="supSeed">به‌روزرسانی/افزودن تأمین‌کننده‌های پیش‌فرض</button></div><div id="supSelected" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>جستجو و افزودن تأمین‌کننده به جدول بالا</h5></div><div class="card-body"><div class="row two"><div class="form-group"><label>نام یا کد تأمین‌کننده</label><input id="supSearchQ" placeholder="مثلاً ماندگار، ماتریس، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="supSearchBtn">جستجوی حساب‌های دارای خرید</button></div></div><div id="supCandidates" class="mt"></div></div></div></main>`);
    qs('#supSeed').onclick=async()=>{await post('/api/supplier-aging/seed',{});await renderSelectedSuppliersV197();};
    qs('#supSearchBtn').onclick=searchSupplierCandidatesV197;
    qs('#supSearchQ').addEventListener('keydown',e=>{if(e.key==='Enter')searchSupplierCandidatesV197();});
    qs('#supReportBtn').onclick=loadSupplierAgingReportV197;
    qs('#supOriginFilter').onchange=loadSupplierAgingReportV197;
    await populateOriginFilterFromReport();
    await renderSelectedSuppliersV197();
  };

  window.pageRoles=pageRoles=function(){
    setPage('نقش‌ها',`<main class="main-content"><div class="card"><div class="card-header"><h5>نقش‌ها و دسترسی‌ها</h5></div><div class="card-body"><div class="info">تعریف نقش‌ها در این نسخه نمایشی است؛ اعمال دسترسی‌ها از ROLE_PERMISSIONS سرور و ROLE_PAGES رابط کاربری انجام می‌شود.</div><table class="table"><thead><tr><th>کد نقش</th><th>عنوان</th></tr></thead><tbody>${Object.entries(ROLE_LABELS||{}).map(([k,v])=>`<tr><td>${safe(k)}</td><td>${safe(v)}</td></tr>`).join('')}</tbody></table></div></div></main>`); wrapTables(document); };

  const prevPageSettings=window.pageSettings||pageSettings;
  if(typeof prevPageSettings==='function'){
    window.pageSettings=pageSettings=async function(){const r=await prevPageSettings.apply(this,arguments); setTimeout(()=>{const btn=qs('#loadActiveWarehouses'); const box=qs('#activeWarehouseList'); if(btn&&box&&!box.innerHTML.trim()) btn.click();},300); return r;};
  }

  const prevRoute=window.route||route;
  window.route=route=async function(){const p=location.hash.slice(1)||firstAllowedPage(); if(p==='supplier-aging') return pageSupplierAging(); if(p==='roles') return pageRoles(); const r=await prevRoute.apply(this,arguments); setTimeout(()=>wrapTables(document),250); return r;};
})();

/* PATCH 0.9.19.9: Seller profit fixes + persistent supplier aging last report */
(function(){
  window.MKCRM_VERSION='0.9.19.9-seller-profit-jalali-last-aging-report';
  const $ = (s)=>document.querySelector(s);
  const $$ = (s)=>Array.from(document.querySelectorAll(s));
  const safe = (v)=>{ try { return esc(v==null?'':String(v)); } catch { return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); } };
  const fmt = (v)=>Number(v||0).toLocaleString('fa-IR');
  const toEn = (v)=>String(v||'').replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  window.wrapTables = window.wrapTables || function(root=document){
    Array.from((root||document).querySelectorAll('table.table')).forEach(t=>{
      if(t.closest('.table-scroll')) return;
      const w=document.createElement('div'); w.className='table-scroll';
      t.parentNode.insertBefore(w,t); w.appendChild(t);
    });
  };
  function normJalaliInput(v){ return toEn(v).replace(/[^0-9]/g,'').slice(0,8); }
  function moneyTomanToRial(v){ const x=toEn(v).replace(/[^0-9.-]/g,''); return x===''?'':String(Number(x)*10); }
  function payFa(x){ return ({cash:'نقدی',check:'چکی',mixed:'ترکیبی',manual:'دستی/نامشخص'}[String(x||'mixed')]||x||'ترکیبی'); }
  function riskFa(r){ return ({high:'بالا',medium:'متوسط',low:'پایین'}[String(r||'')]||r||''); }
  function riskClass(r){ return r==='high'?'error':r==='medium'?'warn':'success'; }
  function normDate(v){ try { return (window.normalizeDateDisplay||toJalaliDisplay)(v||''); } catch { return String(v||''); } }

  window.pageSellerProfit = pageSellerProfit = async function(){
    const today=(typeof todayJalali8==='function'?todayJalali8():'14050101');
    const from=today.slice(0,6)+'01', to=today;
    setPage('عملکرد فروشنده', `<main class="main-content"><div class="card"><div class="card-header"><h5>عملکرد فروشنده و سود FIFO</h5></div><div class="card-body"><div class="info">فروش از وب‌سرویس فاکتورهای فروش شایگان خوانده می‌شود؛ فروشنده از نماینده/جاری کارکنان فاکتور استخراج می‌شود، نه صندوق و نه فقط کاربران CRM. فیلتر سود با عدد تومان وارد می‌شود و روی سود هر فاکتور اعمال می‌گردد.</div><div class="row four"><input id="spFrom" placeholder="از تاریخ شمسی مثل 14050301" value="${from}"><input id="spTo" placeholder="تا تاریخ شمسی مثل 14050331" value="${to}"><select id="spSeller"><option value="">همه فروشنده‌ها</option></select><button class="btn primary" id="spLoad">محاسبه</button></div><div class="row four"><input id="spStore" placeholder="فروشگاه اختیاری"><input id="spMinProfit" placeholder="سود بالای X تومان؛ مثل 10000000"><input id="spMaxProfit" placeholder="سود زیر Y تومان؛ مثل 2000000"><input id="spCommissionRate" value="0.18" placeholder="نرخ پورسانت؛ مثال 0.18"></div><div class="row three"><select id="spItemGroup"><option value="">همه گروه‌ها</option><option value="notebook">فقط نوت‌بوک؛ کد کالا با ۱</option></select><button class="btn" id="spClearFilters">پاک کردن فیلتر سود</button><input id="spLeadPenalty" placeholder="جریمه هر فاکتور بدون Lead - ریال؛ فعلاً اختیاری"></div><div id="spOut" class="mt"><div class="muted">بازه تاریخ و فروشنده یا همه را انتخاب کن، سپس محاسبه را بزن.</div></div></div></div></main>`);
    const out=$('#spOut'), sel=$('#spSeller');
    try{
      const sellers=await api('/api/reports/seller-sales-profit/sellers');
      const list=sellers.list||[];
      sel.innerHTML='<option value="">همه فروشنده‌ها</option>'+list.map(x=>`<option value="${safe(x.employeeAccountNumber||x.sellerKey||'')}" data-store="${safe(x.storeName||'')}" data-emp="${safe(x.employeeAccountNumber||'')}">${safe((x.employeeAccountNumber?('نماینده '+x.employeeAccountNumber+' - '):'')+(x.fullName||x.username||x.sellerKey||''))}${x.storeName?' - '+safe(x.storeName):''}${x.employeeAccountNumber?'':' - جاری کارکنان ندارد'}</option>`).join('');
      sel.onchange=()=>{const o=sel.options[sel.selectedIndex]; if(o&&o.dataset.store&&!$('#spStore').value) $('#spStore').value=o.dataset.store;};
    }catch(e){sel.innerHTML='<option value="">خطا در دریافت فروشندگان</option>'; out.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}
    $('#spClearFilters').onclick=()=>{$('#spMinProfit').value='';$('#spMaxProfit').value='';};
    $('#spLoad').onclick=async()=>{
      const dateFrom=normJalaliInput($('#spFrom').value), dateTo=normJalaliInput($('#spTo').value), seller=sel.value||'', store=$('#spStore').value||'';
      const minProfit=moneyTomanToRial($('#spMinProfit').value.trim()), maxProfit=moneyTomanToRial($('#spMaxProfit').value.trim()), commissionRate=$('#spCommissionRate').value.trim()||'0.18', leadPenaltyRial=toEn($('#spLeadPenalty').value.trim()).replace(/[^0-9.-]/g,''), itemGroup=$('#spItemGroup')?.value||'';
      out.innerHTML='<div class="info">در حال خواندن فاکتورها و محاسبه سود FIFO...</div>';
      try{
        const qs = new URLSearchParams({ dateFrom, dateTo, seller, store, minProfit, maxProfit, itemGroup, profitUnit:'rial', commissionRate, leadPenaltyRial });
        const r=await api(`/api/reports/seller-sales-profit?${qs.toString()}`);
        if(!r.ok){out.innerHTML=`<div class="error">${safe(r.error||'خطا')}</div>`;return;}
        const sm=r.summary||{};
        let html=`<div class="info">فیلتر گروه کالا: ${r.meta?.itemGroup==='notebook'?'فقط نوت‌بوک؛ کد کالا با ۱':'همه کالاها'}</div><div class="kpis"><div class="kpi"><b>${fmt(sm.invoiceCount)}</b><span>تعداد فاکتور</span></div><div class="kpi"><b>${fmt(sm.saleRial)}</b><span>جمع فروش</span></div><div class="kpi"><b>${fmt(sm.fifoProfit)}</b><span>سود FIFO</span></div><div class="kpi"><b>${sm.avgProfitPct==null?'-':fmt(sm.avgProfitPct)+'%'}</b><span>درصد سود</span></div><div class="kpi"><b>${fmt(sm.rawCommission)}</b><span>پورسانت خام</span></div><div class="kpi warn"><b>${fmt(sm.unmatchedSaleRial)}</b><span>فروش با قیمت تمام‌شده نامشخص</span></div></div>`;
        html+=`<h5>جدول خلاصه فروشندگان</h5><table class="table"><thead><tr><th>نام</th><th>جاری کارکنان</th><th>فروشگاه</th><th>تعداد فاکتور</th><th>جمع فروش</th><th>سود</th><th>درصد سود</th><th>نامشخص</th><th>Lead ندارد</th><th>وضعیت</th></tr></thead><tbody>${(r.sellers||[]).map(x=>`<tr><td>${safe(x.sellerName||x.sellerKey)}</td><td>${safe(x.employeeAccountNumber||'ندارد')}</td><td>${safe(x.sellerStore||'')}</td><td>${fmt(x.invoiceCount)}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${x.avgProfitPct==null?'-':fmt(x.avgProfitPct)+'%'}</td><td>${fmt(x.unmatchedSaleRial)}</td><td>${fmt(x.withoutLeadCount||0)}</td><td>${x.employeeStatus==='missing'?'<span class="error">جاری کارکنان ندارد</span>':(x.leadStatus==='ok'?'<span class="success">اوکی</span>':'<span class="warn">Lead ناقص</span>')}</td></tr>`).join('')}</tbody></table>`;
        html+=`<h5>ریز فاکتورها با فیلتر سود</h5><table class="table"><thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>فروشنده</th><th>مشتری</th><th>فروش</th><th>سود</th><th>درصد سود</th><th>Lead</th><th>نامشخص</th></tr></thead><tbody>${(r.invoices||[]).slice(0,1000).map(x=>`<tr><td>${safe(x.invoiceNo)}</td><td>${safe(normDate(x.invoiceDate))}</td><td>${safe(x.sellerName||x.sellerKey)}</td><td>${safe(x.customerName||'')}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${x.profitPct==null?'-':fmt(x.profitPct)+'%'}</td><td>${safe(x.leadId||'')}</td><td>${fmt(x.unmatchedSaleRial)}</td></tr>`).join('')}</tbody></table>`;
        html+=`<h5>جدول پورسانت پیشنهادی</h5><table class="table"><thead><tr><th>نام فروشنده</th><th>جمع فروش</th><th>سود محاسبه‌شده</th><th>نرخ</th><th>پورسانت خام</th><th>کسر Lead</th><th>پورسانت نهایی پیشنهادی</th><th>وضعیت Lead</th></tr></thead><tbody>${(r.sellers||[]).map(x=>`<tr><td>${safe(x.sellerName||x.sellerKey)}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${safe(String(x.commissionRate??''))}</td><td>${fmt(x.rawCommission)}</td><td>${fmt(x.leadPenalty)}</td><td>${fmt(x.suggestedCommission)}</td><td>${x.leadStatus==='ok'?'اوکی':'نیازمند بررسی'}</td></tr>`).join('')}</tbody></table>`;
        if((r.unmatched||[]).length) html+=`<div class="warn">${fmt((r.unmatched||[]).length)} ردیف با قیمت تمام‌شده نامشخص وجود دارد؛ قبل از پرداخت قطعی پورسانت بررسی شود.</div>`;
        out.innerHTML=html; window.wrapTables(out);
      }catch(e){out.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}
    };
  };

  async function renderAgingReportPayload(r, box, generatedAt=''){
    const origin=r.originSummary||{}, origins=origin.origins||[], layers=r.itemLayers||[], suppliers=r.suppliers||[], ls=r.layerSummary||{};
    let h=`${generatedAt?`<div class="success">آخرین گزارش ذخیره‌شده: ${safe(normDate(generatedAt))}</div>`:''}<h4>خلاصه کل موجودی انبارهای فعال بر اساس منشا مانده کالا</h4>`;
    h+=`<div class="origin-kpis"><div class="origin-kpi"><span>کل موجودی فعال</span><b>${fmt(origin.totalInventoryValue||0)}</b><small>ریال</small></div><div class="origin-kpi"><span>تعداد کالا</span><b>${fmt(origin.totalItemCount||0)}</b></div><div class="origin-kpi"><span>تعداد کل</span><b>${fmt(origin.totalInventoryQty||0)}</b></div><div class="origin-kpi"><span>انبارها</span><b>${safe((origin.activeWarehouseNumbers||[]).join('، ')||'همه')}</b></div></div>`;
    h+=origins.length?`<table class="table"><thead><tr><th>منشا مانده کالا</th><th>ارزش مانده</th><th>سهم از کل</th><th>مبلغ سود FIFO</th><th>درصد سود FIFO</th><th>تعداد کالا</th><th>تعداد لایه</th><th>میانگین سن</th><th>انتخاب</th></tr></thead><tbody>${origins.map(x=>`<tr class="origin-summary-row" data-origin-id="${safe(x.accountId??0)}"><td>${safe(x.accountName||x.supplierName||'نامشخص / مانده از قبل')}</td><td>${fmt(x.inventoryValue)}</td><td>${x.sharePct==null?'':safe(x.sharePct+'٪')}</td><td>${fmt(x.estimatedProfit||x.fifoProfit||0)}</td><td>${(x.estimatedProfitPct??x.fifoProfitPct)==null?'نامشخص':safe((x.estimatedProfitPct??x.fifoProfitPct)+'٪')}</td><td>${fmt(x.itemCount)}</td><td>${fmt(x.layerCount)}</td><td>${x.averageAgeDays==null?'نامشخص':fmt(x.averageAgeDays)}</td><td><button class="mini" data-origin-id="${safe(x.accountId??0)}">نمایش جزئیات</button></td></tr>`).join('')}</tbody></table>`:'<div class="warn">منشا موجودی محاسبه نشد.</div>';
    if(suppliers.length) h+=`<h4 class="mt">خلاصه تکمیلی تأمین‌کننده انتخاب‌شده</h4><table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره</th><th>تعداد فاکتور خرید</th><th>پرداخت واقعی</th><th>مانده حساب</th><th>موجودی مانده</th><th>مبلغ سود FIFO</th><th>درصد سود FIFO</th><th>میانگین سن</th><th>نوع تسویه</th><th>فشار مالی</th><th>ریسک</th></tr></thead><tbody>${suppliers.map(x=>`<tr><td>${safe(x.accountName)}</td><td>${fmt(x.totalPurchaseRial)}</td><td>${fmt(x.purchaseInvoiceCount)}</td><td>${fmt(x.totalPaidRial)}</td><td>${fmt(x.payableBalance)}</td><td>${fmt(x.inventoryValue)}</td><td>${fmt(x.estimatedProfit||0)}</td><td>${x.estimatedProfitPct==null?'نامشخص':safe(x.estimatedProfitPct+'٪')}</td><td>${fmt(x.averageInventoryAgeDays)}</td><td>${payFa(x.paymentMethod)}</td><td>${x.overdueDays==null?'نامشخص':fmt(x.overdueDays)}</td><td><div class="${riskClass(x.risk)}">${riskFa(x.risk)}</div></td></tr>`).join('')}</tbody></table>`;
    h+=`<h4 class="mt">لایه‌های کالایی منشا انتخاب‌شده</h4><div class="info">تعداد لایه: ${fmt(ls.layerCount||layers.length)} | ارزش مانده: ${fmt(ls.totalRemainingValue||0)} | میانگین خواب: ${fmt(ls.averagePhysicalAgeDays||0)}</div>`;
    h+=layers.length?`<table class="table"><thead><tr><th>منشا</th><th>کالا</th><th>تعداد مانده</th><th>ارزش مانده</th><th>فاکتور خرید</th><th>تاریخ ورود/خرید</th><th>سن فیزیکی</th><th>سررسید مالی تقریبی</th><th>فشار مالی</th><th>ریسک</th><th>اطمینان</th></tr></thead><tbody>${layers.slice(0,500).map(x=>`<tr><td>${safe(x.supplierName)}</td><td>${safe(x.itemCode)}<br>${safe(x.itemDescription)}</td><td>${fmt(x.remainingQty)}</td><td>${fmt(x.remainingValue)}</td><td>${safe(x.purchaseInvoiceNo)}</td><td>${safe(normDate(x.purchaseDate))}</td><td>${x.ageDays==null?'نامشخص':fmt(x.ageDays)}</td><td>${x.financialDueDate?safe(normDate(x.financialDueDate)):'نامشخص'}</td><td>${x.overdueDays==null?'نامشخص':fmt(x.overdueDays)}</td><td><div class="${riskClass(x.risk)}">${riskFa(x.risk)}</div></td><td>${safe(x.confidence)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">برای این فیلتر لایه کالایی پیدا نشد.</div>';
    h+=`<div class="small muted">منبع: ${safe(r.meta?.source||'')} | ${safe(r.meta?.note||'')}</div>`;
    box.innerHTML=h;
    box.querySelectorAll('[data-origin-id]').forEach(el=>el.onclick=(ev)=>{ ev.stopPropagation(); const id=String(el.dataset.originId||'0'); const sel=$('#supOriginFilter'); if(sel){ if(![...sel.options].some(o=>String(o.value)===id)){sel.add(new Option(id==='0'?'نامشخص / مانده از قبل':'تأمین‌کننده '+id,id));} sel.value=id; } loadSupplierAgingReportPersisted(); });
    window.wrapTables(box);
  }
  async function loadSupplierAgingReportPersisted(){ const box=$('#supReport'); if(!box)return; box.innerHTML='<div class="info">در حال محاسبه و ذخیره گزارش...</div>'; try{ const v=$('#supOriginFilter')?.value||''; const r=await api('/api/supplier-aging/report'+(v===''?'':`?originAccountId=${encodeURIComponent(v)}`)); await renderAgingReportPayload(r, box, r.generatedAt || new Date().toISOString()); }catch(e){ box.innerHTML=`<div class="error">خطا در گزارش خواب کالا: ${safe(e.message||e)}</div>`; } }
  async function loadLastSupplierAgingReport(){ const box=$('#supReport'); if(!box)return; try{ const r=await api('/api/supplier-aging/last-report'); if(r.found && r.report){ await renderAgingReportPayload(r.report, box, r.generatedAt); } else { box.innerHTML='<div class="muted">هنوز گزارش ذخیره‌شده‌ای وجود ندارد. برای ساخت گزارش، دکمه محاسبه/به‌روزرسانی را بزن.</div>'; } }catch(e){ box.innerHTML=`<div class="warn">آخرین گزارش خوانده نشد: ${safe(e.message||e)}</div>`; } }
  const prevSupplierPage = window.pageSupplierAging;
  window.pageSupplierAging = pageSupplierAging = async function(){
    if(typeof prevSupplierPage === 'function') await prevSupplierPage();
    const btn=$('#supReportBtn'); if(btn) btn.textContent='محاسبه/به‌روزرسانی گزارش کل موجودی فعال';
    if(btn) btn.onclick=loadSupplierAgingReportPersisted;
    const sel=$('#supOriginFilter'); if(sel) sel.onchange=()=>loadSupplierAgingReportPersisted();
    await loadLastSupplierAgingReport();
  };
  const prevRoute=window.route||route;
  window.route=route=async function(){ const p=location.hash.slice(1)||firstAllowedPage(); if(p==='seller-profit') return pageSellerProfit(); if(p==='supplier-aging') return pageSupplierAging(); const r=await prevRoute.apply(this,arguments); setTimeout(()=>window.wrapTables(document),250); return r; };
})();

/* PATCH 0.9.19.13 FINAL: seller performance filters from cached report only */
(function(){
  window.MKCRM_VERSION='0.9.19.14-final-seller-jalali-date-shaygan';
  const hesc = (v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const toEnNum = (v)=>String(v??'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const moneyClean = (v)=>toEnNum(v).replace(/[^0-9.-]/g,'');
  const moneyTomanToRial = (v)=>{ const n=Number(moneyClean(v)); return Number.isFinite(n) && n!==0 ? n*10 : null; };
  const dfltMonthRange = ()=>{
    // UI date input is Jalali. Server normalizes 13/14xx Jalali dates to Shaygan-compatible YYYYMMDD Gregorian before WebService calls.
    try {
      const t = (typeof todayJalali8 === 'function' ? todayJalali8() : '');
      if (/^\d{8}$/.test(String(t))) return { from: t.slice(0,6)+'01', to: t };
    } catch {}
    return { from: '14050101', to: '14050131' };
  };
  let sellerPerfBaseReport = null;
  function spBaseQuery(force=false){
    const qs = new URLSearchParams();
    const set=(k,v)=>{ if(v!==undefined && v!==null && String(v).trim()!=='') qs.set(k,String(v).trim()); };
    set('dateFrom',$('#spFrom')?.value||''); set('dateTo',$('#spTo')?.value||''); set('seller',$('#spSeller')?.value||''); set('store',$('#spStore')?.value||'');
    set('commissionRate',$('#spCommissionRate')?.value||'0.18'); set('leadPenaltyRial',moneyClean($('#spLeadPenalty')?.value||''));
    // فیلترهای سود و نوت‌بوک عمداً به API ارسال نمی‌شوند؛ فقط روی گزارش کش‌شده اعمال می‌شوند.
    if(force) qs.set('force','1');
    return qs;
  }
  function invLink(no){ const n=hesc(no||''); return n?`<a href="#" class="sp-invoice-link" data-inv="${n}">${n}</a>`:'-'; }
  function bindInvoiceLinks(root){ (root||document).querySelectorAll('.sp-invoice-link').forEach(a=>a.onclick=async(e)=>{ e.preventDefault(); const no=a.dataset.inv; if(window.openInvoiceView) return window.openInvoiceView(no,2); window.open(`/print/invoice/${encodeURIComponent(no)}?invType=2`,'_blank'); }); }
  function cloneReport(r){ return JSON.parse(JSON.stringify(r||{})); }
  function invoiceHasNotebook(inv){
    const codes = Array.isArray(inv.itemCodes) ? inv.itemCodes : [];
    if (codes.some(c=>String(c||'').trim().startsWith('1'))) return true;
    const lines = Array.isArray(inv.lines) ? inv.lines : [];
    return lines.some(l=>String(l.itemCode||l.ItemCode||'').trim().startsWith('1'));
  }
  function notebookPartialInvoice(inv){
    const lines = Array.isArray(inv.lines) ? inv.lines.filter(l=>String(l.itemCode||l.ItemCode||'').trim().startsWith('1')) : [];
    if (!lines.length) return null;
    const saleRial = lines.reduce((a,l)=>a+Number(l.saleRial||0),0);
    const fifoCost = lines.reduce((a,l)=>a+Number(l.fifoCost||0),0);
    const fifoProfit = lines.reduce((a,l)=>a+Number(l.fifoProfit||0),0);
    const unmatchedSaleRial = lines.reduce((a,l)=>a+Number(l.unmatchedSaleRial||0),0);
    return { ...inv, lines, itemCodes:[...new Set(lines.map(l=>String(l.itemCode||l.ItemCode||'').trim()).filter(Boolean))], hasNotebook:true, saleRial:Math.round(saleRial), fifoCost:Math.round(fifoCost), fifoProfit:Math.round(fifoProfit), unmatchedSaleRial:Math.round(unmatchedSaleRial), profitPct:saleRial?Math.round((fifoProfit/saleRial)*10000)/100:null };
  }
  function rebuildSellerPerfFromInvoices(base, invoices){
    const commissionRate = Number(base?.meta?.commissionRate ?? $('#spCommissionRate')?.value ?? 0.18) || 0.18;
    const leadPenaltyRial = Number(base?.meta?.leadPenaltyRial || moneyClean($('#spLeadPenalty')?.value||'') || 0) || 0;
    const by = new Map();
    for(const inv of invoices){
      const k=inv.sellerKey||'unknown';
      if(!by.has(k)) by.set(k,{sellerKey:k,sellerName:inv.sellerName||k,sellerStore:inv.sellerStore||'',employeeAccountNumber:inv.employeeAccountNumber||(!String(k).startsWith('NO_EMPLOYEE:')?k:''),invoiceCount:0,saleRial:0,fifoCost:0,fifoProfit:0,unmatchedSaleRial:0,withLeadCount:0,withoutLeadCount:0});
      const s=by.get(k); s.invoiceCount++; s.saleRial+=Number(inv.saleRial||0); s.fifoCost+=Number(inv.fifoCost||0); s.fifoProfit+=Number(inv.fifoProfit||0); s.unmatchedSaleRial+=Number(inv.unmatchedSaleRial||0); if(inv.leadId) s.withLeadCount++; else s.withoutLeadCount++;
    }
    const sellers=[...by.values()].map(s=>{ const raw=Math.round(Number(s.fifoProfit||0)*commissionRate); const lp=Math.round(Number(s.withoutLeadCount||0)*leadPenaltyRial); return {...s,saleRial:Math.round(s.saleRial),fifoCost:Math.round(s.fifoCost),fifoProfit:Math.round(s.fifoProfit),unmatchedSaleRial:Math.round(s.unmatchedSaleRial),avgProfitPct:s.saleRial?Math.round((s.fifoProfit/s.saleRial)*10000)/100:null,commissionRate,rawCommission:raw,leadPenalty:lp,finalCommission:Math.max(0,raw-lp),suggestedCommission:Math.max(0,raw-lp),leadStatus:s.withoutLeadCount?'needs-review':'ok',employeeStatus:s.employeeAccountNumber?'ok':'missing'}; }).sort((a,b)=>b.fifoProfit-a.fifoProfit);
    const summary=sellers.reduce((a,s)=>{ a.invoiceCount+=s.invoiceCount; a.saleRial+=s.saleRial; a.fifoCost+=s.fifoCost; a.fifoProfit+=s.fifoProfit; a.unmatchedSaleRial+=s.unmatchedSaleRial; a.rawCommission+=s.rawCommission||0; a.leadPenalty+=s.leadPenalty||0; a.suggestedCommission+=s.suggestedCommission||0; a.withoutLeadCount+=s.withoutLeadCount||0; a.missingEmployeeCount+=s.employeeStatus==='missing'?1:0; return a; },{invoiceCount:0,saleRial:0,fifoCost:0,fifoProfit:0,unmatchedSaleRial:0,rawCommission:0,leadPenalty:0,suggestedCommission:0,withoutLeadCount:0,missingEmployeeCount:0});
    summary.avgProfitPct=summary.saleRial?Math.round((summary.fifoProfit/summary.saleRial)*10000)/100:null;
    return {summary,sellers};
  }
  function applySellerPerfClientFilters(base){
    const r=cloneReport(base); if(!r || !r.ok) return r;
    const group=$('#spItemGroup')?.value||'';
    const min=moneyTomanToRial($('#spMinProfit')?.value||'');
    const max=moneyTomanToRial($('#spMaxProfit')?.value||'');
    let invoices=Array.isArray(r.invoices)?r.invoices.slice():[];
    if(group==='notebook') invoices=invoices.map(notebookPartialInvoice).filter(Boolean);
    if(min!=null) invoices=invoices.filter(x=>Number(x.fifoProfit||0)>=min);
    if(max!=null) invoices=invoices.filter(x=>Number(x.fifoProfit||0)<=max);
    const rebuilt=rebuildSellerPerfFromInvoices(r,invoices);
    r.invoices=invoices; r.sellers=rebuilt.sellers; r.summary=rebuilt.summary;
    r.meta={...(r.meta||{}), clientFiltered:true, itemGroup:group==='notebook'?'notebook':'all', itemGroupRule:group==='notebook'?'ItemCode starts with 1 - filtered from cached report':'all items', minProfitRial:min, maxProfitRial:max, profitUnit:'toman-input-to-rial'};
    return r;
  }
  function renderSellerPerfReport(base, out){
    sellerPerfBaseReport = base && base.ok ? cloneReport(base) : sellerPerfBaseReport;
    const r = applySellerPerfClientFilters(sellerPerfBaseReport || base);
    if(!r || !r.ok){ out.innerHTML=`<div class="error">${hesc(r?.error||'گزارش موجود نیست')}</div>`; return; }
    const sm=r.summary||{};
    const generated=r.generatedAt?`<div class="success">تاریخ گزارش: ${hesc(window.normDate?normDate(r.generatedAt):String(r.generatedAt).slice(0,19))}${r.cached?' | از آرشیو':''}</div>`:'';
    let html=generated;
    html+=`<div class="info">منبع: ${hesc(r.source||'')} | فیلترها از کش آخرین گزارش اعمال شده‌اند؛ محاسبه مجدد فقط با دکمه بروزرسانی انجام می‌شود. | گروه کالا: ${r.meta?.itemGroup==='notebook'?'فقط نوت‌بوک؛ کد کالا با ۱':'همه کالاها'}</div>`;
    html+=`<div class="kpis"><div class="kpi"><b>${fmt(sm.invoiceCount)}</b><span>تعداد فاکتور</span></div><div class="kpi"><b>${fmt(sm.saleRial)}</b><span>جمع فروش</span></div><div class="kpi"><b>${fmt(sm.fifoProfit)}</b><span>سود FIFO</span></div><div class="kpi"><b>${sm.avgProfitPct==null?'-':fmt(sm.avgProfitPct)+'%'}</b><span>درصد سود</span></div><div class="kpi"><b>${fmt(sm.suggestedCommission||sm.finalCommission||0)}</b><span>پورسانت نهایی</span></div><div class="kpi warn"><b>${fmt(sm.unmatchedSaleRial)}</b><span>فروش با قیمت تمام‌شده نامشخص</span></div></div>`;
    html+=`<h5>جدول خلاصه فروشندگان</h5><table class="table"><thead><tr><th>نام</th><th>جاری کارکنان</th><th>فروشگاه</th><th>تعداد فاکتور</th><th>جمع فروش</th><th>سود</th><th>درصد سود</th><th>نامشخص</th><th>Lead ندارد</th><th>وضعیت</th></tr></thead><tbody>${(r.sellers||[]).map(x=>`<tr><td>${hesc(x.sellerName||x.sellerKey)}</td><td>${hesc(x.employeeAccountNumber||'ندارد')}</td><td>${hesc(x.sellerStore||'')}</td><td>${fmt(x.invoiceCount)}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${x.avgProfitPct==null?'-':fmt(x.avgProfitPct)+'%'}</td><td>${fmt(x.unmatchedSaleRial)}</td><td>${fmt(x.withoutLeadCount||0)}</td><td>${x.employeeStatus==='missing'?'<span class="error">جاری کارکنان ندارد</span>':(x.leadStatus==='ok'?'<span class="success">اوکی</span>':'<span class="warn">Lead ناقص</span>')}</td></tr>`).join('')}</tbody></table>`;
    html+=`<h5>ریز فاکتورها</h5><table class="table"><thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>فروشنده</th><th>مشتری</th><th>فروش</th><th>سود</th><th>درصد سود</th><th>Lead</th><th>نامشخص</th></tr></thead><tbody>${(r.invoices||[]).slice(0,1000).map(x=>`<tr><td>${invLink(x.invoiceNo)}</td><td>${hesc(window.normDate?normDate(x.invoiceDate):x.invoiceDate||'')}</td><td>${hesc(x.sellerName||x.sellerKey)}</td><td>${hesc(x.customerName||'')}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${x.profitPct==null?'-':fmt(x.profitPct)+'%'}</td><td>${hesc(x.leadId||'')}</td><td>${fmt(x.unmatchedSaleRial)}</td></tr>`).join('')}</tbody></table>`;
    html+=`<h5>جدول پورسانت پیشنهادی</h5><table class="table"><thead><tr><th>نام فروشنده</th><th>جمع فروش</th><th>سود محاسبه‌شده</th><th>نرخ</th><th>پورسانت خام</th><th>کسر Lead</th><th>پورسانت نهایی پیشنهادی</th><th>وضعیت Lead</th></tr></thead><tbody>${(r.sellers||[]).map(x=>`<tr><td>${hesc(x.sellerName||x.sellerKey)}</td><td>${fmt(x.saleRial)}</td><td>${fmt(x.fifoProfit)}</td><td>${hesc(String(x.commissionRate??''))}</td><td>${fmt(x.rawCommission)}</td><td>${fmt(x.leadPenalty)}</td><td>${fmt(x.suggestedCommission)}</td><td>${x.leadStatus==='ok'?'اوکی':'نیازمند بررسی'}</td></tr>`).join('')}</tbody></table>`;
    html+=`<div class="card mt"><div class="card-header"><h5>فیلترهای تکمیلی روی گزارش ذخیره‌شده</h5></div><div class="card-body"><div class="row four"><input id="spMinProfit" value="${hesc($('#spMinProfit')?.value||'')}" placeholder="سود بالای X تومان"><input id="spMaxProfit" value="${hesc($('#spMaxProfit')?.value||'')}" placeholder="سود زیر Y تومان"><select id="spItemGroup"><option value="">همه کالاها</option><option value="notebook" ${r.meta?.itemGroup==='notebook'?'selected':''}>فقط نوت‌بوک؛ کد کالا با ۱</option></select><button class="btn" id="spApplyFilters">اعمال فیلترها روی کش</button></div></div></div>`;
    out.innerHTML=html;
    if(window.wrapTables) window.wrapTables(out); bindInvoiceLinks(out);
    const ap=$('#spApplyFilters'); if(ap) ap.onclick=()=>renderSellerPerfReport(sellerPerfBaseReport, out);
  }
  async function loadSellerHistory(){
    const box=$('#spHistory'); if(!box)return;
    try{ const h=await api('/api/reports/seller-sales-profit/history'); const list=h.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>تاریخ</th><th>فیلتر پایه</th><th>نمایش</th></tr></thead><tbody>${list.map(x=>`<tr><td>${hesc(window.normDate?normDate(x.generatedAt):String(x.generatedAt||'').slice(0,19))}</td><td><small>${hesc(JSON.stringify(x.filters||{}))}</small></td><td><button class="mini sp-hist" data-id="${hesc(x._id)}">نمایش</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">آرشیوی وجود ندارد.</div>'; if(window.wrapTables) window.wrapTables(box); box.querySelectorAll('.sp-hist').forEach(b=>b.onclick=async()=>{ const r=await api('/api/reports/seller-sales-profit/history?id='+encodeURIComponent(b.dataset.id)); if(r?.report) renderSellerPerfReport({...r.report,cached:true,generatedAt:r.generatedAt}, $('#spOut')); }); }catch(e){box.innerHTML=`<div class="warn">آرشیو خوانده نشد: ${hesc(e.message||e)}</div>`;}
  }
  async function loadSellerPerf(force=false){
    const out=$('#spOut'); if(!out)return; out.innerHTML=force?'<div class="info">در حال محاسبه دستی و ذخیره گزارش پایه...</div>':'<div class="info">در حال خواندن آخرین گزارش ذخیره‌شده...</div>';
    try{ const r=await api('/api/reports/seller-sales-profit?'+spBaseQuery(force).toString()); renderSellerPerfReport(r,out); await loadSellerHistory(); }catch(e){out.innerHTML=`<div class="error">${hesc(e.message||e)}</div>`;}
  }
  window.pageSellerProfit = pageSellerProfit = async function(){
    const rg=dfltMonthRange();
    setPage('عملکرد فروشنده', `<main class="main-content"><div class="card"><div class="card-header"><h5>عملکرد فروشنده و پورسانت پیشنهادی</h5></div><div class="card-body"><div class="info">مسیر B: گزارش پایه از آرشیو Mongo خوانده می‌شود؛ تاریخ ورودی شمسی است و سرور قبل از خواندن WebService شایگان آن را به فرمت قابل قبول شایگان تبدیل می‌کند. فیلترهای سود و نوت‌بوک بعد از گزارش فقط روی کش اعمال می‌شوند.</div><div class="row four"><input id="spFrom" placeholder="از تاریخ شمسی مثل 14050301" value="${rg.from}"><input id="spTo" placeholder="تا تاریخ شمسی مثل 14050331" value="${rg.to}"><select id="spSeller"><option value="">همه فروشنده‌ها</option></select><button class="btn primary" id="spUpdate">محاسبه دستی / بروزرسانی گزارش پایه</button></div><div class="row three"><input id="spStore" placeholder="فروشگاه اختیاری"><input id="spCommissionRate" value="0.18" placeholder="نرخ پورسانت"><input id="spLeadPenalty" placeholder="جریمه هر فاکتور بدون Lead - ریال"></div><div class="actions"><button class="btn" id="spLoadLatest">نمایش آخرین گزارش همین فیلتر پایه</button><button class="btn gray" id="spClearFilters">پاک کردن فیلتر سود/گروه</button></div><div id="spOut" class="mt"><div class="muted">برای مشاهده گزارش، آخرین گزارش را بخوان یا بروزرسانی را بزن.</div></div></div></div><div class="card"><div class="card-header"><h5>آرشیو ۳۰ گزارش آخر عملکرد فروشنده</h5></div><div class="card-body"><div id="spHistory">در حال بارگذاری...</div></div></div></main>`);
    try{ const sellers=await api('/api/reports/seller-sales-profit/sellers'); const sel=$('#spSeller'); (sellers.list||[]).forEach(x=>sel.add(new Option(`${x.fullName||x.employeeAccountName||x.sellerKey} - ${x.employeeAccountNumber}`, x.sellerKey||x.employeeAccountNumber))); }catch{}
    $('#spUpdate').onclick=()=>loadSellerPerf(true); $('#spLoadLatest').onclick=()=>loadSellerPerf(false); $('#spClearFilters').onclick=()=>{ ['spMinProfit','spMaxProfit'].forEach(id=>{const el=$('#'+id); if(el)el.value='';}); const g=$('#spItemGroup'); if(g)g.value=''; if(sellerPerfBaseReport) renderSellerPerfReport(sellerPerfBaseReport,$('#spOut')); };
    await loadSellerHistory();
  };
  const oldRenderUsers = window.renderUsersTable;
  if(typeof oldRenderUsers==='function'){
    window.renderUsersTable = renderUsersTable = async function(){
      await oldRenderUsers.apply(this, arguments);
      document.querySelectorAll('#usersTable .user-row').forEach(tr=>{
        if(tr.querySelector('.soft-del-user')) return;
        let u={}; try{ u=JSON.parse(decodeURIComponent(tr.dataset.user||'')); }catch{}
        const td=tr.querySelector('td'); if(!td || !u.username) return;
        const b=document.createElement('button'); b.className='mini red soft-del-user'; b.textContent='غیرفعال'; b.onclick=async(e)=>{ e.stopPropagation(); if(!confirm(`کاربر ${u.username} غیرفعال شود؟ سوابق حذف نمی‌شود.`)) return; const r=await post('/api/users/delete',{username:u.username}); alert(r.ok?'کاربر غیرفعال شد':(r.error||'خطا')); await window.renderUsersTable(); };
        td.appendChild(document.createTextNode(' ')); td.appendChild(b);
      });
    };
  }
  const prevRoute=window.route||route;
  window.route=route=async function(){ const p=location.hash.slice(1)||firstAllowedPage(); if(p==='seller-profit') return pageSellerProfit(); const r=await prevRoute.apply(this,arguments); return r; };
})();

/* PATCH 0.9.19.15: CRM Tablo board for stock-out and purchase entry review */
(function(){
  window.MKCRM_VERSION='0.9.19.17-role-access-alignment';
  try{
    ['seller','seller_buyer','accounting','warehouse','purchase'].forEach(r=>{ if(Array.isArray(ROLE_PAGES[r]) && !ROLE_PAGES[r].includes('tablo')) ROLE_PAGES[r].push('tablo'); });
  }catch{}
  function money(n){return Number(n||0).toLocaleString('fa-IR')}
  function safe(v){try{return esc(v==null?'':String(v));}catch{return String(v??'')}}
  function boardStatusFa(s){return ({new:'جدید',seen:'بررسی شد',site_updated:'سایت بروزرسانی شد',closed:'بسته شد'}[String(s||'new')]||s||'')}
  function boardTypeFa(t){return ({stock_out:'اتمام کالا',stock_in:'ورود کالا'}[String(t||'')]||t||'')}
  function canViewPurchaseInvoicesUI(){const u=state.user||{}; return u.role==='admin' || u.canViewPurchaseInvoices===true;}
  function canPostPurchaseToBoardUI(){const u=state.user||{}; return u.role==='admin' || u.canPostPurchaseToBoard===true;}
  function canManageBoardEventsUI(){const u=state.user||{}; return u.role==='admin' || u.canManageBoardEvents===true;}
  function boardRow(x){
    const canManage=canManageBoardEventsUI(); return `<tr><td>${safe(toJalaliDisplay(x.createdAt||''))}<br><small>${safe(String(x.createdAt||'').slice(11,19))}</small></td><td>${safe(boardTypeFa(x.type))}</td><td><b>${safe(x.itemCode)}</b><br>${safe(x.itemName)}</td><td>${x.qty!=null?money(x.qty):''}</td><td>${x.totalQtyAfter!=null?money(x.totalQtyAfter):''}</td><td>${safe(x.sellerName||x.createdByName||x.supplierName||'')}</td><td>${safe(x.invoiceNo||x.purchaseInvoiceNo||'')}</td><td>${safe(boardStatusFa(x.status))}</td><td>${canManage?`<select class="board-status" data-id="${safe(x._id)}"><option value="new" ${x.status==='new'?'selected':''}>جدید</option><option value="seen" ${x.status==='seen'?'selected':''}>بررسی شد</option><option value="site_updated" ${x.status==='site_updated'?'selected':''}>سایت بروزرسانی شد</option><option value="closed" ${x.status==='closed'?'selected':''}>بسته شد</option></select>`:'-'}</td></tr>`;
  }
  async function loadBoardEvents(){
    const box=$('#tabloEvents'); if(!box)return;
    const status=$('#tabloStatus')?.value||'all'; const type=$('#tabloType')?.value||'all';
    box.innerHTML='<div class="info">در حال خواندن تابلو...</div>';
    const r=await api(`/api/board/events?status=${encodeURIComponent(status)}&type=${encodeURIComponent(type)}&limit=200`);
    const rows=r.list||[];
    box.innerHTML=rows.length?`<div class="table-scroll"><table class="table"><thead><tr><th>زمان</th><th>نوع</th><th>کالا</th><th>تعداد</th><th>موجودی کل بعد</th><th>ثبت‌کننده/فروشنده</th><th>فاکتور</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows.map(boardRow).join('')}</tbody></table></div>`:'<div class="muted">رویدادی وجود ندارد.</div>';
    $$('.board-status').forEach(sel=>sel.onchange=async()=>{const r=await post('/api/board/events/status',{id:sel.dataset.id,status:sel.value}); if(!r.ok) alert(r.error||'خطا در تغییر وضعیت'); await loadBoardEvents();});
  }
  async function loadPurchaseInvoices(){
    const box=$('#tabloPurchases'); if(!box)return;
    box.innerHTML='<div class="info">در حال خواندن ۳۰ فاکتور خرید آخر از شایگان...</div>';
    const r=await api('/api/board/purchase-invoices?limit=30');
    const rows=r.list||[];
    box.innerHTML=rows.length?`<div class="table-scroll"><table class="table"><thead><tr><th>شماره خرید</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ</th><th>ردیف</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows.map(x=>`<tr><td><button class="linklike purchase-view" data-no="${safe(x.invNo)}">${safe(x.invNo)}</button></td><td>${safe(toJalaliDisplay(x.invDate))}</td><td>${safe(x.supplierName)}<br><small>${safe(x.supplierNumber)}</small></td><td>${money(x.totalAmount)}</td><td>${money(x.rowCount)}</td><td>${x.announced?'<span class="oktext">اعلام شده</span>':'-'}</td><td><button class="mini purchase-view" data-no="${safe(x.invNo)}">مشاهده</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">فاکتور خریدی پیدا نشد.</div>';
    $$('.purchase-view').forEach(b=>b.onclick=()=>viewPurchaseInvoice(b.dataset.no));
  }
  async function viewPurchaseInvoice(no){
    const box=$('#tabloPurchaseDetail'); if(!box)return;
    box.innerHTML='<div class="info">در حال خواندن فاکتور خرید...</div>';
    const r=await api(`/api/board/purchase-invoices/${encodeURIComponent(no)}`);
    if(!r.ok){box.innerHTML=`<div class="error">${safe(r.error||'خطا')}</div>`;return;}
    const inv=r.invoice||{}, lines=r.lines||[];
    const announceBtn = canPostPurchaseToBoardUI()?'<button class="btn green" id="announcePurchaseToBoard">اعلام ورود در تابلو</button>':'<div class="muted">دسترسی اعلام ورود کالا برای این کاربر فعال نیست.</div>';
    box.innerHTML=`<div class="card mt"><div class="card-header"><h5>فاکتور خرید ${safe(inv.invNo)}</h5></div><div class="card-body"><div class="info">تاریخ: ${safe(toJalaliDisplay(inv.invDate))} | تأمین‌کننده: ${safe(inv.supplierName)} | مبلغ: ${money(inv.totalAmount)}</div><div class="table-scroll"><table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>انبار</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>${lines.map(x=>`<tr><td>${safe(x.itemCode)}</td><td>${safe(x.itemName)}</td><td>${safe(x.stockNumber)} ${safe(x.stockName)}</td><td>${money(x.qty)}</td><td>${money(x.price)}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>${announceBtn}<div id="announceOut" class="mt"></div></div></div>`;
    if($('#announcePurchaseToBoard')) $('#announcePurchaseToBoard').onclick=async()=>{if(!confirm('کالاهای این فاکتور خرید در تابلو به عنوان ورود کالا اعلام شود؟'))return; const r=await post(`/api/board/purchase-invoices/${encodeURIComponent(no)}/announce`,{}); $('#announceOut').innerHTML=r.ok?`<div class="success">اعلام شد. جدید: ${money(r.inserted)} | تکراری/رد شده: ${money(r.skipped)}</div>`:`<div class="error">${safe(r.error||'خطا')}</div>`; await loadBoardEvents();};
  }
  window.pageTablo = async function(){
    const purchaseReviewCard = canViewPurchaseInvoicesUI()?`<div class="card"><div class="card-header"><h5>بررسی فاکتورهای خرید برای اعلام ورود کالا</h5></div><div class="card-body"><button class="btn" id="loadPurchaseInvoicesBtn">خواندن ۳۰ فاکتور خرید آخر</button><div id="tabloPurchases" class="mt"></div><div id="tabloPurchaseDetail" class="mt"></div></div></div>`:`<div class="card"><div class="card-header"><h5>بررسی فاکتورهای خرید</h5></div><div class="card-body"><div class="muted">دسترسی مرور فاکتورهای خرید برای این کاربر فعال نیست. تابلو برای مشاهده رویدادها همچنان فعال است.</div></div></div>`;
    setPage('تابلو',`<main class="main-content"><div class="card"><div class="card-header"><h5>تابلو: ورود کالا و اتمام موجودی</h5></div><div class="card-body"><div class="info">اتمام کالا بعد از صدور فاکتور فروش و صفر شدن موجودی کل در انبارهای فعال به صورت خودکار ثبت می‌شود. ورود کالا فقط برای کاربران دارای دسترسی مرور فاکتور خرید/اعلام ورود قابل انجام است.</div><div class="row three"><div class="form-group"><label>نوع</label><select id="tabloType"><option value="all">همه</option><option value="stock_out">اتمام کالا</option><option value="stock_in">ورود کالا</option></select></div><div class="form-group"><label>وضعیت</label><select id="tabloStatus"><option value="all">همه</option><option value="new">جدید</option><option value="seen">بررسی شد</option><option value="site_updated">سایت بروزرسانی شد</option><option value="closed">بسته شد</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="tabloReload">بروزرسانی تابلو</button></div></div><div id="tabloEvents" class="mt"></div></div></div>${purchaseReviewCard}</main>`);
    $('#tabloReload').onclick=loadBoardEvents; $('#tabloStatus').onchange=loadBoardEvents; $('#tabloType').onchange=loadBoardEvents; if($('#loadPurchaseInvoicesBtn')) $('#loadPurchaseInvoicesBtn').onclick=loadPurchaseInvoices; await loadBoardEvents();
  };
  const prevCanPage = window.canPage || canPage;
  window.canPage = canPage = function(page){ if(page==='tablo'){ const r=userRole(); return r==='admin' || ['seller','seller_buyer','accounting','warehouse','purchase'].includes(r); } return prevCanPage(page); };
  const prevRenderMenu = window.renderMenu || renderMenu;
  window.renderMenu = renderMenu = function(){ try{prevRenderMenu();}catch(e){} const m=$('#menu'); if(!m || m.querySelector('[data-page="tablo"]')) return; const b=document.createElement('button'); b.className='navbtn'; b.dataset.page='tablo'; b.textContent='تابلو'; b.onclick=e=>{e.preventDefault();location.hash='tablo';route();}; const firstMgmt=[...m.querySelectorAll('.menu-group')].find(x=>x.textContent.includes('مدیریت')); const reports=m.querySelector('[data-page="seller-profit"]')||m.querySelector('[data-page="reports"]'); if(reports) reports.parentNode.insertBefore(b,reports); else m.appendChild(b); };
  const prevRoute = window.route || route;
  window.route = route = async function(){ const p=location.hash.slice(1)||firstAllowedPage(); if(p==='tablo') return pageTablo(); return prevRoute(); };
})();


/* PATCH 0.9.19.17: role access alignment for sale/proforma/supplier aging/seller performance */
(function(){
  window.MKCRM_VERSION='0.9.19.17-role-access-alignment';
  const add=(role,pages)=>{try{if(Array.isArray(ROLE_PAGES[role])) pages.forEach(p=>{if(!ROLE_PAGES[role].includes(p)) ROLE_PAGES[role].push(p);});}catch{}};
  add('accounting',['sale','supplier-aging','seller-profit']);
  add('warehouse',['sale']);
  try{if(Array.isArray(ROLE_PAGES.warehouse)) ROLE_PAGES.warehouse=ROLE_PAGES.warehouse.filter(p=>p!=='supplier-aging'&&p!=='seller-profit');}catch{}
  add('purchase',['sale','supplier-aging','seller-profit']);
  const prevCanPage = window.canPage || canPage;
  window.canPage = canPage = function(page){
    const r=userRole();
    if(r==='admin') return true;
    if(page==='sale' || page==='proforma' || page==='proforma-list') return ['seller','seller_buyer','accounting','warehouse','purchase'].includes(r);
    if(page==='supplier-aging') return ['accounting','purchase'].includes(r);
    if(page==='seller-profit') return ['accounting','purchase'].includes(r);
    return prevCanPage(page);
  };
  const prevRenderMenu = window.renderMenu || renderMenu;
  window.renderMenu = renderMenu = function(){ try{prevRenderMenu();}catch(e){} };
})();


/* PATCH 0.9.19.20: Auto Inventory Sync status panel + server-time visibility */
(function(){
  const prevPageReports = window.pageReports || pageReports;
  window.pageReports = pageReports = async function(){
    await prevPageReports();
    const out = document.getElementById('out');
    const card = document.querySelector('.card .card-body') || document.querySelector('.card');
    if(!card || document.getElementById('autoSyncStatusBtn')) return;
    const wrap = document.createElement('div');
    wrap.className = 'mt';
    wrap.innerHTML = `<button class="btn" id="autoSyncStatusBtn">وضعیت Auto Sync موجودی</button> <button class="btn" id="autoSyncRunBtn">اجرای یک مرحله Auto Sync</button>`;
    card.insertBefore(wrap, out || null);
    const show = async (promise)=>{ const r = await promise; if(out) out.textContent = JSON.stringify(r,null,2); };
    document.getElementById('autoSyncStatusBtn').onclick = ()=>show(api('/api/inventory/auto-sync/status'));
    document.getElementById('autoSyncRunBtn').onclick = ()=>show(post('/api/inventory/auto-sync/run',{}));
  };
})();

/* 0.9.19.22: Sale invoice GeneralRef + admin-controlled invoice extras (Expense[])
   Scope: Invoice UI/API only. Inventory/search/sync/tablo logic from 0.9.19.21 is preserved. */
(function(){
  const V='0.9.19.22-invoice-ref-expense';
  window.MKCRM_VERSION=V;
  const qs=s=>document.querySelector(s);
  const safe=v=>{try{return esc(v==null?'':String(v));}catch{return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}};
  const money=v=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  function parseMoney(v){
    const raw=String(v??'').replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,،\s]/g,'').replace(/[^0-9.\-]/g,'');
    const n=Number(raw||0); return Number.isFinite(n)?n:0;
  }
  function saleGrossLocal(){return (state.saleLines||[]).reduce((s,x)=>s+Number(x.quantity||0)*Number(x.price||0),0)}
  function saleDiscountLocal(){return Math.max(0, parseMoney(qs('#saleDiscount')?.value||0));}
  function selectedExtras(){
    const rows=[];
    document.querySelectorAll('#saleExtrasRows .sale-extra-row').forEach(row=>{
      const accountNumber=row.querySelector('.sale-extra-account')?.value||'';
      const amount=parseMoney(row.querySelector('.sale-extra-amount')?.value||0);
      const opt=row.querySelector('.sale-extra-account')?.selectedOptions?.[0];
      if(accountNumber && amount>0) rows.push({accountNumber, accountName:opt?.dataset.name||opt?.textContent||'', accountGuid:opt?.dataset.guid||'', type:opt?.dataset.type||'extra', amount});
    });
    return rows;
  }
  function extrasTotal(){return selectedExtras().reduce((s,x)=>s+Number(x.amount||0),0)}
  function resetSaleForm922(){
    state.saleLines=[]; state.selectedItem=null; state.selectedStock=null; state.invoiceNumber=null; state.saleIssued=false; state.saleIssueInFlight=false; state.saleIssueKey='sale-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    ['buyerName','buyerMobile','buyerNational','leadId','saleQ','saleSelected','STNumber','Price','saleGeneralRef'].forEach(id=>{const el=qs('#'+id); if(el) el.value='';});
    const q=qs('#Quan'); if(q) q.value='1'; const d=qs('#saleDiscount'); if(d) d.value='0';
    ['saleInventory','serialBox','priceWarn'].forEach(id=>{const el=qs('#'+id); if(el) el.innerHTML='';});
    const rows=qs('#saleExtrasRows'); if(rows) rows.innerHTML='';
    try{ if(typeof renderSaleLines==='function') renderSaleLines(); }catch{}
    updateTotals922();
    const issueBtn=qs('#issueBtn'), reserveBtn=qs('#reserveBtn');
    if(issueBtn){issueBtn.disabled=false; issueBtn.textContent=issueBtn.dataset.oldText||'صدور فاکتور';}
    if(reserveBtn) reserveBtn.disabled=false;
    try{ document.querySelectorAll('#saleRefExtrasBox input, #saleRefExtrasBox select').forEach(el=>{ if(el.tagName==='SELECT') el.selectedIndex=0; else el.value=''; }); }catch{}
    try{ document.querySelectorAll('.floating-list').forEach(el=>{ el.innerHTML=''; el.style.display='none'; }); }catch{}
    try{ const out=qs('#saleOut'); if(out && !out.dataset.keepSuccess) out.innerHTML=''; }catch{}
  }
  function markSaleFormReady922(){
    state.saleIssued=false; state.saleIssueInFlight=false; state.invoiceNumber=null;
    state.saleIssueKey='sale-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    const issueBtn=qs('#issueBtn'), reserveBtn=qs('#reserveBtn');
    if(issueBtn){ issueBtn.disabled=false; issueBtn.textContent=issueBtn.dataset.oldText||'صدور فاکتور'; }
    if(reserveBtn) reserveBtn.disabled=false;
  }
  function updateTotals922(){
    const box=qs('#saleTotalsBox'); if(!box) return;
    const gross=saleGrossLocal(), discount=saleDiscountLocal(), extra=extrasTotal(), net=Math.max(0,gross-discount+extra);
    box.innerHTML=`<div class="sale-total-row"><span>جمع ردیف‌ها</span><b>${money(gross)} ریال</b></div><div class="sale-total-row"><span>تخفیف</span><b>${money(discount)} ریال</b></div><div class="sale-total-row"><span>افزودنی‌ها</span><b>${money(extra)} ریال</b></div><div class="sale-total-row net"><span>قابل پرداخت</span><b>${money(net)} ریال</b></div>`;
  }
  async function allowedExtras(){
    if(state.allowedSaleInvoiceExtras) return state.allowedSaleInvoiceExtras;
    try{const r=await api('/api/settings/sale-invoice-extras'); state.allowedSaleInvoiceExtras=r.list||[]; return state.allowedSaleInvoiceExtras;}catch(e){return []}
  }
  function extraOptions(list){return '<option value="">انتخاب افزودنی...</option>'+list.map(x=>`<option value="${safe(x.accountNumber)}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||'')}" data-type="${safe(x.type||'extra')}">${safe(x.accountNumber)} - ${safe(x.accountName||'')}</option>`).join('')}
  async function injectSaleRefExtras(){
    if(qs('#saleRefExtrasBox')) return;
    const anchor=qs('#saleDiscountBox') || qs('#saleLines'); if(!anchor) return;
    const list=await allowedExtras();
    const div=document.createElement('div'); div.id='saleRefExtrasBox'; div.className='sale-ref-extras-box';
    div.innerHTML=`<div class="row two"><div class="form-group"><label>رفرنس فاکتور / کد پیگیری</label><input id="saleGeneralRef" maxlength="80" autocomplete="off" placeholder="مثلاً 77708"></div><div class="form-group"><label>افزودنی‌های فاکتور</label><div class="small muted">فقط حساب‌های مجاز تعریف‌شده توسط ادمین قابل انتخاب هستند.</div></div></div><div id="saleExtrasRows"></div><div class="actions"><button class="btn" id="addSaleExtraRow" type="button">+ افزودن هزینه / افزوده</button></div>`;
    anchor.after(div);
    function addRow(){
      const row=document.createElement('div'); row.className='row three sale-extra-row';
      row.innerHTML=`<div class="form-group"><label>حساب افزودنی</label><select class="sale-extra-account">${extraOptions(list)}</select></div><div class="form-group"><label>مبلغ - ریال</label><input class="sale-extra-amount" inputmode="numeric" value="0"></div><div class="form-group"><label>&nbsp;</label><button class="btn red sale-extra-remove" type="button">حذف</button></div>`;
      qs('#saleExtrasRows').appendChild(row);
      row.querySelector('.sale-extra-remove').onclick=()=>{row.remove();updateTotals922();};
      row.querySelector('.sale-extra-account').onchange=updateTotals922;
      row.querySelector('.sale-extra-amount').oninput=updateTotals922;
      updateTotals922();
    }
    qs('#addSaleExtraRow').onclick=addRow;
    if(!list.length){
      qs('#saleExtrasRows').innerHTML='<div class="warn">هنوز حساب مجاز افزودنی تعریف نشده است. ادمین باید در تنظیمات حساب‌های مجاز را ثبت کند.</div>';
    }
    const d=qs('#saleDiscount'); if(d) d.addEventListener('input',updateTotals922);
    updateTotals922();
  }
  const prevRenderSaleLines=window.renderSaleLines;
  if(prevRenderSaleLines){
    window.renderSaleLines=renderSaleLines=function(){const r=prevRenderSaleLines.apply(this,arguments); setTimeout(updateTotals922,40); return r;};
  }
  const prevPageSale=window.pageSale||pageSale;
  window.pageSale=pageSale=async function(){const r=await prevPageSale.apply(this,arguments); setTimeout(()=>{injectSaleRefExtras(); const btn=qs('#issueBtn'); if(btn) btn.onclick=window.issueSale;},180); return r;};

  window.issueSale=issueSale=async function(){
    try{ if(typeof cleanMoneyInputs==='function') cleanMoneyInputs(); }catch{}
    const issueBtn=qs('#issueBtn'), reserveBtn=qs('#reserveBtn');
    if(state.saleIssued){ resetSaleForm922(); markSaleFormReady922(); }
    if(state.saleIssueInFlight){ alert('صدور فاکتور در حال انجام است؛ صبر کن تا پاسخ شایگان نمایش داده شود.'); return; }
    state.saleIssueInFlight=true;
    if(issueBtn){ issueBtn.disabled=true; issueBtn.dataset.oldText=issueBtn.textContent; issueBtn.textContent='در حال صدور...'; }
    if(reserveBtn) reserveBtn.disabled=true;
    const out=qs('#saleOut'); if(out) out.innerHTML='<div class="info">در حال صدور فاکتور فروش در شایگان...</div>';
    try{
      if(!state.saleLines.length){ if(state.selectedItem&&state.selectedStock) addSaleLine(); }
      if(!state.saleLines.length) throw new Error('هیچ ردیف کالایی در فاکتور نیست');
      if(!state.selectedMapping||!state.selectedMapping.cashboxAccountNumber||!state.selectedMapping.employeeAccountNumber) throw new Error('اتصال صندوق و نماینده فروش کامل نیست');
      const discountAmount=saleDiscountLocal();
      const gross=saleGrossLocal();
      const invoiceExtras=selectedExtras();
      const extraTotal=invoiceExtras.reduce((s,x)=>s+Number(x.amount||0),0);
      if(discountAmount>gross) throw new Error('تخفیف نمی‌تواند بیشتر از جمع ردیف‌ها باشد');
      const payload={saleIssueKey:state.saleIssueKey,customerName:qs('#buyerName')?.value||'',mobile:qs('#buyerMobile')?.value||'',nationalCode:qs('#buyerNational')?.value||'',leadId:qs('#leadId')?.value||'',mappingUsername:state.selectedMapping.username,sessionUsername:state.user?.username||'',username:state.user?.fullName||state.selectedMapping.fullName||'CRM',items:state.saleLines,discountAmount,generalRef:qs('#saleGeneralRef')?.value||'',invoiceExtras};
      const r=await post('/admin/accounting/putInvoice',payload);
      if(r.ok){
        const printedNo=r.invoiceNumber || r.result?.Number || r.result?.InvNo || state.invoiceNumber;
        const issuedTitle = r.duplicate ? 'این فاکتور قبلاً ثبت شده بود و دوباره ارسال نشد.' : `فاکتور ${safe(printedNo||'')} با موفقیت صادر شد.`;
        resetSaleForm922(); markSaleFormReady922();
        if(out) out.innerHTML=`<div class="success">${issuedTitle} فروشنده: ${safe(r.mapping?.fullName||'')} | فروشگاه: ${safe(r.mapping?.storeName||'')} | تخفیف: ${money(discountAmount)} ریال | افزودنی‌ها: ${money(extraTotal)} ریال<br><b>فرم برای صدور فاکتور جدید آماده شد.</b></div><div class="actions"><a class="btn" target="_blank" href="${r.printUrl || ('/print/invoice/'+encodeURIComponent(printedNo))}">چاپ فاکتور</a><button class="btn green" id="newSaleAfterIssue">فاکتور جدید</button></div>`;
        const nb=qs('#newSaleAfterIssue'); if(nb) nb.onclick=()=>resetSaleForm922();
      } else throw new Error(r.error||JSON.stringify(r.raw));
    }catch(e){
      if(out) out.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;
      state.saleIssueInFlight=false;
      if(issueBtn){ issueBtn.disabled=false; issueBtn.textContent=issueBtn.dataset.oldText||'صدور فاکتور'; }
      if(reserveBtn) reserveBtn.disabled=false;
    }finally{ try{ if(typeof reformatMoneyInputs==='function') reformatMoneyInputs(); }catch{} }
  };

  const prevPageSettings=window.pageSettings||pageSettings;
  async function injectInvoiceExtrasSettings(){
    if(qs('#saleInvoiceExtrasSettingsBox')) return;
    const main=qs('.main-content'); if(!main) return;
    const card=document.createElement('div'); card.className='card'; card.id='saleInvoiceExtrasSettingsBox';
    card.innerHTML=`<div class="card-header"><h5>حساب‌های مجاز افزودنی فاکتور فروش</h5></div><div class="card-body"><div class="info">کاربر فروش فقط از این حساب‌ها می‌تواند هزینه/افزوده فاکتور مثل هزینه پیک یا فروش ارگانی را انتخاب کند.</div><div class="row three"><div class="form-group"><label>جستجوی حساب شایگان</label><input id="extraAccountSearch" placeholder="مثلاً هزینه پیک یا 92307002"></div><div class="form-group"><label>نوع نمایشی</label><select id="extraAccountType"><option value="extra">افزوده</option><option value="delivery">هزینه پیک</option><option value="tax_or_org">فروش ارگانی / ارزش افزوده</option><option value="fee">کارمزد</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="searchExtraAccountBtn">جستجو</button></div></div><div id="extraAccountResults" class="mt"></div><h4>حساب‌های مجاز فعلی</h4><div id="allowedExtraAccountsBox"></div><div class="actions"><button class="btn green" id="saveAllowedExtraAccounts">ذخیره حساب‌های مجاز</button></div><div id="allowedExtraMsg"></div></div>`;
    main.appendChild(card);
    let allowed=[];
    async function loadAllowed(){try{const r=await api('/api/settings/sale-invoice-extras'); allowed=r.list||[]; renderAllowed();}catch(e){qs('#allowedExtraAccountsBox').innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}}
    function renderAllowed(){qs('#allowedExtraAccountsBox').innerHTML=allowed.length?`<table class="table"><thead><tr><th>کد</th><th>نام</th><th>نوع</th><th>حذف</th></tr></thead><tbody>${allowed.map((x,i)=>`<tr><td>${safe(x.accountNumber)}</td><td>${safe(x.accountName)}</td><td>${safe(x.type||'extra')}</td><td><button class="mini red remove-extra-acc" data-i="${i}">حذف</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حساب مجازی ثبت نشده است.</div>'; document.querySelectorAll('.remove-extra-acc').forEach(b=>b.onclick=()=>{allowed.splice(Number(b.dataset.i),1);renderAllowed();});}
    qs('#searchExtraAccountBtn').onclick=async()=>{const q=(qs('#extraAccountSearch').value||'').trim(); if(q.length<2) return; const r=await api('/api/accounts/search?q='+encodeURIComponent(q)); const list=r.list||[]; qs('#extraAccountResults').innerHTML=list.length?`<table class="table"><tbody>${list.slice(0,10).map((x,i)=>`<tr><td>${safe(x.accountNumber||x.AccountNumber||'')}</td><td>${safe(x.accountName||x.AccountName||'')}</td><td><button class="mini pick-extra-acc" data-i="${i}">افزودن</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">نتیجه‌ای پیدا نشد.</div>'; document.querySelectorAll('.pick-extra-acc').forEach(b=>b.onclick=()=>{const x=list[Number(b.dataset.i)]; const no=String(x.accountNumber||x.AccountNumber||''); if(!no) return; if(!allowed.some(a=>String(a.accountNumber)===no)) allowed.push({accountNumber:no,accountName:String(x.accountName||x.AccountName||''),accountGuid:String(x.accountGuid||x.AccountGuId||x.guId||x.GuId||''),type:qs('#extraAccountType').value,isActive:true}); renderAllowed();});};
    qs('#saveAllowedExtraAccounts').onclick=async()=>{const msg=qs('#allowedExtraMsg'); msg.innerHTML='در حال ذخیره...'; try{const r=await post('/api/settings/sale-invoice-extras',{list:allowed}); state.allowedSaleInvoiceExtras=null; msg.innerHTML=`<div class="success">${safe((r.list||[]).length)} حساب مجاز ذخیره شد.</div>`;}catch(e){msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    await loadAllowed();
  }
  if(prevPageSettings){ window.pageSettings=pageSettings=async function(){const r=await prevPageSettings.apply(this,arguments); setTimeout(injectInvoiceExtrasSettings,250); return r;}; }
  const prevRoute=window.route||route;
  window.route=route=async function(){const r=await prevRoute.apply(this,arguments); if((location.hash.slice(1)||'')==='settings') setTimeout(injectInvoiceExtrasSettings,300); return r;};
  const style=document.createElement('style');
  style.textContent='.sale-ref-extras-box{margin-top:12px;border:1px solid #dbeafe;background:#f8fbff;border-radius:10px;padding:10px}.sale-extra-row{align-items:end}.sale-extra-remove{margin-top:22px}';
  document.head.appendChild(style);
})();

/* PATCH 0.9.19.26.1: Expose Supplier Stock Sleep Engine in UI */
(function(){
  const $q = window.qs || window.$ || ((s)=>document.querySelector(s));
  const $qa = window.qsa || window.$$ || ((s)=>Array.from(document.querySelectorAll(s)));
  const htmlSafe = window.safe || window.esc || ((v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])));
  const fmtMoney = window.money || ((v)=>Number(v||0).toLocaleString('fa-IR'));
  const getApi = window.api || (async (url)=>{const r=await fetch(url,{credentials:'include'});const j=await r.json();if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);return j;});
  const postApi = window.post || (async (url,body)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})});const j=await r.json();if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);return j;});
  const roles=['admin','accounting','purchase'];
  try{ roles.forEach(r=>{ if(Array.isArray(ROLE_PAGES[r]) && !ROLE_PAGES[r].includes('stock-sleep')) ROLE_PAGES[r].push('stock-sleep'); }); }catch{}

  function pct(snapshot, counts){
    const total=Number(snapshot?.totalItemRows||0); if(!total) return 0;
    const done=Number(counts?.done||0)+Number(counts?.failed||0);
    return Math.min(100, Math.round(done*100/total));
  }
  function statusFa(s){return ({queued:'در صف',running:'در حال اجرا',completed:'تکمیل',completed_with_errors:'تکمیل با خطا',failed:'خطا'})[s]||s||'';}
  function rowFa(x){return `<tr><td>${htmlSafe(x.snapshotId||'')}</td><td>${statusFa(x.status)}</td><td>${fmtMoney(x.totalItemRows||0)}</td><td>${fmtMoney(x.totalActiveInventoryQty||0)}</td><td>${fmtMoney(x.totalActiveInventoryValue||0)}</td><td>${htmlSafe((x.activeWarehouses||[]).join('، ')||'همه')}</td><td>${htmlSafe(x.startedAt?new Date(x.startedAt).toLocaleString('fa-IR'):'')}</td><td><button class="mini pick-stock-sleep" data-id="${htmlSafe(x.snapshotId||'')}">انتخاب</button></td></tr>`;}

  async function renderStockSleepStatus(snapshotId){
    const box=$q('#stockSleepStatus'); if(!box) return;
    try{
      const r=await getApi('/api/stock-sleep/status'+(snapshotId?('?snapshotId='+encodeURIComponent(snapshotId)):''));
      const s=r.snapshot, c=r.counts;
      if(!s){ box.innerHTML='<div class="muted">هنوز Snapshot ساخته نشده است.</div>'; return; }
      window.__stockSleepSnapshotId=s.snapshotId;
      box.innerHTML=`<div class="info"><b>Snapshot:</b> ${htmlSafe(s.snapshotId)} | <b>وضعیت:</b> ${statusFa(s.status)} | <b>پیشرفت:</b> ${pct(s,c)}٪ | <b>صف:</b> pending ${fmtMoney(c?.pending||0)} / done ${fmtMoney(c?.done||0)} / failed ${fmtMoney(c?.failed||0)} | <b>ارزش موجودی فعال:</b> ${fmtMoney(s.totalActiveInventoryValue||0)} ریال</div>`;
      await renderStockSleepSuppliers(s.snapshotId);
    }catch(e){ box.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`; }
  }
  async function renderStockSleepSnapshots(){
    const box=$q('#stockSleepSnapshots'); if(!box) return;
    try{
      const r=await getApi('/api/stock-sleep/snapshots?limit=10');
      const list=r.list||[];
      box.innerHTML=list.length?`<table class="table"><thead><tr><th>Snapshot</th><th>وضعیت</th><th>ردیف کالا</th><th>تعداد</th><th>ارزش</th><th>انبارها</th><th>شروع</th><th></th></tr></thead><tbody>${list.map(rowFa).join('')}</tbody></table>`:'<div class="muted">Snapshot قبلی وجود ندارد.</div>';
      $qa('.pick-stock-sleep').forEach(b=>b.onclick=()=>renderStockSleepStatus(b.dataset.id));
    }catch(e){ box.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`; }
  }
  async function renderStockSleepSuppliers(snapshotId){
    const box=$q('#stockSleepSuppliers'); if(!box) return;
    try{
      const r=await getApi('/api/stock-sleep/suppliers?snapshotId='+encodeURIComponent(snapshotId||'')+'&limit=300');
      const list=r.list||[];
      box.innerHTML=list.length?`<table class="table"><thead><tr><th>منشأ / تأمین‌کننده</th><th>خرید دوره</th><th>مانده موجودی</th><th>سهم از کل</th><th>میانگین سن</th><th>کالا</th><th>لایه</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${htmlSafe(x.supplierName||x.supplierAccountNo||'')}</td><td>${fmtMoney(x.periodPurchaseValue||0)}</td><td>${fmtMoney(x.remainingValue||0)}</td><td>${htmlSafe(x.shareOfTotalInventoryPercent??'')}٪</td><td>${x.averageAgeDays==null?'نامشخص':fmtMoney(x.averageAgeDays)}</td><td>${fmtMoney(x.itemCount||0)}</td><td>${fmtMoney(x.layerCount||0)}</td><td><button class="mini stock-sleep-layers" data-sup="${htmlSafe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">هنوز Summary ساخته نشده است. چند Batch پردازش کن تا Snapshot کامل شود.</div>';
      $qa('.stock-sleep-layers').forEach(b=>b.onclick=()=>renderStockSleepLayers(snapshotId,b.dataset.sup));
    }catch(e){ box.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`; }
  }
  async function renderStockSleepLayers(snapshotId, supplierAccountNo){
    const box=$q('#stockSleepLayers'); if(!box) return;
    box.innerHTML='<div class="info">در حال خواندن لایه‌های کالایی...</div>';
    try{
      const url='/api/stock-sleep/layers?snapshotId='+encodeURIComponent(snapshotId||'')+'&limit=500'+(supplierAccountNo?'&supplierAccountNo='+encodeURIComponent(supplierAccountNo):'');
      const r=await getApi(url); const list=r.list||[];
      box.innerHTML=list.length?`<h4>لایه‌های کالایی منشأ انتخاب‌شده</h4><table class="table"><thead><tr><th>Layer ID</th><th>کالا</th><th>انبار</th><th>منشأ</th><th>فاکتور خرید</th><th>تاریخ</th><th>تعداد تخصیص</th><th>ارزش</th><th>سن</th><th>سود FIFO</th></tr></thead><tbody>${list.map(x=>`<tr><td>${htmlSafe(x.layerId||'')}</td><td>${htmlSafe(x.itemCode||'')}<br>${htmlSafe(x.itemDescription||'')}</td><td>${htmlSafe(x.warehouseNo||'')}</td><td>${htmlSafe(x.supplierName||x.originType||'')}</td><td>${htmlSafe(x.purchaseInvoiceNo||'')}</td><td>${htmlSafe(x.purchaseDate||'')}</td><td>${fmtMoney(x.allocatedQty||0)}</td><td>${fmtMoney(x.allocatedValue||0)}</td><td>${x.ageDays==null?'نامشخص':fmtMoney(x.ageDays)}</td><td>${x.fifoProfitPercent==null?'محاسبه نشده':htmlSafe(x.fifoProfitPercent+'٪')}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">لایه‌ای برای این فیلتر وجود ندارد.</div>';
    }catch(e){ box.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`; }
  }

  window.pageStockSleep = async function(){
    setPage('خواب کالا نماینده',`<main class="main-content"><div class="card"><div class="card-header"><h5>موتور خواب کالا / نماینده - Snapshot Background</h5></div><div class="card-body"><div class="info">این صفحه محاسبه real-time انجام نمی‌دهد. ابتدا Snapshot از موجودی فعال ساخته می‌شود، سپس کاردکس کالاها به‌صورت Batch پردازش می‌شود. تست را با ۱۰ کالا شروع کن.</div><div class="row four"><div class="form-group"><label>سال مالی از تاریخ</label><input id="stockSleepFiscal" value="14050101"></div><div class="form-group"><label>حداکثر کالا برای تست</label><input id="stockSleepMaxItems" value="10" inputmode="numeric"></div><div class="form-group"><label>حداکثر ردیف کاردکس هر کالا</label><input id="stockSleepKardexMax" value="80" inputmode="numeric"></div><div class="form-group"><label>Batch پردازش</label><input id="stockSleepBatchLimit" value="500" inputmode="numeric"></div></div><div class="actions"><button class="btn green" id="stockSleepInit">آماده‌سازی Collectionها</button><button class="btn red" id="stockSleepStart">ایجاد Snapshot تست</button><button class="btn" id="stockSleepProcess">پردازش Batch بعدی</button><button class="btn green" id="stockSleepProcessAll">پردازش تا تکمیل</button><button class="btn" id="stockSleepRefresh">Refresh وضعیت</button></div><div id="stockSleepMsg" class="mt"></div><div id="stockSleepStatus" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>Snapshotهای اخیر</h5></div><div class="card-body"><div id="stockSleepSnapshots"></div></div></div><div class="card"><div class="card-header"><h5>خلاصه منشأ / تأمین‌کننده</h5></div><div class="card-body"><div id="stockSleepSuppliers"></div><div id="stockSleepLayers" class="mt"></div></div></div></main>`);
    $q('#stockSleepInit').onclick=async()=>{const m=$q('#stockSleepMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postApi('/api/stock-sleep/init',{});m.innerHTML=`<div class="success">Collectionها آماده شد. نسخه: ${htmlSafe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`;}};
    $q('#stockSleepStart').onclick=async()=>{const m=$q('#stockSleepMsg');m.innerHTML='در حال ایجاد Snapshot...';try{const r=await postApi('/api/stock-sleep/start',{fiscalYearStart:$q('#stockSleepFiscal').value||'14050101',maxItems:Number($q('#stockSleepMaxItems').value||10),kardexMaxRows:Number($q('#stockSleepKardexMax').value||80)});window.__stockSleepSnapshotId=r.snapshotId;m.innerHTML=`<div class="success">Snapshot ساخته شد: ${htmlSafe(r.snapshotId)} | queued: ${fmtMoney(r.queued||0)}</div>`;await renderStockSleepStatus(r.snapshotId);await renderStockSleepSnapshots();}catch(e){m.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`;}};
    $q('#stockSleepProcess').onclick=async()=>{const m=$q('#stockSleepMsg');const sid=window.__stockSleepSnapshotId||'';m.innerHTML='در حال پردازش Batch...';try{const r=await postApi('/api/stock-sleep/process',{snapshotId:sid,limit:Number($q('#stockSleepBatchLimit').value||5)});m.innerHTML=`<div class="success">Batch انجام شد. processed: ${fmtMoney(r.processed||0)} | pending: ${fmtMoney(r.counts?.pending||0)} | done: ${fmtMoney(r.counts?.done||0)} | failed: ${fmtMoney(r.counts?.failed||0)}</div>`;await renderStockSleepStatus(r.snapshotId||sid);await renderStockSleepSnapshots();}catch(e){m.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`;}};
    $q('#stockSleepProcessAll').onclick=async()=>{const m=$q('#stockSleepMsg');const sid=window.__stockSleepSnapshotId||'';m.innerHTML='در حال پردازش تا تکمیل... صفحه را نبندید.';try{const r=await postApi('/api/stock-sleep/process-all',{snapshotId:sid,limit:Number($q('#stockSleepBatchLimit').value||5),maxLoops:2000});m.innerHTML=`<div class="success">پردازش کامل شد. loops: ${fmtMoney(r.loops||0)} | processed: ${fmtMoney(r.processed||0)} | pending: ${fmtMoney(r.counts?.pending||0)} | done: ${fmtMoney(r.counts?.done||0)} | failed: ${fmtMoney(r.counts?.failed||0)}</div>`;await renderStockSleepStatus(r.snapshotId||sid);await renderStockSleepSnapshots();}catch(e){m.innerHTML=`<div class="error">${htmlSafe(e.message||e)}</div>`;}};
    $q('#stockSleepRefresh').onclick=async()=>{await renderStockSleepStatus(window.__stockSleepSnapshotId||'');await renderStockSleepSnapshots();};
    await renderStockSleepStatus(''); await renderStockSleepSnapshots();
  };

  const oldRenderMenu = window.renderMenu;
  window.renderMenu = renderMenu = function(){
    const newMenu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['stock-sleep','خواب کالا نماینده'],['supplier-aging','خواب کالا-تأمین‌کننده قدیم'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]];
    let h=''; const role=userRole();
    newMenu.forEach(([g,items])=>{const allowed=items.filter(([id])=>canPage(id)); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);});
    const m=$q('#menu'); if(m){m.innerHTML=h; $qa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});}
    const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${htmlSafe(state.user?.fullName||state.user?.username||'')}<br><small>${htmlSafe(ROLE_LABELS[role]||role)}</small><br><small>${htmlSafe(window.V||'0.9.19.26.3')}</small>`;
  };
  const oldRoute = window.route;
  window.route = route = async function(){
    let p=location.hash.slice(1)||firstAllowedPage();
    if(p==='stock-sleep') return window.pageStockSleep();
    if(oldRoute) return oldRoute.apply(this,arguments);
  };
  try{ renderMenu(); }catch{}
})();

/* 0.9.19.27: Supplier stock sleep rebuilt on purchase invoice layers. UI cleanup: remove old Kardex/stock-sleep test screens. */
(function(){
  const V27='0.9.19.27-purchase-layer-supplier-sleep';
  window.MKCRM_VERSION=V27;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function summaryTable(list, snapshotId){
    if(!list || !list.length) return '<div class="muted">هنوز گزارشی ساخته نشده است.</div>';
    return `<table class="table"><thead><tr><th>تأمین‌کننده / منشأ</th><th>خرید دوره</th><th>مانده موجودی</th><th>سهم از کل</th><th>میانگین سن</th><th>تعداد کالا</th><th>لایه</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodPurchaseValue)}</td><td>${money(x.remainingValue)}</td><td>${safe(x.shareOfTotalInventoryPercent??'')}٪</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.itemCount)}</td><td>${money(x.layerCount)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(snapshotId)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`;
  }
  function snapshotTable(list){
    if(!list || !list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>';
    return `<table class="table"><thead><tr><th>Snapshot</th><th>روش</th><th>فاکتور خرید</th><th>لایه خرید</th><th>ارزش موجودی</th><th>متصل به تأمین‌کننده</th><th>نامشخص/قبل سال</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.snapshotId)}</td><td>${safe(x.mode||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.purchaseLayerCount)}</td><td>${money(x.totalActiveInventoryValue)}</td><td>${money(x.totalAllocatedValue)}</td><td>${money(x.totalUnknownValue)}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;
  }
  async function renderPurchaseSleepSnapshot(sid){
    const sumBox=$s('#psSummary'), layerBox=$s('#psLayers'); if(layerBox) layerBox.innerHTML='';
    try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(sid||'')+'&limit=500'); window.__psSnapshotId=r.snapshotId; if(sumBox) sumBox.innerHTML=summaryTable(r.list||[], r.snapshotId||sid); $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderPurchaseSleepLayers(b.dataset.sid,b.dataset.sup)); }
    catch(e){ if(sumBox) sumBox.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderPurchaseSleepSnapshots(){
    const box=$s('#psSnapshots'); if(!box)return;
    try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderPurchaseSleepSnapshot(b.dataset.id)); }
    catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderPurchaseSleepLayers(snapshotId,supplierAccountNo){
    const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌های خرید...</div>';
    try{ const r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(snapshotId||'')+'&supplierAccountNo='+encodeURIComponent(supplierAccountNo||'')+'&limit=1000'); const list=r.list||[]; box.innerHTML=list.length?`<h4>لایه‌های خرید تأمین‌کننده انتخاب‌شده</h4><table class="table"><thead><tr><th>کالا</th><th>گروه</th><th>فاکتور خرید</th><th>تاریخ خرید</th><th>خرید</th><th>مانده تخصیص‌یافته</th><th>ارزش مانده</th><th>سن</th><th>وضعیت</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td><td>${safe(x.status||'')}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">لایه‌ای برای این فیلتر وجود ندارد.</div>'; }
    catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  window.pageSupplierAging = async function(){
    setPage('خواب کالا تأمین‌کننده', `<main class="main-content">
      <div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - روش جدید بر پایه فاکتور خرید</h5></div><div class="card-body">
        <div class="info">این نسخه دیگر از کاردکس برای تشخیص منشأ استفاده نمی‌کند. فاکتورهای خرید سال جاری خوانده می‌شوند، لایه خرید ساخته می‌شود، سپس موجودی فعال با Reverse FIFO به تأمین‌کننده واقعی وصل می‌شود. مانده خارج از خریدهای دوره جداگانه با عنوان «مانده قبل سال / منشأ نامشخص» نمایش داده می‌شود.</div>
        <div class="row four"><div class="form-group"><label>از تاریخ فاکتور خرید</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ، خالی = همه تا امروز</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر صفحات فاکتور خرید</label><input id="psMaxPages" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر فاکتور، 0 = بدون محدودیت</label><input id="psMaxInvoices" value="0" inputmode="numeric"></div></div>
        <div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn red" id="psBuild">ساخت Snapshot خرید-محور</button><button class="btn" id="psRefresh">نمایش آخرین گزارش</button></div><div id="psMsg" class="mt"></div>
      </div></div>
      <div class="card"><div class="card-header"><h5>Snapshotهای خرید-محور اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div>
      <div class="card"><div class="card-header"><h5>خلاصه تأمین‌کننده / منشأ</h5></div><div class="card-body"><div id="psSummary"></div><div id="psLayers" class="mt"></div></div></div>
    </main>`);
    $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psBuild').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='<div class="info">در حال خواندن فاکتورهای خرید و ساخت لایه‌ها... صفحه را نبندید.</div>';try{const r=await postJson('/api/supplier-sleep/build',{dateFrom:$s('#psDateFrom').value||'14050101',dateTo:$s('#psDateTo').value||'',maxPages:Number($s('#psMaxPages').value||300),maxInvoices:Number($s('#psMaxInvoices').value||0),pageSize:20});const sn=r.snapshot||{};window.__psSnapshotId=sn.snapshotId;m.innerHTML=`<div class="success">Snapshot ساخته شد: ${safe(sn.snapshotId)} | فاکتور خرید: ${money(sn.purchaseInvoicesSynced)} | لایه خرید: ${money(sn.purchaseLayerCount)} | موجودی فعال: ${money(sn.totalActiveInventoryValue)} | متصل به تأمین‌کننده: ${money(sn.totalAllocatedValue)} | نامشخص/قبل سال: ${money(sn.totalUnknownValue)}</div>`; await renderPurchaseSleepSnapshot(sn.snapshotId); await renderPurchaseSleepSnapshots();}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psRefresh').onclick=async()=>{await renderPurchaseSleepSnapshot(window.__psSnapshotId||''); await renderPurchaseSleepSnapshots();};
    await renderPurchaseSleepSnapshots(); await renderPurchaseSleepSnapshot('');
  };
  const oldRenderMenu27=window.renderMenu;
  window.renderMenu=renderMenu=function(){
    const menu27=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]];
    let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu27.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V27}</small>`;
  };
  const oldRoute27=window.route;
  window.route=route=async function(){ const p=location.hash.slice(1)||firstAllowedPage(); if(p==='stock-sleep'){ location.hash='supplier-aging'; return; } if(p==='supplier-aging') return window.pageSupplierAging(); if(oldRoute27) return oldRoute27.apply(this,arguments); };
  try{renderMenu();}catch(e){}
})();

/* 0.9.19.27.1: Supplier-first purchase invoice sleep UI. Removes extra stock-sleep controls; starts from supplier purchase invoices. */
(function(){
  const V271='0.9.19.27.1-purchase-layer-supplier-index-sleep';
  window.MKCRM_VERSION=V271;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function supplierIndexTable(list){
    if(!list||!list.length) return '<div class="muted">هنوز تأمین‌کننده‌ای از فاکتورهای خرید خوانده نشده است.</div>';
    return `<table class="table"><thead><tr><th>تأمین‌کننده</th><th>تعداد فاکتور</th><th>میزان خرید دوره</th><th>SKU</th><th>ردیف کالا</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo||'نامشخص')}<br><small>${safe(x.supplierAccountNo||'')}</small></td><td>${money(x.invoiceCount)}</td><td>${money(x.periodPurchaseValue)}</td><td>${money(x.skuCount)}</td><td>${money(x.itemRows)}</td><td><button class="mini ps-supplier-inv" data-sup="${safe(x.supplierAccountNo||'')}">فاکتورها</button></td></tr>`).join('')}</tbody></table>`;
  }
  function summaryTable(list,snapshotId){
    if(!list||!list.length) return '<div class="muted">هنوز Snapshot تحلیلی ساخته نشده است.</div>';
    return `<table class="table"><thead><tr><th>تأمین‌کننده / منشأ</th><th>خرید دوره</th><th>مانده موجودی</th><th>سهم از کل</th><th>میانگین سن</th><th>رسوب +۳۰ روز</th><th>رسوب +۶۰ روز</th><th>کالا</th><th>لایه</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodPurchaseValue)}</td><td>${money(x.remainingValue)}</td><td>${safe(x.shareOfTotalInventoryPercent??'')}٪</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.staleOver30Value||0)}<br><small>${safe(x.staleOver30Percent??0)}٪</small></td><td>${money(x.staleOver60Value||0)}<br><small>${safe(x.staleOver60Percent??0)}٪</small></td><td>${money(x.itemCount)}</td><td>${money(x.layerCount)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(snapshotId)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`;
  }
  function snapshotTable(list){
    if(!list||!list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>';
    return `<table class="table"><thead><tr><th>Snapshot</th><th>روش</th><th>فاکتور خرید</th><th>لایه خرید</th><th>ارزش موجودی</th><th>متصل به تأمین‌کننده</th><th>نامشخص/قبل سال</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.snapshotId)}</td><td>${safe(x.mode||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.purchaseLayerCount)}</td><td>${money(x.totalActiveInventoryValue)}</td><td>${money(x.totalAllocatedValue)}</td><td>${money(x.totalUnknownValue)}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;
  }
  async function loadSupplierIndex(sync){
    const box=$s('#psSuppliers'), msg=$s('#psMsg'); if(box) box.innerHTML='<div class="info">در حال خواندن فاکتورهای خرید و استخراج تأمین‌کنندگان...</div>';
    const body={sync:!!sync,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxPages:Number($s('#psMaxPages')?.value||300),maxInvoices:Number($s('#psMaxInvoices')?.value||500),maxScanNumbers:Number($s('#psMaxScan')?.value||6000),pageSize:20};
    try{ const r= sync ? await postJson('/api/supplier-sleep/supplier-index', body) : await getJson('/api/supplier-sleep/supplier-index?dateFrom='+encodeURIComponent(body.dateFrom)+'&dateTo='+encodeURIComponent(body.dateTo));
      if(msg) msg.innerHTML=`<div class="success">تأمین‌کننده: ${money(r.supplierCount)} | فاکتور خرید: ${money(r.invoiceCount)} ${r.sync?.fallbackUsed?'| مسیر fallback تابلو/شماره فاکتور استفاده شد':''}</div>`;
      if(box) box.innerHTML=supplierIndexTable(r.list||[]);
      $sa('.ps-supplier-inv').forEach(b=>b.onclick=()=>loadSupplierInvoices(b.dataset.sup));
    }catch(e){ if(box) box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function loadSupplierInvoices(sup){
    const box=$s('#psInvoices'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن فاکتورهای تأمین‌کننده...</div>';
    try{ const qs='?supplierAccountNo='+encodeURIComponent(sup||'')+'&dateFrom='+encodeURIComponent($s('#psDateFrom')?.value||'14050101')+'&dateTo='+encodeURIComponent($s('#psDateTo')?.value||'')+'&limit=500'; const r=await getJson('/api/supplier-sleep/supplier-invoices'+qs); const list=r.list||[];
      box.innerHTML=list.length?`<h4>فاکتورهای خرید تأمین‌کننده انتخاب‌شده</h4><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ</th><th>تعداد ردیف</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(x.rowCount)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">فاکتوری برای این تأمین‌کننده پیدا نشد.</div>';
    }catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderSnapshot(sid){
    const box=$s('#psSummary'); const layer=$s('#psLayers'); if(layer) layer.innerHTML='';
    try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(sid||'')+'&limit=500'); window.__psSnapshotId=r.snapshotId; if(box) box.innerHTML=summaryTable(r.list||[],r.snapshotId||sid); $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup)); }catch(e){ if(box) box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderLayers(sid,sup){
    const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌ها...</div>';
    try{ const r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&limit=1000'); const list=r.list||[]; box.innerHTML=list.length?`<h4>لایه‌های خرید/مانده تأمین‌کننده انتخاب‌شده</h4><table class="table"><thead><tr><th>کالا</th><th>گروه</th><th>فاکتور خرید</th><th>تاریخ</th><th>خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th><th>وضعیت</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td><td>${safe(x.status||'')}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">لایه‌ای وجود ندارد.</div>'; }catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); }catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  window.pageSupplierAging=async function(){
    setPage('خواب کالا تأمین‌کننده', `<main class="main-content">
      <div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - مسیر فاکتور خرید</h5></div><div class="card-body">
        <div class="info">مسیر جدید: اول فاکتورهای خرید سال جاری خوانده می‌شود، تأمین‌کنندگان و میزان خرید دوره لیست می‌شوند، سپس Snapshot لایه خرید ساخته می‌شود و مانده موجودی با Reverse FIFO به تأمین‌کننده وصل می‌شود. شاخص رسوب: بیش از ۳۰ روز و بیش از ۶۰ روز.</div>
        <div class="row five"><div class="form-group"><label>از تاریخ فاکتور خرید</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ، خالی = امروز</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر صفحات تاریخ</label><input id="psMaxPages" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر فاکتور برای خواندن</label><input id="psMaxInvoices" value="500" inputmode="numeric"></div><div class="form-group"><label>حداکثر اسکن شماره فاکتور</label><input id="psMaxScan" value="6000" inputmode="numeric"></div></div>
        <div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psReadSuppliers">خواندن فاکتور خرید و لیست تأمین‌کنندگان</button><button class="btn red" id="psBuild">ساخت Snapshot تحلیلی</button><button class="btn" id="psRefresh">نمایش آخرین گزارش</button></div><div id="psMsg" class="mt"></div>
      </div></div>
      <div class="card"><div class="card-header"><h5>۱) تأمین‌کنندگان دارای خرید از ابتدای سال</h5></div><div class="card-body"><div id="psSuppliers"></div><div id="psInvoices" class="mt"></div></div></div>
      <div class="card"><div class="card-header"><h5>۲) Snapshotهای تحلیلی اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div>
      <div class="card"><div class="card-header"><h5>۳) خلاصه خواب کالا بر اساس تأمین‌کننده</h5></div><div class="card-body"><div id="psSummary"></div><div id="psLayers" class="mt"></div></div></div>
    </main>`);
    $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psReadSuppliers').onclick=()=>loadSupplierIndex(true);
    $s('#psBuild').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='<div class="info">در حال ساخت Snapshot تحلیلی...</div>';try{const r=await postJson('/api/supplier-sleep/build',{dateFrom:$s('#psDateFrom').value||'14050101',dateTo:$s('#psDateTo').value||'',maxPages:Number($s('#psMaxPages').value||300),maxInvoices:Number($s('#psMaxInvoices').value||500),maxScanNumbers:Number($s('#psMaxScan').value||6000),pageSize:20});const sn=r.snapshot||{};window.__psSnapshotId=sn.snapshotId;m.innerHTML=`<div class="success">Snapshot: ${safe(sn.snapshotId)} | فاکتور خرید: ${money(sn.purchaseInvoicesSynced)} | لایه: ${money(sn.purchaseLayerCount)} | موجودی فعال: ${money(sn.totalActiveInventoryValue)} | متصل: ${money(sn.totalAllocatedValue)} | نامشخص/قبل سال: ${money(sn.totalUnknownValue)}</div>`; await renderSnapshot(sn.snapshotId); await renderSnapshots(); await loadSupplierIndex(false);}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psRefresh').onclick=async()=>{await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots(); await loadSupplierIndex(false);};
    await renderSnapshots(); await renderSnapshot(''); await loadSupplierIndex(false);
  };
  window.renderMenu=renderMenu=function(){
    const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]];
    let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V271}</small>`;
  };
  const oldRoute=window.route; window.route=route=async function(){ let p=location.hash.slice(1)||firstAllowedPage(); if(p==='supplier-aging') return window.pageSupplierAging(); if(p==='stock-sleep'){ location.hash='supplier-aging'; return window.pageSupplierAging(); } if(oldRoute) return oldRoute.apply(this,arguments); };
  try{ renderMenu(); }catch{}
})();

/* 0.9.19.27.2: Supplier-selected sleep. Avoids full 500 invoice scan; user searches supplier from accounts, then only selected supplier invoices are analyzed. */
(function(){
  const V272='0.9.19.27.2-selected-supplier-purchase-sleep';
  window.MKCRM_VERSION=V272;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function supplierLabel(x){return `${safe(x.accountName||x.supplierName||'')} ${safe(x.accountNumber||x.supplierNumber||'')}`;}
  function snapshotTable(list){ if(!list||!list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>Snapshot</th><th>روش</th><th>تأمین‌کننده</th><th>فاکتور خرید</th><th>لایه</th><th>موجودی مرتبط</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.snapshotId)}</td><td>${safe(x.mode||'')}</td><td>${safe(x.selectedSupplier?.accountName||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.purchaseLayerCount)}</td><td>${money(x.totalAllocatedValue)}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`; }
  function summaryTable(list,sid){ if(!list||!list.length) return '<div class="muted">خلاصه‌ای وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره</th><th>مانده موجودی مرتبط</th><th>میانگین سن</th><th>رسوب +۳۰ روز</th><th>رسوب +۶۰ روز</th><th>کالا</th><th>لایه</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodPurchaseValue)}</td><td>${money(x.remainingValue)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.staleOver30Value)}<br><small>${safe(x.staleOver30Percent??0)}٪</small></td><td>${money(x.staleOver60Value)}<br><small>${safe(x.staleOver60Percent??0)}٪</small></td><td>${money(x.itemCount)}</td><td>${money(x.layerCount)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(sid)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`; }
  async function searchSuppliers(){
    const q=$s('#psSupplierSearch')?.value||''; const box=$s('#psSupplierResults'); if(!box)return; if(!q.trim()){box.innerHTML='<div class="warn">نام یا کد تأمین‌کننده را وارد کن.</div>';return;}
    box.innerHTML='<div class="info">در حال جستجوی حساب...</div>';
    try{ const r=await getJson('/api/accounts/search?q='+encodeURIComponent(q)+'&limit=20&pages=220'); const list=r.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>کد</th><th>نام حساب</th><th>انتخاب</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountNumber||'')}</td><td>${safe(x.accountName||'')}</td><td><button class="mini ps-select-supplier" data-no="${safe(x.accountNumber||'')}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||x.guId||'')}">انتخاب</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حسابی پیدا نشد.</div>'; $sa('.ps-select-supplier').forEach(b=>b.onclick=()=>{window.__psSelectedSupplier={accountNumber:b.dataset.no,accountName:b.dataset.name,accountGuid:b.dataset.guid}; const s=$s('#psSelectedSupplier'); if(s)s.innerHTML=`<div class="success">تأمین‌کننده انتخاب شد: ${safe(b.dataset.name)} | ${safe(b.dataset.no)}</div>`; loadSelectedSupplierInvoices(false);}); }
    catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}
  }
  async function loadSelectedSupplierInvoices(showMsg=true){
    const sup=window.__psSelectedSupplier||{}; const box=$s('#psInvoices'); const msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(box)box.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>'; return; }
    if(box) box.innerHTML='<div class="info">در حال خواندن فاکتورهای خرید همین تأمین‌کننده از گردش حساب...</div>';
    const body={accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300)};
    try{ const r=await postJson('/api/supplier-sleep/selected-supplier-invoices', body); if(showMsg&&msg) msg.innerHTML=`<div class="success">ردیف گردش حساب: ${money(r.statementRows)} | کاندید شماره فاکتور: ${money(r.invoiceNoCandidates)} | فاکتور خرید معتبر: ${money(r.count)}</div>`; const list=r.list||[]; if(box) box.innerHTML=list.length?`<h4>فاکتورهای خرید تأمین‌کننده انتخاب‌شده</h4><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ</th><th>ردیف کالا</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(x.rowCount)}</td></tr>`).join('')}</tbody></table>`:'<div class="warn">برای این تأمین‌کننده فاکتور خرید معتبر پیدا نشد. اگر مطمئنی خرید دارد، لاگ گردش حساب/شماره فاکتور لازم است.</div>'; }
    catch(e){ if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function buildSelected(){
    const sup=window.__psSelectedSupplier||{}; const msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(msg)msg.innerHTML='<div class="warn">اول تأمین‌کننده را جستجو و انتخاب کن.</div>'; return; }
    if(msg) msg.innerHTML='<div class="info">در حال تحلیل فقط همین تأمین‌کننده...</div>';
    const body={accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300)};
    try{ const r=await postJson('/api/supplier-sleep/build-selected', body); const sn=r.snapshot||{}; window.__psSnapshotId=sn.snapshotId; if(msg) msg.innerHTML=`<div class="success">Snapshot تأمین‌کننده ساخته شد: ${safe(sn.snapshotId)} | فاکتور خرید: ${money(sn.purchaseInvoicesSynced)} | لایه: ${money(sn.purchaseLayerCount)} | مانده مرتبط: ${money(sn.totalAllocatedValue)}</div>`; await renderSnapshot(sn.snapshotId); await renderSnapshots(); }
    catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderSnapshot(sid){ const box=$s('#psSummary'), layer=$s('#psLayers'); if(layer) layer.innerHTML=''; try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(sid||'')+'&limit=100'); window.__psSnapshotId=r.snapshotId; if(box) box.innerHTML=summaryTable(r.list||[],r.snapshotId||sid); $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup)); }catch(e){ if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; } }
  async function renderLayers(sid,sup){ const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌های مانده...</div>'; try{ const r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&limit=2000'); const list=r.list||[]; box.innerHTML=list.length?`<h4>مانده کالا از فاکتورهای خرید تأمین‌کننده</h4><table class="table"><thead><tr><th>کالا</th><th>گروه</th><th>فاکتور</th><th>تاریخ</th><th>خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">مانده‌ای برای این Snapshot پیدا نشد.</div>'; }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  window.pageSupplierAging=async function(){
    setPage('خواب کالا تأمین‌کننده', `<main class="main-content">
      <div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - تحلیل تأمین‌کننده انتخاب‌شده</h5></div><div class="card-body">
        <div class="info">مسیر جدید سنگین نیست: تأمین‌کننده را مثل گردش حساب جستجو و انتخاب کن؛ فقط فاکتورهای خرید همان تأمین‌کننده از ابتدای سال خوانده و تحلیل می‌شود. شاخص رسوب: بیش از ۳۰ روز و بیش از ۶۰ روز.</div>
        <div class="row four"><div class="form-group"><label>از تاریخ خرید</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ، خالی = امروز</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر فاکتور همین تأمین‌کننده</label><input id="psMaxInvoices" value="300" inputmode="numeric"></div><div class="form-group"><label>جستجوی تأمین‌کننده</label><input id="psSupplierSearch" placeholder="مثلاً ماتریس، ماندگار، رایان کاوه"></div></div>
        <div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psSearchBtn">جستجوی تأمین‌کننده</button><button class="btn" id="psReadSelected">خواندن فاکتورهای همین تأمین‌کننده</button><button class="btn red" id="psBuildSelected">تحلیل خواب کالای همین تأمین‌کننده</button><button class="btn" id="psRefresh">نمایش آخرین گزارش</button></div><div id="psMsg" class="mt"></div><div id="psSelectedSupplier" class="mt"></div>
      </div></div>
      <div class="card"><div class="card-header"><h5>۱) انتخاب تأمین‌کننده</h5></div><div class="card-body"><div id="psSupplierResults"></div></div></div>
      <div class="card"><div class="card-header"><h5>۲) فاکتورهای خرید تأمین‌کننده انتخاب‌شده</h5></div><div class="card-body"><div id="psInvoices"></div></div></div>
      <div class="card"><div class="card-header"><h5>۳) Snapshotهای اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div>
      <div class="card"><div class="card-header"><h5>۴) خلاصه و لایه‌های خواب کالا</h5></div><div class="card-body"><div id="psSummary"></div><div id="psLayers" class="mt"></div></div></div>
    </main>`);
    $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psSearchBtn').onclick=searchSuppliers; $s('#psReadSelected').onclick=()=>loadSelectedSupplierInvoices(true); $s('#psBuildSelected').onclick=buildSelected; $s('#psRefresh').onclick=async()=>{await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots();};
    await renderSnapshots(); await renderSnapshot('');
  };
  window.renderMenu=renderMenu=function(){ const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]]; let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V272}</small>`; };
  const oldRoute=window.route; window.route=route=async function(){ let p=location.hash.slice(1)||firstAllowedPage(); if(p==='supplier-aging') return window.pageSupplierAging(); if(p==='stock-sleep'){location.hash='supplier-aging';return window.pageSupplierAging();} if(oldRoute) return oldRoute.apply(this,arguments); };
  try{renderMenu();}catch{}
})();

/* 0.9.19.27.4: Supplier sleep diagnostic pipeline. Shows each stage: supplier, ledger, invoice candidates, getInvoice validation, fallback scan. */
(function(){
  const V274='0.9.19.27.4-supplier-sleep-diagnostic-fallback';
  window.MKCRM_VERSION=V274;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function stageView(diag){
    const stages=(diag&&diag.stages)||[];
    if(!stages.length) return '<div class="muted">Diagnostic مرحله‌ای وجود ندارد.</div>';
    const rows=stages.map((x,i)=>`<tr><td>${i+1}</td><td>${safe(x.stage)}</td><td>${x.ok?'✅':'❌'}</td><td>${money(x.rowCount??x.candidateCount??x.validInvoiceCount??x.count??x.scannedNumbers??'')}</td><td>${safe(x.source||x.error||'')}</td></tr>`).join('');
    const samples=(diag.statementSample||[]).length?`<details class="mt"><summary>نمونه ردیف‌های گردش حساب برای عیب‌یابی</summary><table class="table"><thead><tr><th>#</th><th>کلیدها</th><th>متن خام خلاصه</th></tr></thead><tbody>${diag.statementSample.slice(0,8).map(x=>`<tr><td>${x.index}</td><td>${safe((x.keys||[]).join(', '))}</td><td style="direction:ltr;text-align:left;white-space:normal">${safe(x.text)}</td></tr>`).join('')}</tbody></table></details>`:'';
    const candStage=stages.find(x=>x.stage==='extract-invoice-numbers-from-statement');
    const rowDiag=(candStage&&candStage.rowDiagnostics)||[];
    const cand= rowDiag.length?`<details class="mt"><summary>کاندیدهای استخراج‌شده از گردش</summary><table class="table"><thead><tr><th>کاندیدها</th><th>ردیف خرید؟</th><th>متن ردیف</th></tr></thead><tbody>${rowDiag.slice(0,20).map(x=>`<tr><td>${safe((x.candidates||[]).join(', '))}</td><td>${x.isPurchaseLike?'بله':'خیر'}</td><td style="direction:ltr;text-align:left;white-space:normal">${safe(x.text)}</td></tr>`).join('')}</tbody></table></details>`:'';
    const valStage=stages.find(x=>x.stage==='validate-ledger-candidates-with-getInvoice-3')||{};
    const checked=(valStage.checked||[]);
    const checkedHtml=checked.length?`<details class="mt"><summary>نتیجه تست getInvoice روی شماره‌های کاندید</summary><table class="table"><thead><tr><th>کاندید</th><th>پیدا شد</th><th>شماره فاکتور</th><th>تاریخ</th><th>تأمین‌کننده</th><th>Match</th><th>مبلغ</th></tr></thead><tbody>${checked.slice(0,60).map(x=>`<tr><td>${safe(x.invNo)}</td><td>${x.found?'بله':'خیر'}</td><td>${safe(x.docInvNo||'')}</td><td>${safe(x.invDate||'')}</td><td>${safe((x.supplierAccountNo||'')+' '+(x.supplierName||''))}</td><td>${x.supplierMatch?'✅':'❌'}</td><td>${money(x.totalAmount)}</td></tr>`).join('')}</tbody></table></details>`:'';
    const fb=stages.find(x=>x.stage==='fallback-descending-invoice-scan')||{};
    const fbChecked=(fb.checkedInvoices||[]);
    const fbHtml=fbChecked.length?`<details class="mt"><summary>Fallback: اسکن نزولی فاکتور خرید و تطبیق تأمین‌کننده</summary><table class="table"><thead><tr><th>فاکتور</th><th>تاریخ</th><th>تأمین‌کننده</th><th>Match</th><th>مبلغ</th></tr></thead><tbody>${fbChecked.slice(0,80).map(x=>`<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe((x.supplierAccountNo||'')+' '+(x.supplierName||''))}</td><td>${x.match?'✅':'❌'}</td><td>${money(x.totalAmount)}</td></tr>`).join('')}</tbody></table></details>`:'';
    return `<h4>Diagnostic مرحله‌ای</h4><table class="table"><thead><tr><th>#</th><th>مرحله</th><th>وضعیت</th><th>تعداد/خروجی</th><th>منبع/خطا</th></tr></thead><tbody>${rows}</tbody></table>${samples}${cand}${checkedHtml}${fbHtml}`;
  }
  function snapshotTable(list){ if(!list||!list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>Snapshot</th><th>روش</th><th>تأمین‌کننده</th><th>فاکتور</th><th>لایه</th><th>مانده</th><th>منبع</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.snapshotId)}</td><td>${safe(x.mode||'')}</td><td>${safe(x.selectedSupplier?.accountName||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.purchaseLayerCount)}</td><td>${money(x.totalAllocatedValue)}</td><td>${safe(x.syncSource||'')}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`; }
  function summaryTable(list,sid){ if(!list||!list.length) return '<div class="muted">خلاصه‌ای وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره</th><th>مانده مرتبط</th><th>میانگین سن</th><th>+۳۰ روز</th><th>+۶۰ روز</th><th>کالا</th><th>لایه</th><th>جزئیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodPurchaseValue)}</td><td>${money(x.remainingValue)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.staleOver30Value)}<br><small>${safe(x.staleOver30Percent??0)}٪</small></td><td>${money(x.staleOver60Value)}<br><small>${safe(x.staleOver60Percent??0)}٪</small></td><td>${money(x.itemCount)}</td><td>${money(x.layerCount)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(sid)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`; }
  async function searchSuppliers(){
    const q=$s('#psSupplierSearch')?.value||''; const box=$s('#psSupplierResults'); if(!box)return; if(!q.trim()){box.innerHTML='<div class="warn">نام یا کد تأمین‌کننده را وارد کن.</div>';return;}
    box.innerHTML='<div class="info">در حال جستجوی حساب...</div>';
    try{ const r=await getJson('/api/accounts/search?q='+encodeURIComponent(q)+'&limit=20&pages=220'); const list=r.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>کد</th><th>نام حساب</th><th>انتخاب</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountNumber||'')}</td><td>${safe(x.accountName||'')}</td><td><button class="mini ps-select-supplier" data-no="${safe(x.accountNumber||'')}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||x.guId||'')}">انتخاب</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حسابی پیدا نشد.</div>'; $sa('.ps-select-supplier').forEach(b=>b.onclick=()=>{window.__psSelectedSupplier={accountNumber:b.dataset.no,accountName:b.dataset.name,accountGuid:b.dataset.guid}; const s=$s('#psSelectedSupplier'); if(s)s.innerHTML=`<div class="success">تأمین‌کننده انتخاب شد: ${safe(b.dataset.name)} | ${safe(b.dataset.no)}</div>`; const inv=$s('#psInvoices'); if(inv)inv.innerHTML='<div class="muted">حالا دکمه «خواندن مرحله‌ای فاکتورهای خرید» را بزن.</div>';}); }
    catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}
  }
  async function readSelected(){
    const sup=window.__psSelectedSupplier||{}; const box=$s('#psInvoices'); const msg=$s('#psMsg'); const diagBox=$s('#psDiagnostics'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(box)box.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>'; return; }
    if(box) box.innerHTML='<div class="info">در حال اجرای مراحل: گردش حساب → استخراج شماره فاکتور → تست getInvoice → fallback در صورت نیاز...</div>';
    if(diagBox) diagBox.innerHTML='';
    const body={accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300),maxScanNumbers:Number($s('#psMaxScan')?.value||6000),maxSalePages:Number($s('#psMaxSalePages')?.value||600)};
    try{ const r=await postJson('/api/supplier-sleep/selected-supplier-invoices', body); window.__psLastReadResult=r; if(msg) msg.innerHTML=`<div class="success">گردش: ${money(r.statementRows)} | کاندید: ${money(r.invoiceNoCandidates)} | فاکتور خرید معتبر: ${money(r.count)} | منبع: ${safe(r.source||'')} ${r.fallbackUsed?'| fallback فعال شد':''}</div>`; const list=r.list||[]; if(box) box.innerHTML=list.length?`<h4>فاکتورهای خرید معتبر تأمین‌کننده</h4><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ</th><th>ردیف کالا</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(x.rowCount)}</td></tr>`).join('')}</tbody></table>`:'<div class="warn">فاکتور خرید معتبر پیدا نشد. Diagnostic پایین را بررسی کن؛ اگر گردش شماره فاکتور ندارد، باید از fallback scan یا endpoint جایگزین استفاده شود.</div>'; if(diagBox) diagBox.innerHTML=stageView(r.diagnostics||{}); }
    catch(e){ if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function buildSelected(){
    const sup=window.__psSelectedSupplier||{}; const msg=$s('#psMsg'); const diagBox=$s('#psDiagnostics'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(msg)msg.innerHTML='<div class="warn">اول تأمین‌کننده را جستجو و انتخاب کن.</div>'; return; }
    if(msg) msg.innerHTML='<div class="info">در حال ساخت Snapshot همین تأمین‌کننده...</div>';
    const body={accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300),maxScanNumbers:Number($s('#psMaxScan')?.value||6000),maxSalePages:Number($s('#psMaxSalePages')?.value||600)};
    try{ const r=await postJson('/api/supplier-sleep/build-selected', body); const sn=r.snapshot||{}; window.__psSnapshotId=sn.snapshotId; if(msg) msg.innerHTML=`<div class="success">Snapshot ساخته شد: ${safe(sn.snapshotId)} | فاکتور: ${money(sn.purchaseInvoicesSynced)} | لایه: ${money(sn.purchaseLayerCount)} | مانده مرتبط: ${money(sn.totalAllocatedValue)} | منبع: ${safe(sn.syncSource||'')}</div>`; if(diagBox&&sn.diagnostics) diagBox.innerHTML=stageView(sn.diagnostics); await renderSnapshot(sn.snapshotId); await renderSnapshots(); }
    catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderSnapshot(sid){ const box=$s('#psSummary'), layer=$s('#psLayers'); if(layer)layer.innerHTML=''; try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(sid||'')+'&limit=100'); window.__psSnapshotId=r.snapshotId; if(box) box.innerHTML=summaryTable(r.list||[],r.snapshotId||sid); $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup)); }catch(e){ if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; } }
  async function renderLayers(sid,sup){ const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌ها...</div>'; try{ const r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&limit=2000'); const list=r.list||[]; box.innerHTML=list.length?`<h4>لایه‌های مانده تأمین‌کننده</h4><table class="table"><thead><tr><th>کالا</th><th>گروه</th><th>فاکتور</th><th>تاریخ</th><th>خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">مانده‌ای برای این Snapshot پیدا نشد.</div>'; }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  window.pageSupplierAging=async function(){
    setPage('خواب کالا تأمین‌کننده', `<main class="main-content">
      <div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - Diagnostic مرحله‌ای</h5></div><div class="card-body">
        <div class="info">این نسخه هر مرحله را جدا نشان می‌دهد: انتخاب تأمین‌کننده، خواندن گردش، استخراج شماره فاکتور، تست getInvoice، و fallback اسکن نزولی. تا وقتی فاکتور خرید معتبر پیدا نشود، تحلیل مانده قابل اتکا نیست.</div>
        <div class="row four"><div class="form-group"><label>از تاریخ خرید</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ، خالی = امروز</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر فاکتور همین تأمین‌کننده</label><input id="psMaxInvoices" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر اسکن fallback</label><input id="psMaxScan" value="6000" inputmode="numeric"></div></div>
        <div class="row two"><div class="form-group"><label>جستجوی تأمین‌کننده</label><input id="psSupplierSearch" placeholder="مثلاً ماتریس، ماندگار، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="psSearchBtn">جستجوی تأمین‌کننده</button></div></div>
        <div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psReadSelected">خواندن مرحله‌ای فاکتورهای خرید</button><button class="btn red" id="psBuildSelected">تحلیل خواب کالای همین تأمین‌کننده</button><button class="btn" id="psRefresh">نمایش آخرین گزارش</button></div><div id="psMsg" class="mt"></div><div id="psSelectedSupplier" class="mt"></div>
      </div></div>
      <div class="card"><div class="card-header"><h5>۱) انتخاب تأمین‌کننده</h5></div><div class="card-body"><div id="psSupplierResults"></div></div></div>
      <div class="card"><div class="card-header"><h5>۲) فاکتورهای خرید استخراج‌شده</h5></div><div class="card-body"><div id="psInvoices"></div></div></div>
      <div class="card"><div class="card-header"><h5>۳) Diagnostic مراحل</h5></div><div class="card-body"><div id="psDiagnostics"></div></div></div>
      <div class="card"><div class="card-header"><h5>۴) Snapshotهای اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div>
      <div class="card"><div class="card-header"><h5>۵) خلاصه و لایه‌های خواب کالا</h5></div><div class="card-body"><div id="psSummary"></div><div id="psLayers" class="mt"></div></div></div>
    </main>`);
    $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psSearchBtn').onclick=searchSuppliers; $s('#psReadSelected').onclick=readSelected; $s('#psBuildSelected').onclick=buildSelected; $s('#psRefresh').onclick=async()=>{await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots();};
    await renderSnapshots(); await renderSnapshot('');
  };
  window.renderMenu=renderMenu=function(){ const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]]; let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V274}</small>`; };
  const oldRoute=window.route; window.route=route=async function(){ let p=location.hash.slice(1)||firstAllowedPage(); if(p==='supplier-aging') return window.pageSupplierAging(); if(p==='stock-sleep'){location.hash='supplier-aging';return window.pageSupplierAging();} if(oldRoute) return oldRoute.apply(this,arguments); };
  try{renderMenu();}catch{}
})();

/* 0.9.19.27.5: Supplier sleep reconciliation validation. Accounting invoice total is separated from goods-layer total. */
(function(){
  const V275='0.9.19.27.5-supplier-sleep-reconciliation-validation';
  window.MKCRM_VERSION=V275;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function statusBadge(st){ const s=String(st||''); const cls=s.startsWith('OK')?'success':(s.startsWith('WARN')||s.includes('RISK')||s.includes('PARTIAL')?'warn':(s.startsWith('FAIL')||s.includes('MISSING')?'error':'info')); return `<span class="${cls}">${safe(s||'نامشخص')}</span>`; }
  function stageView(diag){
    const stages=diag?.stages||[];
    if(!stages.length) return '<div class="muted">Diagnostic مرحله‌ای وجود ندارد.</div>';
    const rows=stages.map((x,i)=>`<tr><td>${i+1}</td><td>${safe(x.stage||'')}</td><td>${x.ok?'<span class="success">OK</span>':'<span class="warn">بررسی</span>'}</td><td>${money(x.rowCount??x.candidateCount??x.validInvoiceCount??x.count??x.scannedNumbers??'')}</td><td style="white-space:normal">${safe(x.source||x.error||'')}</td></tr>`).join('');
    const checked=(stages.find(x=>x.stage==='validate-ledger-candidates-with-getInvoice-3')?.checked)||[];
    const checkedHtml=checked.length?`<details class="mt"><summary>اعتبارسنجی کاندیدهای فاکتور</summary><table class="table"><thead><tr><th>کاندید</th><th>پیدا شد</th><th>تطبیق تأمین‌کننده</th><th>تأمین‌کننده فاکتور</th><th>مبلغ</th></tr></thead><tbody>${checked.slice(0,80).map(x=>`<tr><td>${safe(x.invNo)}</td><td>${x.found?'بله':'خیر'}</td><td>${x.supplierMatch?'بله':'خیر'}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td></tr>`).join('')}</tbody></table></details>`:'';
    return `<h4>Diagnostic مرحله‌ای</h4><table class="table"><thead><tr><th>#</th><th>مرحله</th><th>وضعیت</th><th>تعداد/خروجی</th><th>منبع/خطا</th></tr></thead><tbody>${rows}</tbody></table>${checkedHtml}`;
  }
  function summaryTable(list,snapshotId){
    if(!list||!list.length) return '<div class="muted">هنوز Snapshot تحلیلی ساخته نشده است.</div>';
    return `<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره حسابداری</th><th>خرید کالایی تحلیل‌شده</th><th>اختلاف</th><th>وضعیت اعتبار</th><th>مانده موجودی</th><th>میانگین سن</th><th>رسوب +۳۰</th><th>رسوب +۶۰</th><th>لایه‌ها</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodInvoiceTotalValue ?? x.periodPurchaseValue)}</td><td>${money(x.periodLayerGoodsValue ?? x.periodPurchaseValue)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td>${money(x.remainingValue)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.staleOver30Value||0)}</td><td>${money(x.staleOver60Value||0)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(snapshotId)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`;
  }
  function snapshotTable(list){
    if(!list||!list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>';
    return `<table class="table"><thead><tr><th>Snapshot</th><th>روش</th><th>فاکتور</th><th>جمع فاکتورها</th><th>جمع لایه‌ها</th><th>اختلاف</th><th>وضعیت</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.snapshotId)}</td><td>${safe(x.mode||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.periodInvoiceTotalValue||0)}</td><td>${money(x.periodLayerGoodsValue||0)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;
  }
  function invoiceTable(list, rec){
    if(!list||!list.length) return '<div class="warn">فاکتور خرید معتبر پیدا نشد.</div>';
    const recMap=new Map((rec?.invoices||[]).map(x=>[Number(x.invNo),x]));
    const total=list.reduce((s,x)=>s+Number(x.totalAmount||0),0);
    return `<h4>فاکتورهای خرید معتبر تأمین‌کننده</h4><div class="info">جمع فاکتورهای معتبر: <b>${money(total)}</b></div><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th>ردیف</th></tr></thead><tbody>${list.map(x=>{const r=recMap.get(Number(x.invNo))||x; return `<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(r.layerValue||x.layerValue||0)}</td><td>${money(r.difference||x.difference||0)}<br><small>${safe(r.differencePercent||x.differencePercent||0)}٪</small></td><td>${statusBadge(r.status||x.reconciliationStatus||'در انتظار Snapshot')}</td><td>${money(x.rowCount)} / ${money(r.layerCount||x.layerCount||0)}</td></tr>`}).join('')}</tbody></table>`;
  }
  async function searchSuppliers(){
    const q=($s('#psSupplierSearch')?.value||'').trim(); const box=$s('#psSupplierResults'); if(!box)return; if(q.length<2){box.innerHTML='<div class="warn">حداقل دو حرف یا کد وارد کن.</div>';return;}
    box.innerHTML='<div class="info">در حال جستجوی حساب...</div>';
    try{ const r=await getJson('/api/accounts/search?q='+encodeURIComponent(q)+'&limit=20&pages=220'); const list=r.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>کد</th><th>نام حساب</th><th>انتخاب</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountNumber||'')}</td><td>${safe(x.accountName||'')}</td><td><button class="mini ps-select-supplier" data-no="${safe(x.accountNumber||'')}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||x.guId||'')}">انتخاب</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حسابی پیدا نشد.</div>'; $sa('.ps-select-supplier').forEach(b=>b.onclick=()=>{window.__psSelectedSupplier={accountNumber:b.dataset.no,accountName:b.dataset.name,accountGuid:b.dataset.guid}; const s=$s('#psSelectedSupplier'); if(s)s.innerHTML=`<div class="success">تأمین‌کننده انتخاب شد: ${safe(b.dataset.name)} | ${safe(b.dataset.no)}</div>`; const inv=$s('#psInvoices'); if(inv)inv.innerHTML='<div class="muted">حالا «خواندن مرحله‌ای فاکتورهای خرید» را بزن.</div>';}); }
    catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  function selectedBody(){ const sup=window.__psSelectedSupplier||{}; return {accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300),maxScanNumbers:Number($s('#psMaxScan')?.value||6000),maxSalePages:Number($s('#psMaxSalePages')?.value||600)}; }
  async function readSelected(){
    const sup=window.__psSelectedSupplier||{}; const box=$s('#psInvoices'); const msg=$s('#psMsg'); const diagBox=$s('#psDiagnostics'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(box)box.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>'; return; }
    if(box) box.innerHTML='<div class="info">در حال خواندن گردش، استخراج شماره فاکتور و اعتبارسنجی getInvoice...</div>'; if(diagBox)diagBox.innerHTML='';
    try{ const r=await postJson('/api/supplier-sleep/selected-supplier-invoices', selectedBody()); window.__psLastReadResult=r; if(msg) msg.innerHTML=`<div class="success">گردش: ${money(r.statementRows)} | کاندید: ${money(r.invoiceNoCandidates)} | فاکتور معتبر: ${money(r.count)} | منبع: ${safe(r.source||'')}</div>`; if(box) box.innerHTML=invoiceTable(r.list||[], null); if(diagBox) diagBox.innerHTML=stageView(r.diagnostics||{}); }
    catch(e){ if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function buildSelected(){
    const sup=window.__psSelectedSupplier||{}; const msg=$s('#psMsg'); const diagBox=$s('#psDiagnostics'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(msg)msg.innerHTML='<div class="warn">اول تأمین‌کننده را جستجو و انتخاب کن.</div>'; return; }
    if(msg) msg.innerHTML='<div class="info">در حال ساخت Snapshot با کنترل صحت فاکتور/لایه...</div>';
    try{ const r=await postJson('/api/supplier-sleep/build-selected', selectedBody()); const sn=r.snapshot||{}; window.__psSnapshotId=sn.snapshotId; if(msg) msg.innerHTML=`<div class="success">Snapshot: ${safe(sn.snapshotId)} | خرید دوره حسابداری: ${money(sn.periodInvoiceTotalValue)} | خرید کالایی تحلیل‌شده: ${money(sn.periodLayerGoodsValue)} | اختلاف: ${money(sn.periodReconciliationDiff)} (${safe(sn.periodReconciliationDiffPercent||0)}٪) | وضعیت: ${safe(sn.reconciliationStatus||'')}</div>`; const inv=$s('#psInvoices'); if(inv) inv.innerHTML=invoiceTable(r.invoices||[], r.reconciliation||{}); if(diagBox&&sn.diagnostics) diagBox.innerHTML=stageView(sn.diagnostics); await renderSnapshot(sn.snapshotId); await renderSnapshots(); }
    catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderSnapshot(sid){ const box=$s('#psSummary'), layer=$s('#psLayers'); if(layer)layer.innerHTML=''; try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(sid||'')+'&limit=100'); window.__psSnapshotId=r.snapshotId; if(box) box.innerHTML=summaryTable(r.list||[],r.snapshotId||sid); $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup)); }catch(e){ if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; } }
  async function renderLayers(sid,sup){ const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌ها...</div>'; try{ const r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&limit=2000'); const list=r.list||[]; box.innerHTML=list.length?`<h4>لایه‌های مانده تأمین‌کننده</h4><table class="table"><thead><tr><th>کالا</th><th>گروه</th><th>فاکتور</th><th>تاریخ</th><th>خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">مانده‌ای برای این Snapshot پیدا نشد.</div>'; }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  window.pageSupplierAging=async function(){
    setPage('خواب کالا تأمین‌کننده', `<main class="main-content">
      <div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - Reconciliation فاکتور/لایه</h5></div><div class="card-body">
        <div class="info">قانون نسخه جدید: «خرید دوره حسابداری» از جمع فاکتورهای خرید معتبر می‌آید؛ «خرید کالایی تحلیل‌شده» از جمع لایه‌های کالا. اختلاف به‌صورت فاکتور به فاکتور نمایش داده می‌شود تا هزینه/کرایه/تخفیف یا ردیف ناقص مشخص شود.</div>
        <div class="row four"><div class="form-group"><label>از تاریخ خرید</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ، خالی = امروز</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر فاکتور همین تأمین‌کننده</label><input id="psMaxInvoices" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر اسکن fallback</label><input id="psMaxScan" value="6000" inputmode="numeric"></div></div>
        <div class="row two"><div class="form-group"><label>جستجوی تأمین‌کننده</label><input id="psSupplierSearch" placeholder="مثلاً ماتریس، ماندگار، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="psSearchBtn">جستجوی تأمین‌کننده</button></div></div>
        <div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psReadSelected">خواندن مرحله‌ای فاکتورهای خرید</button><button class="btn red" id="psBuildSelected">تحلیل و کنترل صحت</button><button class="btn" id="psRefresh">نمایش آخرین گزارش</button></div><div id="psMsg" class="mt"></div><div id="psSelectedSupplier" class="mt"></div>
      </div></div>
      <div class="card"><div class="card-header"><h5>۱) انتخاب تأمین‌کننده</h5></div><div class="card-body"><div id="psSupplierResults"></div></div></div>
      <div class="card"><div class="card-header"><h5>۲) فاکتورهای خرید و کنترل فاکتور/لایه</h5></div><div class="card-body"><div id="psInvoices"></div></div></div>
      <div class="card"><div class="card-header"><h5>۳) Diagnostic مراحل</h5></div><div class="card-body"><div id="psDiagnostics"></div></div></div>
      <div class="card"><div class="card-header"><h5>۴) Snapshotهای اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div>
      <div class="card"><div class="card-header"><h5>۵) خلاصه و لایه‌های خواب کالا</h5></div><div class="card-body"><div id="psSummary"></div><div id="psLayers" class="mt"></div></div></div>
    </main>`);
    $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $s('#psSearchBtn').onclick=searchSuppliers; $s('#psReadSelected').onclick=readSelected; $s('#psBuildSelected').onclick=buildSelected; $s('#psRefresh').onclick=async()=>{await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots();};
    await renderSnapshots(); await renderSnapshot('');
  };
  window.renderMenu=renderMenu=function(){ const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]]; let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V275}</small>`; };
  const oldRoute=window.route; window.route=route=async function(){ let p=location.hash.slice(1)||firstAllowedPage(); if(p==='supplier-aging') return window.pageSupplierAging(); if(p==='stock-sleep'){location.hash='supplier-aging';return window.pageSupplierAging();} if(oldRoute) return oldRoute.apply(this,arguments); };
  try{renderMenu();}catch{}
})();

/* 0.9.19.28: Supplier sleep LayerId + invoice/group dashboard. */
(function(){
  const V276='0.9.19.33-supplier-profit-diagnostic-snapshot-label';
  window.MKCRM_VERSION=V276;
  const $s=q=>document.querySelector(q); const $sa=q=>Array.from(document.querySelectorAll(q));
  const safe=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=v=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function statusBadge(st){ const s=String(st||''); const cls=s.startsWith('OK')?'success':(s.startsWith('WARN')||s.includes('RISK')||s.includes('PARTIAL')?'warn':(s.startsWith('FAIL')||s.includes('MISSING')?'error':'info')); return `<span class="${cls}">${safe(s||'نامشخص')}</span>`; }
  function selectedBody(){ const sup=window.__psSelectedSupplier||{}; return {accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300),maxScanNumbers:Number($s('#psMaxScan')?.value||6000),maxSalePages:Number($s('#psMaxSalePages')?.value||600)}; }
  function summaryTable(list,sid){ if(!list||!list.length) return '<div class="muted">هنوز Snapshot تحلیلی ساخته نشده است.</div>'; return `<h4>داشبورد مدیریتی تأمین‌کننده</h4><table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره حسابداری</th><th>خرید کالایی تحلیل‌شده</th><th>اختلاف</th><th>اعتبار</th><th>مانده</th><th>گردش</th><th>رسوب +۳۰</th><th>رسوب +۶۰</th><th>سود/ROI</th><th>لایه</th></tr></thead><tbody>${list.map(x=>{const sold=Math.max(0,Number(x.periodLayerGoodsValue||0)-Number(x.remainingValue||0)); return `<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodInvoiceTotalValue??x.periodPurchaseValue)}</td><td>${money(x.periodLayerGoodsValue??x.periodPurchaseValue)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td>${money(x.remainingValue)}</td><td>${safe(x.periodLayerGoodsValue?pct(sold,x.periodLayerGoodsValue):0)}٪</td><td>${money(x.staleOver30Value||0)}</td><td>${money(x.staleOver60Value||0)}</td><td>${money(x.estimatedProfitAmount||0)}<br><small>ROI: ${x.roiPercent==null?'نامشخص':safe(x.roiPercent+'٪')} | ${safe(x.profitStatus||'')}</small></td><td><button class="mini ps-layer-btn" data-sid="${safe(sid)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`}).join('')}</tbody></table>`; }
  function pct(a,b){return b?Math.round(Number(a||0)*10000/Number(b||1))/100:0}
  function invoiceDashboard(list){ if(!list||!list.length) return '<div class="muted">خلاصه فاکتورها ساخته نشده است.</div>'; return `<h4>مانده واقعی هر فاکتور خرید</h4><table class="table"><thead><tr><th>فاکتور</th><th>تاریخ</th><th>خرید کالایی</th><th>مانده</th><th>گردش</th><th>رسوب +۳۰</th><th>رسوب +۶۰</th><th>اعتبار</th><th>سود/ROI</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.purchaseInvoiceNo)}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.layerPurchaseValue)}</td><td>${money(x.remainingValue)}<br><small>${safe(x.remainingPercent||0)}٪</small></td><td>${safe(x.turnoverPercent||0)}٪</td><td>${money(x.staleOver30Value||0)}</td><td>${money(x.staleOver60Value||0)}</td><td>${statusBadge(x.validationStatus||'')}</td><td>${money(x.estimatedProfitAmount||0)}<br><small>فروش: ${money(x.saleValue||0)} | ROI: ${x.roiPercent==null?'نامشخص':safe(x.roiPercent+'٪')}<br>${safe(x.profitStatus||'')}</small></td></tr>`).join('')}</tbody></table>`; }
  function groupDashboard(list){ if(!list||!list.length) return '<div class="muted">گزارش گروه اصلی کالا ساخته نشده است.</div>'; const opts=['<option value="">همه گروه‌های اصلی</option>'].concat(list.map(x=>`<option value="${safe(x.mainGroupCode||'__UNKNOWN__')}">${safe(x.mainGroup||x.mainGroupCode||'نامشخص')}</option>`)).join(''); return `<h4>گزارش گروه اصلی کالا</h4><div class="row two"><div class="form-group"><label>فیلتر گروه اصلی</label><select id="psMainGroupFilter">${opts}</select><div class="small muted">مثلاً گروه اصلی 1 / Notebook را انتخاب کن تا فقط مانده همان گروه برای این تأمین‌کننده دیده شود.</div></div></div><table class="table" id="psGroupTable"><thead><tr><th>گروه اصلی</th><th>خرید گروه</th><th>مانده گروه</th><th>گردش</th><th>کالا</th><th>فاکتور</th><th>رسوب +۳۰</th><th>رسوب +۶۰</th><th>میانگین سن</th><th>سود/ROI</th></tr></thead><tbody>${list.map(x=>`<tr data-main-group="${safe(x.mainGroupCode||'__UNKNOWN__')}"><td>${safe(x.mainGroup||'نامشخص')}</td><td>${money(x.purchaseValue)}</td><td>${money(x.remainingValue)}<br><small>${safe(x.remainingPercent||0)}٪</small></td><td>${safe(x.turnoverPercent||0)}٪</td><td>${money(x.itemCount)}</td><td>${money(x.invoiceCount)}</td><td>${money(x.staleOver30Value||0)}</td><td>${money(x.staleOver60Value||0)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.estimatedProfitAmount||0)}<br><small>فروش: ${money(x.saleValue||0)} | ROI: ${x.roiPercent==null?'نامشخص':safe(x.roiPercent+'٪')}<br>${safe(x.profitStatus||'')}</small></td></tr>`).join('')}</tbody></table>`; }
  function invoiceTable(list, rec){ if(!list||!list.length) return '<div class="warn">فاکتور خرید معتبر پیدا نشد.</div>'; const recMap=new Map((rec?.invoices||[]).map(x=>[Number(x.invNo),x])); const total=list.reduce((s,x)=>s+Number(x.totalAmount||0),0); return `<h4>فاکتورهای خرید معتبر تأمین‌کننده</h4><div class="info">جمع فاکتورهای معتبر: <b>${money(total)}</b></div><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th>ردیف</th></tr></thead><tbody>${list.map(x=>{const r=recMap.get(Number(x.invNo))||x; return `<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(r.layerValue||x.layerValue||0)}</td><td>${money(r.difference||x.difference||0)}<br><small>${safe(r.differencePercent||x.differencePercent||0)}٪</small></td><td>${statusBadge(r.status||x.reconciliationStatus||'در انتظار Snapshot')}</td><td>${money(x.rowCount)} / ${money(r.layerCount||x.layerCount||0)}</td></tr>`}).join('')}</tbody></table>`; }
  function stageView(diag){ const stages=diag?.stages||[]; if(!stages.length) return '<div class="muted">Diagnostic مرحله‌ای وجود ندارد.</div>'; return `<h4>Diagnostic مرحله‌ای</h4><table class="table"><thead><tr><th>#</th><th>مرحله</th><th>وضعیت</th><th>تعداد/خروجی</th><th>منبع/خطا</th></tr></thead><tbody>${stages.map((x,i)=>`<tr><td>${i+1}</td><td>${safe(x.stage||'')}</td><td>${x.ok?'<span class="success">OK</span>':'<span class="warn">بررسی</span>'}</td><td>${money(x.rowCount??x.candidateCount??x.validInvoiceCount??x.count??x.scannedNumbers??'')}</td><td style="white-space:normal">${safe(x.source||x.error||'')}</td></tr>`).join('')}</tbody></table>`; }
  async function searchSuppliers(){ const q=($s('#psSupplierSearch')?.value||'').trim(); const box=$s('#psSupplierResults'); if(!box)return; if(q.length<2){box.innerHTML='<div class="warn">حداقل دو حرف یا کد وارد کن.</div>';return;} box.innerHTML='<div class="info">در حال جستجوی حساب...</div>'; try{ const r=await getJson('/api/accounts/search?q='+encodeURIComponent(q)+'&limit=20&pages=220'); const list=r.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>کد</th><th>نام حساب</th><th>انتخاب</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountNumber||'')}</td><td>${safe(x.accountName||'')}</td><td><button class="mini ps-select-supplier" data-no="${safe(x.accountNumber||'')}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||x.guId||'')}">انتخاب</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حسابی پیدا نشد.</div>'; $sa('.ps-select-supplier').forEach(b=>b.onclick=()=>{window.__psSelectedSupplier={accountNumber:b.dataset.no,accountName:b.dataset.name,accountGuid:b.dataset.guid}; const s=$s('#psSelectedSupplier'); if(s)s.innerHTML=`<div class="success">تأمین‌کننده انتخاب شد: ${safe(b.dataset.name)} | ${safe(b.dataset.no)}</div>`;}); }catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function readSelected(){ const sup=window.__psSelectedSupplier||{}; const box=$s('#psInvoices'), msg=$s('#psMsg'), diag=$s('#psDiagnostics'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(box)box.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>'; return;} if(box)box.innerHTML='<div class="info">در حال خواندن گردش و فاکتورها...</div>'; try{const r=await postJson('/api/supplier-sleep/selected-supplier-invoices',selectedBody()); window.__psLastReadResult=r; if(msg)msg.innerHTML=`<div class="success">گردش: ${money(r.statementRows)} | کاندید: ${money(r.invoiceNoCandidates)} | فاکتور معتبر: ${money(r.count)} | منبع: ${safe(r.source||'')}</div>`; if(box)box.innerHTML=invoiceTable(r.list||[],null); if(diag)diag.innerHTML=stageView(r.diagnostics||{});}catch(e){if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function buildSelected(){ const sup=window.__psSelectedSupplier||{}, msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){if(msg)msg.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>';return;} if(msg)msg.innerHTML='<div class="info">Job خواب کالا در پس‌زمینه شروع می‌شود...</div>'; try{const r=await postJson('/api/supplier-sleep/build-selected-job',selectedBody()); const jobId=r.jobId||''; if(msg)msg.innerHTML=`<div class="info">Job ثبت شد: ${safe(jobId)} | وضعیت در حال بررسی...</div>`; let done=null; for(let i=0;i<180;i++){ await new Promise(res=>setTimeout(res,2000)); const st=await getJson('/api/jobs/status?jobId='+encodeURIComponent(jobId)); const job=st.job||{}; if(msg)msg.innerHTML=`<div class="info">Job: ${safe(jobId)} | وضعیت: ${safe(job.status||'')} ${job.result?.snapshotId?('| Snapshot: '+safe(job.result.snapshotId)):''}</div>`; if(['completed','failed','max_pages_reached'].includes(job.status)){done=job;break;} } if(done&&done.status==='completed'){ const sid=done.result?.snapshotId||''; window.__psSnapshotId=sid; if(msg)msg.innerHTML=`<div class="success">Snapshot ساخته شد: ${safe(sid)} | وضعیت: ${safe(done.status)}</div>`; await renderSnapshot(sid); await renderSnapshots(); } else if(done){ if(msg)msg.innerHTML=`<div class="error">Job ناموفق شد: ${safe(done.error||done.result?.error||done.status)}</div>`; } else { if(msg)msg.innerHTML='<div class="warn">Job هنوز تمام نشده است؛ از وضعیت Job یا Refresh استفاده کن.</div>'; } }catch(e){if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderSnapshot(sid){ const sum=$s('#psSummary'), inv=$s('#psInvoiceSummary'), grp=$s('#psGroupSummary'), layer=$s('#psLayers'); if(layer)layer.innerHTML=''; try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(sid||'')+'&limit=100'); const realSid=r.snapshotId||sid||''; window.__psSnapshotId=realSid; if(sum)sum.innerHTML=summaryTable(r.list||[],realSid); const sup=(r.list&&r.list[0]&&r.list[0].supplierAccountNo)||''; if(inv){ const ir=await getJson('/api/supplier-sleep/invoice-summary?snapshotId='+encodeURIComponent(realSid)+'&supplierAccountNo='+encodeURIComponent(sup)+'&limit=500'); inv.innerHTML=invoiceDashboard(ir.list||[]);} if(grp){ const gr=await getJson('/api/supplier-sleep/group-summary?snapshotId='+encodeURIComponent(realSid)+'&supplierAccountNo='+encodeURIComponent(sup)+'&limit=300'); grp.innerHTML=groupDashboard(gr.list||[]); const gf=$s('#psMainGroupFilter'); if(gf){gf.onchange=()=>{const v=gf.value; $sa('#psGroupTable tbody tr').forEach(tr=>{tr.style.display=(!v||tr.dataset.mainGroup===v)?'':'none';});};}} $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup)); await renderProfitDiagnostics(realSid); }catch(e){ if(sum)sum.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderLayers(sid,sup){ const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌ها...</div>'; try{ const r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&limit=2000'); const list=r.list||[]; box.innerHTML=list.length?`<h4>لایه‌های خرید / مانده بر اساس LayerId</h4><table class="table"><thead><tr><th>LayerId</th><th>کالا</th><th>گروه</th><th>فاکتور</th><th>تاریخ</th><th>خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th></tr></thead><tbody>${list.map(x=>`<tr><td><small>${safe(x.layerId||x.persistentLayerId||'')}</small></td><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">مانده‌ای برای این Snapshot پیدا نشد.</div>'; }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  function profitDiagnosticView(d){ if(!d)return '<div class="muted">سود تأمین‌کننده در این نسخه عمداً متوقف است. ابتدا Sale Snapshot را بسازید.</div>'; const s=d.saleRead||{}, g=d.globalAllocation||{}, p=d.profitMatch||{}; const pd=p.diagnostic||{}; return `<h4>وضعیت سود تأمین‌کننده</h4><table class="table"><tbody><tr><td>فاکتور فروش اسکن‌شده</td><td>${money(s.scannedInvoices||0)}</td><td>Body فروش خوانده‌شده</td><td>${money(s.detailFetched||0)}</td></tr><tr><td>ردیف Body فروش parsed</td><td>${money(s.saleBodyRowsParsed||0)}</td><td>ردیف فروش مرتبط با کالاهای هدف</td><td>${money(s.saleRows||0)}</td></tr><tr><td>فاکتور خرید اسکن‌شده برای لایه‌های جهانی</td><td>${money(g.scannedNumbers||0)}</td><td>لایه خرید جهانی</td><td>${money(g.globalLayerCount||0)}</td></tr><tr><td>تخصیص سود به LayerId منتخب</td><td>${money(p.allocations||0)}</td><td>ردیف فروش بدون match</td><td>${money(p.unmatched||0)}</td></tr><tr><td>Hit روی لایه تأمین‌کننده انتخابی</td><td>${money(pd.selectedLayerHits||0)}</td><td>Hit روی سایر تأمین‌کننده‌ها</td><td>${money(pd.nonSelectedLayerHits||0)}</td></tr></tbody></table><details><summary>جزئیات عدم Match</summary><pre class="prewrap">${safe(JSON.stringify({unmatchedReasons:pd.unmatchedReasons||{}, unmatchedSample:p.unmatchedSample||[], errors:s.errors||[]},null,2))}</pre></details><div id="saleSellerDetailBox" class="mt"></div>`; }
  async function renderProfitDiagnostics(sid){ const box=$s('#psProfitDiag'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/profit-diagnostics?snapshotId='+encodeURIComponent(sid||'')); box.innerHTML=profitDiagnosticView(r.diagnostics); }catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; } }
  function snapshotTable(list){ if(!list||!list.length)return '<div class="muted">Snapshot قبلی وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>گزارش</th><th>کد Snapshot</th><th>روش</th><th>فاکتور</th><th>جمع فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${safe(x.snapshotLabel||((x.supplierDisplayName||x.selectedSupplier?.accountName||'تأمین‌کننده')+' - '+(x.reportJalaliDate||'')))}</b></td><td><small>${safe(x.snapshotId)}</small></td><td>${safe(x.mode||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.periodInvoiceTotalValue||0)}</td><td>${money(x.periodLayerGoodsValue||0)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`; }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  window.pageSupplierAging=async function(){ setPage('خواب کالا تأمین‌کننده',`<main class="main-content"><div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - LayerId / Dashboard</h5></div><div class="card-body"><div class="info">این نسخه فازهای ماقبل سود را نگه می‌دارد: فاکتور خرید، Reconciliation، LayerId، مانده واقعی، گروه اصلی و True Reverse FIFO. محاسبه سود تأمین‌کننده فعلاً متوقف است تا Sale Snapshot مستقل کامل و تست شود.</div><div class="row four"><div class="form-group"><label>از تاریخ خرید/فروش</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر فاکتور خرید</label><input id="psMaxInvoices" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر اسکن خرید</label><input id="psMaxScan" value="6000" inputmode="numeric"></div></div><div class="row two"><div class="form-group"><label>جستجوی تأمین‌کننده</label><input id="psSupplierSearch" placeholder="مثلاً ماتریس، ماندگار، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="psSearchBtn">جستجوی تأمین‌کننده</button></div></div><div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psReadSelected">خواندن مرحله‌ای فاکتورهای خرید</button><button class="btn red" id="psBuildSelected">تحلیل و کنترل صحت</button><button class="btn" id="psRefresh">نمایش آخرین گزارش</button></div><div id="psMsg" class="mt"></div><div id="psSelectedSupplier" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>۱) انتخاب تأمین‌کننده</h5></div><div class="card-body"><div id="psSupplierResults"></div></div></div><div class="card"><div class="card-header"><h5>۲) فاکتورهای خرید و Reconciliation</h5></div><div class="card-body"><div id="psInvoices"></div></div></div><div class="card"><div class="card-header"><h5>۳) Diagnostic مراحل</h5></div><div class="card-body"><div id="psDiagnostics"></div></div></div><div class="card"><div class="card-header"><h5>۴) Snapshotهای اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div><div class="card"><div class="card-header"><h5>۵) داشبورد مدیریتی تأمین‌کننده</h5></div><div class="card-body"><div id="psSummary"></div></div></div><div class="card"><div class="card-header"><h5>۶) مانده واقعی هر فاکتور خرید</h5></div><div class="card-body"><div id="psInvoiceSummary"></div></div></div><div class="card"><div class="card-header"><h5>۷) گزارش گروه اصلی کالا</h5></div><div class="card-body"><div id="psGroupSummary"></div></div></div><div class="card"><div class="card-header"><h5>۸) لایه‌های Purchase Layer</h5></div><div class="card-body"><div id="psProfitDiag"></div><div id="psLayers"></div></div></div></main>`); $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}}; $s('#psSearchBtn').onclick=searchSuppliers; $s('#psReadSelected').onclick=readSelected; $s('#psBuildSelected').onclick=buildSelected; $s('#psRefresh').onclick=async()=>{await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots();}; await renderSnapshots(); await renderSnapshot(''); };
  window.renderMenu=renderMenu=function(){ const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]]; let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V276}</small>`; };
  const oldRoute=window.route; window.route=route=async function(){ let p=location.hash.slice(1)||(typeof firstAllowedPage==='function'?firstAllowedPage():'dashboard'); if(p==='supplier-aging') return window.pageSupplierAging(); if(p==='stock-sleep'){location.hash='supplier-aging';return window.pageSupplierAging();} if(oldRoute) return oldRoute.apply(this,arguments); };
  try{renderMenu();}catch{}
})();

/* 0.9.19.34: Sale Snapshot Engine UI + pre-profit supplier sleep wording */
(function(){
  const V34='0.9.19.43-seller-performance-fifo-profit-diagnostic';
  const $q=s=>document.querySelector(s); const $qa=s=>[...document.querySelectorAll(s)];
  const safe=v=>{try{return esc(v==null?'':String(v));}catch{return String(v??'')}};
  const money=v=>{try{return fmt(v||0);}catch{return Number(v||0).toLocaleString('fa-IR')}};
  async function getJson(url){ const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||'خطا'); return j; }
  async function postJson(url,body){ const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||'خطا'); return j; }
  function saleSnapshotTable(list){
    if(!list||!list.length) return '<div class="muted">Sale Snapshot قبلی وجود ندارد.</div>';
    return `<table class="table"><thead><tr><th>Snapshot</th><th>وضعیت</th><th>بازه</th><th>صفحه</th><th>حالت</th><th>فاکتور فروش</th><th>Body خوانده‌شده</th><th>ردیف کالا</th><th>Body خالی</th><th>فروش نوع ۲</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><small>${safe(x.snapshotId)}</small><br>${safe(String(x.createdAt||'').slice(0,19).replace('T',' '))}</td><td>${safe(x.status||'')}</td><td>${safe(x.dateFrom||'')} تا ${safe(x.dateTo||'')}</td><td>${money(x.pagesScanned||0)}</td><td>${safe(x.mode||(x.incremental?'new':'full'))}</td><td>${money(x.invoiceHeadersFound||0)}</td><td>${money(x.invoiceBodiesLoaded||0)}</td><td>${money(x.saleLinesParsed||0)}</td><td>${money(x.emptyBodyInvoices||0)}</td><td>${money((x.typeStats&&x.typeStats['2']&&x.typeStats['2'].invoices)||0)}</td><td><button class="mini sale-snap-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;
  }
  async function renderSaleSnapshotStatus(snapshotId=''){
    const box=$q('#saleSnapStatus'); if(!box)return;
    try{
      const r=await getJson('/api/sale-snapshot/status'+(snapshotId?'?snapshotId='+encodeURIComponent(snapshotId):''));
      const x=r.snapshot; if(!x){box.innerHTML='<div class="muted">هنوز Snapshot فروش ساخته نشده است.</div>';return;}
      box.innerHTML=`<h4>وضعیت Sale Snapshot</h4><table class="table"><tbody><tr><td>Snapshot</td><td><small>${safe(x.snapshotId)}</small></td><td>وضعیت</td><td>${safe(x.status||'')}</td></tr><tr><td>حالت</td><td>${x.incremental?'فقط فاکتورهای جدید':'اسکن کامل'}</td><td>روش</td><td>${safe(x.mode||'')}</td></tr><tr><td>فاکتور فروش Header</td><td>${money(x.invoiceHeadersFound||0)}</td><td>Body فروش خوانده‌شده</td><td>${money(x.invoiceBodiesLoaded||0)}</td></tr><tr><td>ردیف کالای فروش</td><td>${money(x.saleLinesParsed||0)}</td><td>Body خالی</td><td>${money(x.emptyBodyInvoices||0)}</td></tr><tr><td>صفحات اسکن‌شده</td><td>${money(x.pagesScanned||0)}</td><td>Detail Fetch</td><td>${money(x.detailFetched||0)}</td></tr><tr><td>فروش واقعی Type 2</td><td>${money((x.typeStats&&x.typeStats['2']&&x.typeStats['2'].invoices)||0)} فاکتور / ${money((x.typeStats&&x.typeStats['2']&&x.typeStats['2'].lines)||0)} ردیف</td><td>برگشت‌ها</td><td>Type 6 برگشت از فروش و Type 7 برگشت از خرید فعلاً در فروش خالص اعمال نشده‌اند.</td></tr></tbody></table><h4>اتصال فروش به نماینده / صندوق</h4><table class="table"><thead><tr><th>نام نماینده</th><th>کد نماینده</th><th>فروشگاه/صندوق</th><th>فاکتور</th><th>ردیف</th><th>مبلغ</th></tr></thead><tbody>${((x.sellerStats||[]).slice(0,20).map(s=>`<tr><td><button class="mini sale-seller-detail" data-seller="${safe(s.sellerAccountNumber||'')}">${safe(s.sellerName||s.sellerAccountName||s.key||'نامشخص')}</button></td><td>${safe(s.sellerAccountNumber||'')}</td><td>${safe(s.sellerStoreName||'')}<br>${safe(s.cashboxAccountName||'')}</td><td>${money(s.invoices||0)}</td><td>${money(s.lines||0)}</td><td>${money(s.amount||0)}</td></tr>`).join(''))||'<tr><td colspan="6" class="muted">هنوز اطلاعات نماینده ساخته نشده است.</td></tr>'}</tbody></table><details><summary>نمونه و خطاها</summary><pre class="prewrap">${safe(JSON.stringify({samples:x.samples||[], errors:x.errors||[], diagnostics:r.diagnostics||null},null,2))}</pre></details><div id="saleSellerDetailBox" class="mt"></div>`;
      $qa('.sale-seller-detail').forEach(b=>b.onclick=async()=>{const seller=b.dataset.seller||''; const out=$q('#saleSellerDetailBox'); if(!seller){out.innerHTML='<div class="error">کد نماینده خالی است.</div>';return;} out.innerHTML='<div class="info">در حال خواندن عملکرد نماینده...</div>'; try{const r=await getJson('/api/sale-snapshot/seller-performance?sellerAccountNumber='+encodeURIComponent(seller)+'&dateFrom='+encodeURIComponent($q('#saleSnapFrom')?.value||'')+'&dateTo='+encodeURIComponent($q('#saleSnapTo')?.value||'')); out.innerHTML=`<h4>عملکرد نماینده: ${safe((r.invoices&&r.invoices[0]&&r.invoices[0].sellerName)||seller)}</h4><table class="table"><tbody><tr><td>تعداد فاکتور</td><td>${money(r.invoiceCount||0)}</td><td>ردیف فروش</td><td>${money(r.lineCount||0)}</td></tr><tr><td>عدد فروش</td><td>${money(r.totalSales||0)}</td><td>سود/ROI</td><td>${safe(r.profitStatus||'')} | سود: ${money(r.fifoProfit||r.estimatedProfit||0)} | ROI: ${r.roiPercent==null?'نامشخص':safe(r.roiPercent)+'%'}</td></tr><tr><td>بهای FIFO</td><td>${money(r.fifoCost||0)}</td><td>وضعیت ردیف‌ها</td><td>محاسبه‌شده: ${money((r.profitLineStats||{}).calculated||0)} | ناقص: ${money((r.profitLineStats||{}).partial||0)} | نامشخص: ${money((r.profitLineStats||{}).unknown||0)}</td></tr></tbody></table><h4>گروه اصلی کالا</h4><table class="table"><thead><tr><th>گروه</th><th>فاکتور</th><th>ردیف</th><th>مبلغ</th><th>بهای FIFO</th><th>سود</th><th>ROI</th><th>وضعیت</th></tr></thead><tbody>${(r.groups||[]).map(g=>`<tr><td>${safe(g.mainGroup||'نامشخص')}</td><td>${money(g.invoiceCount||0)}</td><td>${money(g.lines||0)}</td><td>${money(g.amount||0)}</td><td>${money(g.fifoCost||0)}</td><td>${money(g.fifoProfit||0)}</td><td>${g.roiPercent==null?'نامشخص':safe(g.roiPercent)+'%'}</td><td>${safe(g.profitStatus||'')}</td></tr>`).join('')}</tbody></table><details><summary>Diagnostic سود FIFO</summary><pre class="prewrap">${safe(JSON.stringify(r.profitDiagnostics||{},null,2))}</pre></details><h4>شماره فاکتورها</h4><table class="table"><thead><tr><th>تاریخ</th><th>نوع</th><th>شماره</th><th>ردیف</th><th>مبلغ</th><th>صندوق</th></tr></thead><tbody>${(r.invoices||[]).map(x=>`<tr><td>${safe(x.saleDate||'')}</td><td>${safe(x.saleInvoiceType||'')}</td><td>${safe(x.saleInvoiceNo||'')}</td><td>${money(x.lines||0)}</td><td>${money(x.amount||0)}</td><td>${safe(x.cashboxAccountName||'')}</td></tr>`).join('')}</tbody></table>`;}catch(e){out.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}});
    }catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function renderSaleSnapshots(){
    const box=$q('#saleSnapList'); if(!box)return;
    try{ const r=await getJson('/api/sale-snapshot/snapshots?limit=15'); box.innerHTML=saleSnapshotTable(r.list||[]); $qa('.sale-snap-pick').forEach(b=>b.onclick=()=>renderSaleSnapshotStatus(b.dataset.id)); }
    catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; }
  }
  async function waitForSaleSnapshotJob(jobId,m){
    for(let i=0;i<600;i++){
      await new Promise(resolve=>setTimeout(resolve,2000));
      const r=await getJson('/api/jobs/status?jobId='+encodeURIComponent(jobId)); const job=r.job||{};
      m.innerHTML=`<div class="info">Sale Snapshot Job: ${safe(jobId)} | وضعیت: ${safe(job.status||'')} | مرحله: ${safe(job.phase||'')}</div>`;
      if(job.status==='completed') return job.result||{};
      if(job.status==='failed'||job.status==='cancelled') throw new Error(job.error||job.status);
    }
    throw new Error('Sale Snapshot job is still running; use Refresh to check its status.');
  }
  window.pageSaleSnapshot=async function(){
    setPage('Sale Snapshot', `<main class="main-content"><div class="card"><div class="card-header"><h5>Sale Snapshot - زیرساخت فروش برای سود، عملکرد فروشنده و پیش‌بینی بازار</h5></div><div class="card-body"><div class="info">این فاز فقط فروش‌ها را از شایگان می‌خواند و در Mongo ذخیره می‌کند. محاسبه سود تأمین‌کننده عمداً متوقف است. این نسخه فروش واقعی را فقط با InvoiceType=2 می‌خواند. نگاشت صحیح شایگان: 2=فروش، 3=خرید، 6=برگشت از فروش، 7=برگشت از خرید. برگشت‌ها فعلاً فقط در طراحی بعدی فروش خالص/خرید خالص لحاظ می‌شوند.</div><div class="row four"><div class="form-group"><label>از تاریخ فروش</label><input id="saleSnapFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ</label><input id="saleSnapTo" value=""></div><div class="form-group"><label>حداکثر صفحات فروش</label><input id="saleSnapPages" value="300" inputmode="numeric"></div><div class="form-group"><label>RowCount ثابت</label><input id="saleSnapDetails" value="20" inputmode="numeric" disabled><div class="small muted">WebService حداکثر ۲۰ ردیف در هر صفحه می‌دهد.</div></div></div><div class="form-group"><label><input type="checkbox" id="saleSnapReset"> بازسازی کامل از ابتدا (معمولاً خاموش بماند)</label></div><div class="actions"><button class="btn green" id="saleSnapInit">آماده‌سازی</button><button class="btn red" id="saleSnapStart">ساخت Sale Snapshot</button><button class="btn" id="saleSnapRefresh">Refresh</button></div><div id="saleSnapMsg" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>Snapshotهای فروش</h5></div><div class="card-body"><div id="saleSnapList"></div></div></div><div class="card"><div class="card-header"><h5>Diagnostic فروش</h5></div><div class="card-body"><div id="saleSnapStatus"></div></div></div></main>`);
    $q('#saleSnapInit').onclick=async()=>{const m=$q('#saleSnapMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/sale-snapshot/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $q('#saleSnapStart').onclick=async()=>{const m=$q('#saleSnapMsg');m.innerHTML='<div class="info">Job ساخت Sale Snapshot در حال ثبت است...</div>';try{const started=await postJson('/api/sale-snapshot/start',{dateFrom:$q('#saleSnapFrom').value,dateTo:$q('#saleSnapTo').value,maxPages:Number($q('#saleSnapPages').value||300),maxDetailInvoices:Number($q('#saleSnapDetails').value||0),reset:!!$q('#saleSnapReset')?.checked});const r=await waitForSaleSnapshotJob(started.jobId,m);m.innerHTML=`<div class="success">Sale Snapshot ساخته شد: ${safe(r.snapshotId)} | حالت: ${safe(r.mode||'')} | فاکتور: ${money(r.invoiceHeadersFound)} | Body: ${money(r.invoiceBodiesLoaded)} | ردیف فروش: ${money(r.saleLinesParsed)}</div>`;await renderSaleSnapshots();await renderSaleSnapshotStatus(r.snapshotId);}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}};
    $q('#saleSnapRefresh').onclick=async()=>{await renderSaleSnapshots();await renderSaleSnapshotStatus('');};
    await renderSaleSnapshots(); await renderSaleSnapshotStatus('');
  };
  const prevMenu=window.renderMenu;
  window.renderMenu=renderMenu=function(){
    const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['sale-snapshot','Sale Snapshot'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]];
    let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$q('#menu'); if(m){m.innerHTML=h; $qa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V34}</small>`;
  };
  const prevRoute=window.route;
  window.route=route=async function(){ const p=location.hash.slice(1)||(typeof firstAllowedPage==='function'?firstAllowedPage():'dashboard'); if(p==='sale-snapshot') return window.pageSaleSnapshot(); if(prevRoute) return prevRoute.apply(this,arguments); };
})();

/* 0.9.19.47: Supplier Sleep unified stable UI after detached jobs.
   Keeps 0.9.19.46 detached jobs and fixes post-snapshot report rendering.

   Previous UI used the purchase-invoice validation table for invoice sleep summary,
   so fields like purchaseInvoiceNo/invoiceTotal/remainingValue were shown as empty dots.
   This patch restores distinct tables for: valid purchase invoices, invoice remaining, groups, and layers.

   0.9.19.46 note:

   Fixes two operational defects:
   1) selected supplier purchase invoice reading was still a page-bound HTTP request;
   2) build analysis UI treated long-running jobs as stuck after a fixed polling window.
*/
(function(){
  const V46='0.9.19.47-supplier-sleep-unified-stable-ui';
  window.MKCRM_VERSION=V46;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function statusBadge(st){ const s=String(st||''); const cls=s==='completed'||s.startsWith('OK')?'success':(s==='failed'||s.includes('FAIL')?'error':(s==='running'||s==='queued'?'info':'warn')); return `<span class="${cls}">${safe(s||'نامشخص')}</span>`; }
  function stageView(diag){
    const stages=diag?.stages||[];
    if(!stages.length) return '<div class="muted">Diagnostic مرحله‌ای وجود ندارد.</div>';
    const rows=stages.map((x,i)=>`<tr><td>${i+1}</td><td>${safe(x.stage||'')}</td><td>${x.ok?'<span class="success">OK</span>':'<span class="warn">بررسی</span>'}</td><td>${money(x.rowCount??x.candidateCount??x.validInvoiceCount??x.count??x.scannedNumbers??'')}</td><td style="white-space:normal">${safe(x.source||x.error||'')}</td></tr>`).join('');
    const checked=(stages.find(x=>x.stage==='validate-ledger-candidates-with-getInvoice-3')?.checked)||[];
    const checkedHtml=checked.length?`<details class="mt"><summary>اعتبارسنجی کاندیدهای فاکتور</summary><table class="table"><thead><tr><th>کاندید</th><th>پیدا شد</th><th>تطبیق تأمین‌کننده</th><th>تأمین‌کننده فاکتور</th><th>مبلغ</th></tr></thead><tbody>${checked.slice(0,80).map(x=>`<tr><td>${safe(x.invNo)}</td><td>${x.found?'بله':'خیر'}</td><td>${x.supplierMatch?'بله':'خیر'}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td></tr>`).join('')}</tbody></table></details>`:'';
    return `<h4>Diagnostic مرحله‌ای</h4><table class="table"><thead><tr><th>#</th><th>مرحله</th><th>وضعیت</th><th>تعداد/خروجی</th><th>منبع/خطا</th></tr></thead><tbody>${rows}</tbody></table>${checkedHtml}`;
  }
  function invoiceTable(list, rec){
    if(!list||!list.length) return '<div class="warn">فاکتور خرید معتبر پیدا نشد.</div>';
    const recMap=new Map((rec?.invoices||[]).map(x=>[Number(x.invNo),x]));
    const total=list.reduce((s,x)=>s+Number(x.totalAmount||0),0);
    return `<h4>فاکتورهای خرید معتبر تأمین‌کننده</h4><div class="info">جمع فاکتورهای معتبر: <b>${money(total)}</b></div><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th>ردیف</th></tr></thead><tbody>${list.map(x=>{const r=recMap.get(Number(x.invNo))||x; return `<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(r.layerValue||x.layerValue||0)}</td><td>${money(r.difference||x.difference||0)}<br><small>${safe(r.differencePercent||x.differencePercent||0)}٪</small></td><td>${statusBadge(r.status||x.reconciliationStatus||'در انتظار Snapshot')}</td><td>${money(x.rowCount)} / ${money(r.layerCount||x.layerCount||0)}</td></tr>`}).join('')}</tbody></table>`;
  }
  function invoiceSleepTable(list){
    if(!list||!list.length) return '<div class="muted">مانده فاکتوری برای این Snapshot ثبت نشده است.</div>';
    const totalRemaining=list.reduce((s,x)=>s+Number(x.remainingValue||0),0);
    const totalInvoice=list.reduce((s,x)=>s+Number(x.invoiceTotal||x.totalAmount||0),0);
    return `<h4>مانده واقعی هر فاکتور خرید</h4><div class="info">جمع مبلغ فاکتورها: <b>${money(totalInvoice)}</b> | جمع مانده متصل: <b>${money(totalRemaining)}</b></div><table class="table"><thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ فاکتور</th><th>جمع خرید کالایی</th><th>مانده</th><th>درصد مانده</th><th>تعداد کالا/لایه</th><th>میانگین سن</th><th>وضعیت</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.purchaseInvoiceNo||x.invNo||'')}</td><td>${safe(x.purchaseDate||x.invDate||'')}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.invoiceTotal||x.totalAmount||0)}</td><td>${money(x.layerPurchaseValue||x.layerValue||0)}</td><td>${money(x.remainingValue||0)}<br><small>تعداد: ${money(x.remainingQty||0)}</small></td><td>${safe(x.remainingPercent??0)}٪</td><td>${money(x.itemCount||0)} / ${money(x.layerCount||0)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${statusBadge(x.validationStatus||x.reconciliationStatus||'')}</td></tr>`).join('')}</tbody></table>`;
  }
  function snapshotTable(list){
    if(!list||!list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>';
    return `<table class="table"><thead><tr><th>گزارش</th><th>کد Snapshot</th><th>روش</th><th>فاکتور</th><th>جمع فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${safe(x.snapshotLabel||((x.supplierDisplayName||x.selectedSupplier?.accountName||'تأمین‌کننده')+' - '+(x.reportJalaliDate||'')))}</b></td><td><small>${safe(x.snapshotId)}</small></td><td>${safe(x.mode||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.periodInvoiceTotalValue||0)}</td><td>${money(x.periodLayerGoodsValue||0)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button></td></tr>`).join('')}</tbody></table>`;
  }
  function summaryTable(list,snapshotId){
    if(!list||!list.length) return '<div class="muted">هنوز Snapshot تحلیلی ساخته نشده است.</div>';
    return `<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره حسابداری</th><th>خرید کالایی تحلیل‌شده</th><th>اختلاف</th><th>وضعیت اعتبار</th><th>مانده موجودی</th><th>میانگین سن</th><th>رسوب +۳۰</th><th>رسوب +۶۰</th><th>لایه‌ها</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodInvoiceTotalValue ?? x.periodPurchaseValue)}</td><td>${money(x.periodLayerGoodsValue ?? x.periodPurchaseValue)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td>${money(x.remainingValue)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.staleOver30Value||0)}</td><td>${money(x.staleOver60Value||0)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(snapshotId)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`;
  }
  function selectedBody(){ const sup=window.__psSelectedSupplier||{}; return {accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300),maxScanNumbers:Number($s('#psMaxScan')?.value||6000)}; }
  function setJob(type, jobId){ try{ localStorage.setItem(type==='read'?'mkcrm_supplier_sleep_read_job':'mkcrm_supplier_sleep_build_job', jobId||''); }catch{} }
  function getJob(type){ try{return localStorage.getItem(type==='read'?'mkcrm_supplier_sleep_read_job':'mkcrm_supplier_sleep_build_job')||'';}catch{return '';} }
  function clearJob(type){ try{ localStorage.removeItem(type==='read'?'mkcrm_supplier_sleep_read_job':'mkcrm_supplier_sleep_build_job'); }catch{} }
  async function jobStatus(jobId){ const st=await getJson('/api/jobs/status?jobId='+encodeURIComponent(jobId)); return st.job||null; }
  function jobLine(job){ return `Job: <small>${safe(job?.jobId||'')}</small> | وضعیت: ${statusBadge(job?.status||'')} | مرحله: ${safe(job?.phase||'')}`; }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=10'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderLayers(sid,sup){
    const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌ها...</div>';
    try{
      let url='/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&limit=2000';
      let r=await getJson(url); let list=r.list||[];
      if(!list.length && sup){ r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&limit=2000'); list=r.list||[]; }
      box.innerHTML=list.length?`<h4>لایه‌های Purchase Layer / مانده تأمین‌کننده</h4><table class="table"><thead><tr><th>LayerId</th><th>کالا</th><th>گروه</th><th>فاکتور خرید</th><th>تاریخ خرید</th><th>تعداد خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th><th>روش تخصیص</th></tr></thead><tbody>${list.map(x=>`<tr><td><small>${safe(x.layerId||x.persistentLayerId||'')}</small></td><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||x.mainGroupName||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td><td><small>${safe(x.allocationMethod||x.status||'')}</small></td></tr>`).join('')}</tbody></table>`:'<div class="muted">مانده‌ای برای این Snapshot پیدا نشد. اگر داشبورد مانده دارد اما این جدول خالی است، باید داده collection supplierPurchaseLayers بررسی شود.</div>';
    }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}
  }
  async function renderSnapshot(sid){
    const sum=$s('#psSummary'), inv=$s('#psInvoiceSummary'), grp=$s('#psGroupSummary'); let realSid=sid||'';
    try{
      const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(realSid)+'&limit=500');
      realSid=r.snapshotId||realSid; window.__psSnapshotId=realSid;
      if(sum)sum.innerHTML=summaryTable(r.list||[],realSid);
      $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup));
      const ri=await getJson('/api/supplier-sleep/invoice-summary?snapshotId='+encodeURIComponent(realSid)+'&limit=800');
      if(inv)inv.innerHTML=invoiceSleepTable(ri.list||[]);
      const rg=await getJson('/api/supplier-sleep/group-summary?snapshotId='+encodeURIComponent(realSid)+'&limit=300');
      if(grp)grp.innerHTML=(rg.list||[]).length?`<table class="table"><thead><tr><th>گروه اصلی</th><th>تعداد کالا</th><th>لایه</th><th>خرید کالایی</th><th>مانده</th><th>ارزش مانده</th><th>درصد مانده</th><th>میانگین سن</th></tr></thead><tbody>${(rg.list||[]).map(x=>`<tr><td>${safe(x.mainGroup||x.mainGroupName||'نامشخص')}</td><td>${money(x.itemCount||0)}</td><td>${money(x.layerCount||0)}</td><td>${money(x.purchaseValue||0)}</td><td>${money(x.remainingQty||0)}</td><td>${money(x.remainingValue||0)}</td><td>${safe(x.remainingPercent??0)}٪</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td></tr>`).join('')}</tbody></table>`:'<div class="muted">گزارش گروه اصلی وجود ندارد.</div>';
    }catch(e){ if(sum)sum.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}
  }
  async function searchSuppliers(){ const q=($s('#psSupplierSearch')?.value||'').trim(); const box=$s('#psSupplierResults'); if(!box)return; if(q.length<2){box.innerHTML='<div class="warn">حداقل دو حرف یا کد وارد کن.</div>';return;} box.innerHTML='<div class="info">در حال جستجوی حساب...</div>'; try{ const r=await getJson('/api/accounts/search?q='+encodeURIComponent(q)+'&limit=20&pages=220'); const list=r.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>کد</th><th>نام حساب</th><th>انتخاب</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountNumber||'')}</td><td>${safe(x.accountName||'')}</td><td><button class="mini ps-select-supplier" data-no="${safe(x.accountNumber||'')}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||x.guId||'')}">انتخاب</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حسابی پیدا نشد.</div>'; $sa('.ps-select-supplier').forEach(b=>b.onclick=()=>{window.__psSelectedSupplier={accountNumber:b.dataset.no,accountName:b.dataset.name,accountGuid:b.dataset.guid}; const s=$s('#psSelectedSupplier'); if(s)s.innerHTML=`<div class="success">تأمین‌کننده انتخاب شد: ${safe(b.dataset.name)} | ${safe(b.dataset.no)}</div>`; const inv=$s('#psInvoices'); if(inv)inv.innerHTML='<div class="muted">حالا «خواندن مرحله‌ای فاکتورهای خرید» را بزن. این مرحله از نسخه 46 به Job پس‌زمینه‌ای تبدیل شده است.</div>';}); } catch(e){ box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; } }
  async function checkReadJob(showIfMissing=false){ const msg=$s('#psMsg'), box=$s('#psInvoices'), diag=$s('#psDiagnostics'); const jobId=getJob('read'); if(!jobId){ if(showIfMissing&&msg)msg.innerHTML='<div class="muted">Job خواندن فعالی ثبت نشده است.</div>'; return null; } try{ const job=await jobStatus(jobId); if(!job){ if(msg)msg.innerHTML='<div class="warn">Job خواندن پیدا نشد.</div>'; return null; } if(msg)msg.innerHTML=`<div class="info">${jobLine(job)}</div>`; if(job.status==='completed'){ const r=job.result||{}; if(msg)msg.innerHTML=`<div class="success">خواندن فاکتورهای خرید کامل شد: گردش ${money(r.statementRows)} | کاندید ${money(r.invoiceNoCandidates)} | فاکتور معتبر ${money(r.count)} | منبع: ${safe(r.source||'')}</div>`; if(box)box.innerHTML=invoiceTable(r.list||[],null); if(diag)diag.innerHTML=stageView(r.diagnostics||{}); clearJob('read'); return job; } if(job.status==='failed'){ if(box)box.innerHTML=`<div class="error">Job خواندن ناموفق شد: ${safe(job.error||job.result?.error||'')}</div>`; clearJob('read'); return job; } if(box)box.innerHTML=`<div class="info">خواندن فاکتورهای خرید در پس‌زمینه ادامه دارد. ترک صفحه دیگر نباید آن را متوقف کند.<br>${jobLine(job)}</div>`; return job; }catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; return null; } }
  async function readSelected(){ const sup=window.__psSelectedSupplier||{}; const box=$s('#psInvoices'), msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(box)box.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>'; return;} if(box)box.innerHTML='<div class="info">Job خواندن فاکتورهای خرید در پس‌زمینه ثبت می‌شود...</div>'; try{const r=await postJson('/api/supplier-sleep/selected-supplier-invoices-job',selectedBody()); setJob('read',r.jobId||''); if(msg)msg.innerHTML=`<div class="info">Job خواندن ثبت شد: <small>${safe(r.jobId||'')}</small>. می‌توانی صفحه را ترک کنی و بعداً Refresh بزنی.</div>`; await checkReadJob(false);}catch(e){if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function checkBuildJob(showIfMissing=false){ const msg=$s('#psMsg'); const jobId=getJob('build'); if(!jobId){ if(showIfMissing&&msg)msg.innerHTML='<div class="muted">Job تحلیل فعالی ثبت نشده است.</div>'; return null; } try{ const job=await jobStatus(jobId); if(!job){ if(msg)msg.innerHTML='<div class="warn">Job تحلیل پیدا نشد.</div>'; return null; } if(msg)msg.innerHTML=`<div class="info">${jobLine(job)}</div>`; if(job.status==='completed'){ const sid=job.result?.snapshotId||''; window.__psSnapshotId=sid; if(msg)msg.innerHTML=`<div class="success">تحلیل کامل شد. Snapshot: ${safe(sid)} | فاکتور: ${money(job.result?.purchaseInvoicesSynced||0)} | لایه: ${money(job.result?.purchaseLayerCount||0)} | مانده مرتبط: ${money(job.result?.totalAllocatedValue||0)} | نامشخص: ${money(job.result?.totalUnknownValue||0)}</div>`; clearJob('build'); await renderSnapshot(sid); await renderSnapshots(); return job; } if(job.status==='failed'){ if(msg)msg.innerHTML=`<div class="error">Job تحلیل ناموفق شد: ${safe(job.error||job.result?.error||'')}</div>`; clearJob('build'); return job; } if(msg)msg.innerHTML=`<div class="info">تحلیل هنوز در حال اجراست و به صفحه وابسته نیست. بعداً Refresh/نمایش وضعیت Job را بزن.<br>${jobLine(job)}</div>`; return job; }catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; return null; } }
  async function buildSelected(){ const sup=window.__psSelectedSupplier||{}, msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){if(msg)msg.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>';return;} if(getJob('read')){ const readJob=await checkReadJob(false); if(readJob && ['queued','running'].includes(readJob.status)){ if(msg)msg.innerHTML='<div class="warn">خواندن فاکتورهای خرید هنوز تمام نشده است. تحلیل تا تکمیل مرحله خواندن شروع نمی‌شود.</div>'; return; } if(readJob && readJob.status==='failed') return; } if(msg)msg.innerHTML='<div class="info">Job تحلیل و کنترل صحت در پس‌زمینه شروع می‌شود...</div>'; try{const r=await postJson('/api/supplier-sleep/build-selected-job',selectedBody()); setJob('build',r.jobId||''); if(msg)msg.innerHTML=`<div class="info">Job تحلیل ثبت شد: <small>${safe(r.jobId||'')}</small>. وضعیت هر ۴ ثانیه خودکار بررسی می‌شود و پس از اتمام گزارش تازه می‌شود.</div>`; startSupplierSleepPolling(); await checkBuildJob(false);}catch(e){if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  window.pageSupplierAging=async function(){ setPage('خواب کالا تأمین‌کننده',`<main class="main-content"><div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - کنترل عملیاتی Snapshot و Job</h5></div><div class="card-body"><div class="info">نسخه 47: Jobهای پس‌زمینه نسخه 46 حفظ شده‌اند و نمایش بعد از Snapshot یکپارچه شده است: فاکتورهای معتبر، مانده واقعی هر فاکتور، گروه اصلی و Purchase Layer هر کدام جدول مستقل دارند.</div><div class="row four"><div class="form-group"><label>از تاریخ خرید/فروش</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر فاکتور خرید</label><input id="psMaxInvoices" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر اسکن خرید</label><input id="psMaxScan" value="6000" inputmode="numeric"></div></div><div class="row two"><div class="form-group"><label>جستجوی تأمین‌کننده</label><input id="psSupplierSearch" placeholder="مثلاً ماتریس، ماندگار، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="psSearchBtn">جستجوی تأمین‌کننده</button></div></div><div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psReadSelected">خواندن مرحله‌ای فاکتورهای خرید</button><button class="btn red" id="psBuildSelected">تحلیل و کنترل صحت</button><button class="btn" id="psRefresh">Refresh / وضعیت Job</button></div><div id="psMsg" class="mt"></div><div id="psSelectedSupplier" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>۱) انتخاب تأمین‌کننده</h5></div><div class="card-body"><div id="psSupplierResults"></div></div></div><div class="card"><div class="card-header"><h5>۲) فاکتورهای خرید و Reconciliation</h5></div><div class="card-body"><div id="psInvoices"></div></div></div><div class="card"><div class="card-header"><h5>۳) Diagnostic مراحل</h5></div><div class="card-body"><div id="psDiagnostics"></div></div></div><div class="card"><div class="card-header"><h5>۴) Snapshotهای اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div><div class="card"><div class="card-header"><h5>۵) داشبورد مدیریتی تأمین‌کننده</h5></div><div class="card-body"><div id="psSummary"></div></div></div><div class="card"><div class="card-header"><h5>۶) مانده واقعی هر فاکتور خرید</h5></div><div class="card-body"><div id="psInvoiceSummary"></div></div></div><div class="card"><div class="card-header"><h5>۷) گزارش گروه اصلی کالا</h5></div><div class="card-body"><div id="psGroupSummary"></div></div></div><div class="card"><div class="card-header"><h5>۸) لایه‌های Purchase Layer</h5></div><div class="card-body"><div id="psLayers"></div></div></div></main>`); $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}}; $s('#psSearchBtn').onclick=searchSuppliers; $s('#psReadSelected').onclick=readSelected; $s('#psBuildSelected').onclick=buildSelected; $s('#psRefresh').onclick=async()=>{ await checkReadJob(false); await checkBuildJob(false); await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots();}; await renderSnapshots(); await renderSnapshot(''); await checkReadJob(false); await checkBuildJob(false); };
  const prevMenu=window.renderMenu;
  window.renderMenu=renderMenu=function(){ const menu=[['حسابداری / شایگان',[['sale','فاکتور فروش جدید'],['proforma','پیش‌فاکتور'],['proforma-list','آرشیو پیش‌فاکتور'],['buy','فاکتور خرید جدید'],['purchase-drafts','آرشیو پیش‌نویس خرید'],['stocks','موجودی انبارها'],['cardex','کاردکس کالا'],['inv-sale','فاکتورهای فروش'],['inv-buy','فاکتورهای خرید'],['turnover','گردش حساب'],['account-set','تعریف صندوق/نماینده']]],['CRM',[['customers','مشتریان'],['leads','Lead ID']]],['مدیریت',[['settings','تنظیمات'],['supplier-aging','خواب کالا تأمین‌کننده'],['sale-snapshot','Sale Snapshot'],['users','کاربران'],['roles','نقش‌ها'],['seller-profit','عملکرد فروشنده'],['reports','تست‌ها'],['app-logs','لاگ عملیات'],['tablo','تابلو']]]]; let h=''; const role=typeof userRole==='function'?userRole():'admin'; menu.forEach(([g,items])=>{const allowed=items.filter(([id])=>typeof canPage==='function'?canPage(id):true); if(!allowed.length)return; h+=`<div class="menu-group">${g}</div>`; allowed.forEach(([id,t])=>h+=`<button class="navbtn" data-page="${id}">${t}</button>`);}); const m=$s('#menu'); if(m){m.innerHTML=h; $sa('.navbtn').forEach(b=>b.onclick=e=>{e.preventDefault();location.hash=b.dataset.page;route();});} const chip=document.querySelector('.user-chip'); if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V46}</small>`; };
  const prevRoute=window.route; window.route=route=async function(){ const p=location.hash.slice(1)||(typeof firstAllowedPage==='function'?firstAllowedPage():'dashboard'); if(p==='supplier-aging') return window.pageSupplierAging(); if(prevRoute) return prevRoute.apply(this,arguments); };
  try{renderMenu();}catch{}
})();

/* PATCH 0.9.19.49: core stability refactor phase 1 - server time, guarded inventory sync, job heartbeat, supplier sleep cleanup */
(function(){
  const V48='0.9.19.49-core-stability-refactor-phase1';
  window.MKCRM_VERSION=V48;
  const $s=(q)=>document.querySelector(q);
  const $sa=(q)=>Array.from(document.querySelectorAll(q));
  const safe=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money=(v)=>{try{return Number(v||0).toLocaleString('fa-IR')}catch{return String(v||0)}};
  async function getJson(url){ if(typeof api==='function') return api(url); const r=await fetch(url,{credentials:'include'}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  async function postJson(url,body){ if(typeof post==='function') return post(url,body); const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(body||{})}); const j=await r.json(); if(!r.ok||j.ok===false) throw new Error(j.error||r.statusText); return j; }
  function statusBadge(st){ const s=String(st||''); const cls=s==='completed'||s==='OK'||s==='FULLY_CONSUMED_OR_SOLD'?'success':(s==='failed'||s.includes('FAIL')?'error':(s==='running'||s==='queued'?'info':'warn')); return `<span class="${cls}">${safe(statusFa(s))}</span>`; }
  function statusFa(s){ return ({FULLY_CONSUMED_OR_SOLD:'کامل مصرف/فروش شده',BODY_MISSING_OR_NOT_PARSED:'Body ناقص/خوانده نشده',PARTIAL_LINES_PARSED_RISK:'ریسک خواندن ناقص',UNDER_PARSED_RISK_OR_NON_ITEM_CHARGE:'اختلاف/هزینه غیرکالایی',MINOR_ADJUSTMENT:'تعدیل جزئی',OK:'OK',completed:'کامل',running:'در حال اجرا',queued:'در صف',failed:'ناموفق'}[String(s||'')]||s||'نامشخص'); }
  function boardDate(v, display){ if(display) return String(display||''); try{ if(!v) return ''; const d=new Date(v); if(isNaN(d)) return String(v||''); return new Intl.DateTimeFormat('fa-IR-u-ca-persian',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d); }catch{return String(v||'')} }
  function stageView(diag){ const stages=diag?.stages||[]; if(!stages.length) return '<div class="muted">Diagnostic مرحله‌ای وجود ندارد.</div>'; return `<h4>Diagnostic مرحله‌ای</h4><table class="table"><thead><tr><th>#</th><th>مرحله</th><th>وضعیت</th><th>تعداد/خروجی</th><th>منبع/خطا</th></tr></thead><tbody>${stages.map((x,i)=>`<tr><td>${i+1}</td><td>${safe(x.stage||'')}</td><td>${x.ok?'<span class="success">OK</span>':'<span class="warn">بررسی</span>'}</td><td>${money(x.rowCount??x.candidateCount??x.validInvoiceCount??x.count??x.scannedNumbers??'')}</td><td style="white-space:normal">${safe(x.source||x.error||'')}</td></tr>`).join('')}</tbody></table>`; }
  function selectedBody(){ const sup=window.__psSelectedSupplier||{}; return {accountNumber:sup.accountNumber,accountGuid:sup.accountGuid,accountName:sup.accountName,dateFrom:$s('#psDateFrom')?.value||'14050101',dateTo:$s('#psDateTo')?.value||'',maxInvoices:Number($s('#psMaxInvoices')?.value||300),maxScanNumbers:Number($s('#psMaxScan')?.value||6000)}; }
  function setJob(type, jobId){ try{ localStorage.setItem(type==='read'?'mkcrm_supplier_sleep_read_job':'mkcrm_supplier_sleep_build_job', jobId||''); }catch{} }
  function getJob(type){ try{return localStorage.getItem(type==='read'?'mkcrm_supplier_sleep_read_job':'mkcrm_supplier_sleep_build_job')||'';}catch{return '';} }
  function clearJob(type){ try{ localStorage.removeItem(type==='read'?'mkcrm_supplier_sleep_read_job':'mkcrm_supplier_sleep_build_job'); }catch{} }
  async function jobStatus(jobId){ const st=await getJson('/api/jobs/status?jobId='+encodeURIComponent(jobId)); return st.job||null; }
  function jobLine(job){ return `Job: <small>${safe(job?.jobId||'')}</small> | وضعیت: ${statusBadge(job?.status||'')} | مرحله: ${safe(job?.phase||'')}`; }
  function snapshotTable(list){ if(!list||!list.length) return '<div class="muted">Snapshot قبلی وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>گزارش</th><th>کد Snapshot</th><th>تأمین‌کننده</th><th>فاکتور</th><th>جمع فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${safe(x.snapshotLabel||((x.supplierDisplayName||x.selectedSupplier?.accountName||'تأمین‌کننده')+' - '+(x.reportJalaliDate||'')))}</b><br><small>${safe(x.userNote||'')}</small></td><td><small>${safe(x.snapshotId)}</small></td><td>${safe(x.supplierDisplayName||x.selectedSupplier?.accountName||'')}</td><td>${money(x.purchaseInvoicesSynced)}</td><td>${money(x.periodInvoiceTotalValue||0)}</td><td>${money(x.periodLayerGoodsValue||0)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.status||x.reconciliationStatus||'')}</td><td><button class="mini ps-pick" data-id="${safe(x.snapshotId)}">نمایش</button> <button class="mini ps-edit" data-id="${safe(x.snapshotId)}" data-label="${safe(x.snapshotLabel||'')}" data-note="${safe(x.userNote||'')}">ویرایش</button> <button class="mini ps-archive" data-id="${safe(x.snapshotId)}">آرشیو</button> <button class="mini red ps-delete" data-id="${safe(x.snapshotId)}">حذف</button></td></tr>`).join('')}</tbody></table>`; }
  function summaryTable(list,snapshotId){ if(!list||!list.length) return '<div class="muted">هنوز Snapshot تحلیلی ساخته نشده است.</div>'; return `<table class="table"><thead><tr><th>تأمین‌کننده</th><th>خرید دوره حسابداری</th><th>خرید کالایی تحلیل‌شده</th><th>اختلاف</th><th>وضعیت اعتبار</th><th>مانده موجودی</th><th>میانگین سن</th><th>رسوب +۳۰</th><th>رسوب +۶۰</th><th>لایه‌ها</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.supplierName||x.supplierAccountNo)}</td><td>${money(x.periodInvoiceTotalValue ?? x.periodPurchaseValue)}</td><td>${money(x.periodLayerGoodsValue ?? x.periodPurchaseValue)}</td><td>${money(x.periodReconciliationDiff||0)}<br><small>${safe(x.periodReconciliationDiffPercent||0)}٪</small></td><td>${statusBadge(x.reconciliationStatus||'')}</td><td>${money(x.remainingValue)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${money(x.staleOver30Value||0)}</td><td>${money(x.staleOver60Value||0)}</td><td><button class="mini ps-layer-btn" data-sid="${safe(snapshotId)}" data-sup="${safe(x.supplierAccountNo||'')}">لایه‌ها</button></td></tr>`).join('')}</tbody></table>`; }
  function invoiceTable(list, rec){ if(!list||!list.length) return '<div class="warn">فاکتور خرید معتبر پیدا نشد.</div>'; const recMap=new Map((rec?.invoices||[]).map(x=>[Number(x.invNo),x])); const total=list.reduce((s,x)=>s+Number(x.totalAmount||0),0); return `<h4>فاکتورهای خرید معتبر تأمین‌کننده</h4><div class="info">جمع فاکتورهای معتبر: <b>${money(total)}</b></div><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ فاکتور</th><th>جمع لایه</th><th>اختلاف</th><th>وضعیت</th><th>ردیف</th></tr></thead><tbody>${list.map(x=>{const r=recMap.get(Number(x.invNo))||x; return `<tr><td>${safe(x.invNo)}</td><td>${safe(x.invDate)}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.totalAmount)}</td><td>${money(r.layerValue||x.layerValue||0)}</td><td>${money(r.difference||x.difference||0)}<br><small>${safe(r.differencePercent||x.differencePercent||0)}٪</small></td><td>${statusBadge(r.status||x.reconciliationStatus||'در انتظار Snapshot')}</td><td>${money(x.rowCount)} / ${money(r.layerCount||x.layerCount||0)}</td></tr>`}).join('')}</tbody></table>`; }
  function invoiceSleepTable(list){ if(!list||!list.length) return '<div class="muted">مانده فاکتوری برای این Snapshot ثبت نشده است.</div>'; const totalRemaining=list.reduce((s,x)=>s+Number(x.remainingValue||0),0); const totalInvoice=list.reduce((s,x)=>s+Number(x.invoiceTotal||x.totalAmount||0),0); return `<h4>مانده واقعی هر فاکتور خرید</h4><div class="info">جمع مبلغ فاکتورها: <b>${money(totalInvoice)}</b> | جمع مانده متصل: <b>${money(totalRemaining)}</b><br><small>ردیف‌هایی با مانده صفر اگر «کامل مصرف/فروش شده» باشند تحلیل شده‌اند؛ مشکل قبلی این بود که آن‌ها به شکل نیمه‌کاره دیده می‌شدند.</small></div><table class="table"><thead><tr><th>شماره</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ فاکتور</th><th>خرید کالایی</th><th>مانده</th><th>درصد مانده</th><th>کالا/لایه خرید</th><th>کالا/لایه مانده</th><th>میانگین سن</th><th>وضعیت</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.purchaseInvoiceNo||x.invNo||'')}</td><td>${safe(x.purchaseDate||x.invDate||'')}</td><td>${safe(x.supplierAccountNo||'')}<br>${safe(x.supplierName||'')}</td><td>${money(x.invoiceTotal||x.totalAmount||0)}</td><td>${money(x.layerPurchaseValue||x.layerValue||0)}<br><small>تعداد: ${money(x.purchaseQty||0)}</small></td><td>${money(x.remainingValue||0)}<br><small>تعداد: ${money(x.remainingQty||0)}</small></td><td>${safe(x.remainingPercent??0)}٪</td><td>${money(x.purchaseItemCount??x.itemCount??0)} / ${money(x.purchaseLayerCount??x.layerCount??0)}</td><td>${money(x.remainingItemCount??0)} / ${money(x.remainingLayerCount??0)}</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td>${statusBadge(x.validationStatus||x.reconciliationStatus||'')}</td></tr>`).join('')}</tbody></table>`; }
  function groupTable(list,sid,sup){ if(!list||!list.length) return '<div class="muted">گزارش گروه اصلی وجود ندارد.</div>'; return `<table class="table"><thead><tr><th>گروه اصلی</th><th>تعداد کالا</th><th>لایه</th><th>خرید کالایی</th><th>مانده</th><th>ارزش مانده</th><th>درصد مانده</th><th>میانگین سن</th><th>لایه‌ها</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.mainGroup||x.mainGroupName||'نامشخص')}</td><td>${money(x.itemCount||0)}</td><td>${money(x.layerCount||0)}</td><td>${money(x.purchaseValue||0)}</td><td>${money(x.remainingQty||0)}</td><td>${money(x.remainingValue||0)}</td><td>${safe(x.remainingPercent??0)}٪</td><td>${x.averageAgeDays==null?'نامشخص':money(x.averageAgeDays)}</td><td><button class="mini ps-group-layer-btn" data-sid="${safe(sid)}" data-sup="${safe(sup||'')}" data-group="${safe(x.mainGroupCode||'')}">نمایش لایه‌ها</button></td></tr>`).join('')}</tbody></table>`; }
  async function renderSnapshots(){ const box=$s('#psSnapshots'); if(!box)return; try{ const r=await getJson('/api/supplier-sleep/snapshots?limit=30'); box.innerHTML=snapshotTable(r.list||[]); $sa('.ps-pick').forEach(b=>b.onclick=()=>renderSnapshot(b.dataset.id)); $sa('.ps-edit').forEach(b=>b.onclick=async()=>{ const label=prompt('عنوان Snapshot',b.dataset.label||''); if(label===null)return; const note=prompt('یادداشت مدیریتی',b.dataset.note||''); if(note===null)return; try{await postJson('/api/supplier-sleep/snapshot-update',{snapshotId:b.dataset.id,snapshotLabel:label,note}); await renderSnapshots();}catch(e){alert(e.message||e);} }); $sa('.ps-archive').forEach(b=>b.onclick=async()=>{try{await postJson('/api/supplier-sleep/snapshot-update',{snapshotId:b.dataset.id,status:'archived'}); await renderSnapshots();}catch(e){alert(e.message||e);}}); $sa('.ps-delete').forEach(b=>b.onclick=async()=>{if(!confirm('این Snapshot و تمام لایه‌ها، خلاصه‌ها و Diagnosticهای وابسته حذف شود؟'))return; try{await postJson('/api/supplier-sleep/snapshot-delete',{snapshotId:b.dataset.id}); if(window.__psSnapshotId===b.dataset.id)window.__psSnapshotId=''; await renderSnapshots(); await renderSnapshot('');}catch(e){alert(e.message||e);}}); }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderLayers(sid,sup,mainGroupCode=''){ const box=$s('#psLayers'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن لایه‌ها...</div>'; try{ let url='/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&supplierAccountNo='+encodeURIComponent(sup||'')+'&mainGroupCode='+encodeURIComponent(mainGroupCode||'')+'&limit=2000'; let r=await getJson(url); let list=r.list||[]; if(!list.length && sup){ r=await getJson('/api/supplier-sleep/layers?snapshotId='+encodeURIComponent(sid||'')+'&mainGroupCode='+encodeURIComponent(mainGroupCode||'')+'&limit=2000'); list=r.list||[]; } box.innerHTML=list.length?`<h4>لایه‌های Purchase Layer ${mainGroupCode?'/ گروه '+safe(mainGroupCode):''}</h4><table class="table"><thead><tr><th>LayerId</th><th>کالا</th><th>گروه</th><th>فاکتور خرید</th><th>تاریخ خرید</th><th>تعداد خرید</th><th>مانده</th><th>ارزش مانده</th><th>سن</th><th>روش تخصیص</th></tr></thead><tbody>${list.map(x=>`<tr><td><small>${safe(x.layerId||x.persistentLayerId||'')}</small></td><td>${safe(x.itemCode)}<br>${safe(x.itemName)}</td><td>${safe(x.mainGroup||x.mainGroupName||'')}</td><td>${safe(x.purchaseInvoiceNo||'')}</td><td>${safe(x.purchaseDate||'')}</td><td>${money(x.purchaseQty)}</td><td>${money(x.allocatedRemainingQty)}</td><td>${money(x.allocatedRemainingValue)}</td><td>${x.ageDays==null?'نامشخص':money(x.ageDays)}</td><td><small>${safe(x.allocationMethod||x.status||'')}</small></td></tr>`).join('')}</tbody></table>`:'<div class="muted">لایه‌ای برای این فیلتر پیدا نشد.</div>'; }catch(e){box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function renderSnapshot(sid){ const sum=$s('#psSummary'), inv=$s('#psInvoiceSummary'), grp=$s('#psGroupSummary'), layer=$s('#psLayers'); if(layer)layer.innerHTML=''; let realSid=sid||''; try{ const r=await getJson('/api/supplier-sleep/suppliers?snapshotId='+encodeURIComponent(realSid)+'&limit=500'); realSid=r.snapshotId||realSid; window.__psSnapshotId=realSid; const sup=(r.list&&r.list[0]&&r.list[0].supplierAccountNo)||''; if(sum)sum.innerHTML=summaryTable(r.list||[],realSid); $sa('.ps-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup,'')); const ri=await getJson('/api/supplier-sleep/invoice-summary?snapshotId='+encodeURIComponent(realSid)+'&limit=1000'); if(inv)inv.innerHTML=invoiceSleepTable(ri.list||[]); const rg=await getJson('/api/supplier-sleep/group-summary?snapshotId='+encodeURIComponent(realSid)+'&limit=500'); if(grp)grp.innerHTML=groupTable(rg.list||[],realSid,sup); $sa('.ps-group-layer-btn').forEach(b=>b.onclick=()=>renderLayers(b.dataset.sid,b.dataset.sup,b.dataset.group)); }catch(e){ if(sum)sum.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  let supplierSearchSeq=0,supplierSearchController=null;
  async function searchSuppliers(){ const input=$s('#psSupplierSearch'), q=(input?.value||'').trim(); const box=$s('#psSupplierResults'); if(!box)return; if(q.length<2){popupSuggestionController.close({restoreFocus:false});box.innerHTML='<div class="warn">حداقل دو حرف یا کد وارد کن.</div>';return;} const seq=++supplierSearchSeq;if(supplierSearchController)supplierSearchController.abort();supplierSearchController=new AbortController();uiPageLifecycle.add(()=>{supplierSearchSeq++;supplierSearchController?.abort();supplierSearchController=null;});box.innerHTML='<div class="info">در حال جستجوی حساب...</div>'; popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.ps-select-supplier'}); try{ const r=await api('/api/accounts/search?q='+encodeURIComponent(q)+'&limit=20&pages=220',{signal:supplierSearchController.signal});if(seq!==supplierSearchSeq)return; const list=r.list||[]; box.innerHTML=list.length?`<table class="table"><thead><tr><th>کد</th><th>نام حساب</th><th>انتخاب</th></tr></thead><tbody>${list.map(x=>`<tr><td>${safe(x.accountNumber||'')}</td><td>${safe(x.accountName||'')}</td><td><button class="mini ps-select-supplier" data-no="${safe(x.accountNumber||'')}" data-name="${safe(x.accountName||'')}" data-guid="${safe(x.accountGuid||x.guId||'')}">انتخاب</button></td></tr>`).join('')}</tbody></table>`:'<div class="muted">حسابی پیدا نشد.</div>'; $sa('.ps-select-supplier').forEach(b=>b.onclick=()=>{window.__psSelectedSupplier={accountNumber:b.dataset.no,accountName:b.dataset.name,accountGuid:b.dataset.guid}; try{localStorage.setItem('mkcrm_supplier_sleep_selected_supplier',JSON.stringify(window.__psSelectedSupplier));}catch{} const s=$s('#psSelectedSupplier'); if(s)s.innerHTML=`<div class="success">تأمین‌کننده انتخاب شد: ${safe(b.dataset.name)} | ${safe(b.dataset.no)}</div>`; popupSuggestionController.close();}); popupSuggestionController.open({popup:box,trigger:input,optionSelector:'.ps-select-supplier'}); } catch(e){if(e.name==='AbortError')return; popupSuggestionController.close({restoreFocus:false});box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; } }
  async function checkReadJob(showIfMissing=false){ const msg=$s('#psMsg'), box=$s('#psInvoices'), diag=$s('#psDiagnostics'); const jobId=getJob('read'); if(!jobId){ if(showIfMissing&&msg)msg.innerHTML='<div class="muted">Job خواندن فعالی ثبت نشده است.</div>'; return null; } try{ const job=await jobStatus(jobId); if(!job){ if(msg)msg.innerHTML='<div class="warn">Job خواندن پیدا نشد.</div>'; return null; } if(msg)msg.innerHTML=`<div class="info">${jobLine(job)}</div>`; if(job.status==='completed'){ const r=job.result||{}; if(msg)msg.innerHTML=`<div class="success">خواندن فاکتورهای خرید کامل شد: گردش ${money(r.statementRows)} | کاندید ${money(r.invoiceNoCandidates)} | فاکتور معتبر ${money(r.count)} | منبع: ${safe(r.source||'')}</div>`; if(box)box.innerHTML=invoiceTable(r.list||[],null); if(diag)diag.innerHTML=stageView(r.diagnostics||{}); clearJob('read'); return job; } if(job.status==='failed'){ if(box)box.innerHTML=`<div class="error">Job خواندن ناموفق شد: ${safe(job.error||job.result?.error||'')}</div>`; clearJob('read'); return job; } if(box)box.innerHTML=`<div class="info">خواندن فاکتورهای خرید در پس‌زمینه ادامه دارد.<br>${jobLine(job)}</div>`; return job; }catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; return null; } }
  async function readSelected(){ const sup=window.__psSelectedSupplier||{}; const box=$s('#psInvoices'), msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){ if(box)box.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>'; return;} if(box)box.innerHTML='<div class="info">Job خواندن فاکتورهای خرید در پس‌زمینه ثبت می‌شود...</div>'; try{const r=await postJson('/api/supplier-sleep/selected-supplier-invoices-job',selectedBody()); setJob('read',r.jobId||''); startSupplierSleepPolling(); if(msg)msg.innerHTML=`<div class="info">Job خواندن ثبت شد: <small>${safe(r.jobId||'')}</small>.</div>`; await checkReadJob(false);}catch(e){if(box)box.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  async function checkBuildJob(showIfMissing=false){ const msg=$s('#psMsg'); const jobId=getJob('build'); if(!jobId){ if(showIfMissing&&msg)msg.innerHTML='<div class="muted">Job تحلیل فعالی ثبت نشده است.</div>'; return null; } try{ const job=await jobStatus(jobId); if(!job){ if(msg)msg.innerHTML='<div class="warn">Job تحلیل پیدا نشد.</div>'; return null; } if(job.status==='completed'){ const sid=job.result?.snapshotId||''; window.__psSnapshotId=sid; if(msg)msg.innerHTML=`<div class="success">تحلیل کامل شد. Snapshot: ${safe(sid)} | فاکتور: ${money(job.result?.purchaseInvoicesSynced||0)} | لایه: ${money(job.result?.purchaseLayerCount||0)} | مانده مرتبط: ${money(job.result?.totalAllocatedValue||0)} | نامشخص: ${money(job.result?.totalUnknownValue||0)}</div>`; clearJob('build'); await renderSnapshot(sid); await renderSnapshots(); return job; } if(job.status==='failed'){ if(msg)msg.innerHTML=`<div class="error">Job تحلیل ناموفق شد: ${safe(job.error||job.result?.error||'')}</div>`; clearJob('build'); return job; } if(msg)msg.innerHTML=`<div class="info">تحلیل هنوز در حال اجراست و به صفحه وابسته نیست.<br>${jobLine(job)}</div>`; return job; }catch(e){ if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`; return null; } }
  async function buildSelected(){ const sup=window.__psSelectedSupplier||{}, msg=$s('#psMsg'); if(!sup.accountNumber&&!sup.accountGuid&&!sup.accountName){if(msg)msg.innerHTML='<div class="warn">اول تأمین‌کننده را انتخاب کن.</div>';return;} if(getJob('read')) await checkReadJob(false); if(msg)msg.innerHTML='<div class="info">Job تحلیل و کنترل صحت در پس‌زمینه شروع می‌شود...</div>'; try{const r=await postJson('/api/supplier-sleep/build-selected-job',selectedBody()); setJob('build',r.jobId||''); if(msg)msg.innerHTML=`<div class="info">Job تحلیل ثبت شد: <small>${safe(r.jobId||'')}</small>.</div>`; await checkBuildJob(false);}catch(e){if(msg)msg.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;} }
  let __psPollTimer=null;
  function startSupplierSleepPolling(){ if(__psPollTimer)clearInterval(__psPollTimer); __psPollTimer=setInterval(async()=>{ if(location.hash.slice(1)!=='supplier-aging'){clearInterval(__psPollTimer);__psPollTimer=null;return;} const hasRead=!!getJob('read'),hasBuild=!!getJob('build'); if(!hasRead&&!hasBuild){clearInterval(__psPollTimer);__psPollTimer=null;return;} if(hasRead)await checkReadJob(false); if(hasBuild)await checkBuildJob(false); },4000); }
  function restoreSupplierSleepSupplier(){ if(window.__psSelectedSupplier&&Object.keys(window.__psSelectedSupplier).length)return; try{const x=JSON.parse(localStorage.getItem('mkcrm_supplier_sleep_selected_supplier')||'{}'); if(x&&(x.accountNumber||x.accountGuid||x.accountName))window.__psSelectedSupplier=x;}catch{} }
  window.pageSupplierAging=async function(){ restoreSupplierSleepSupplier(); setPage('خواب کالا تأمین‌کننده',`<main class="main-content"><div class="card"><div class="card-header"><h5>خواب کالا تأمین‌کننده - نسخه 49 - پایداری هسته</h5></div><div class="card-body"><div class="info">Jobها مستقل از صفحه‌اند؛ نمایش فاکتورهای مصرف‌شده/مانده اصلاح شده؛ نمایش لایه‌های هر گروه اصلی فعال شده است.</div><div class="row four"><div class="form-group"><label>از تاریخ خرید/فروش</label><input id="psDateFrom" value="14050101"></div><div class="form-group"><label>تا تاریخ</label><input id="psDateTo" value=""></div><div class="form-group"><label>حداکثر فاکتور خرید</label><input id="psMaxInvoices" value="300" inputmode="numeric"></div><div class="form-group"><label>حداکثر اسکن خرید</label><input id="psMaxScan" value="6000" inputmode="numeric"></div></div><div class="row two"><div class="form-group"><label>جستجوی تأمین‌کننده</label><input id="psSupplierSearch" placeholder="مثلاً ماتریس، ماندگار، رایان کاوه"></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="psSearchBtn">جستجوی تأمین‌کننده</button></div></div><div class="actions"><button class="btn green" id="psInit">آماده‌سازی</button><button class="btn" id="psReadSelected">خواندن مرحله‌ای فاکتورهای خرید</button><button class="btn red" id="psBuildSelected">تحلیل و کنترل صحت</button><button class="btn" id="psRefresh">Refresh / وضعیت Job</button></div><div id="psMsg" class="mt"></div><div id="psSelectedSupplier" class="mt"></div></div></div><div class="card"><div class="card-header"><h5>۱) انتخاب تأمین‌کننده</h5></div><div class="card-body"><div id="psSupplierResults"></div></div></div><div class="card"><div class="card-header"><h5>۲) فاکتورهای خرید و Reconciliation</h5></div><div class="card-body"><div id="psInvoices"></div></div></div><div class="card"><div class="card-header"><h5>۳) Diagnostic مراحل</h5></div><div class="card-body"><div id="psDiagnostics"></div></div></div><div class="card"><div class="card-header"><h5>۴) Snapshotهای اخیر</h5></div><div class="card-body"><div id="psSnapshots"></div></div></div><div class="card"><div class="card-header"><h5>۵) داشبورد مدیریتی تأمین‌کننده</h5></div><div class="card-body"><div id="psSummary"></div></div></div><div class="card"><div class="card-header"><h5>۶) مانده واقعی هر فاکتور خرید</h5></div><div class="card-body"><div id="psInvoiceSummary"></div></div></div><div class="card"><div class="card-header"><h5>۷) گزارش گروه اصلی کالا</h5></div><div class="card-body"><div id="psGroupSummary"></div></div></div><div class="card"><div class="card-header"><h5>۸) لایه‌های Purchase Layer</h5></div><div class="card-body"><div id="psLayers"></div></div></div></main>`); $s('#psInit').onclick=async()=>{const m=$s('#psMsg');m.innerHTML='در حال آماده‌سازی...';try{const r=await postJson('/api/supplier-sleep/init',{});m.innerHTML=`<div class="success">آماده شد. نسخه: ${safe(r.version||'')}</div>`;}catch(e){m.innerHTML=`<div class="error">${safe(e.message||e)}</div>`;}}; $s('#psSearchBtn').onclick=searchSuppliers; $s('#psReadSelected').onclick=readSelected; $s('#psBuildSelected').onclick=buildSelected; $s('#psRefresh').onclick=async()=>{ await checkReadJob(false); await checkBuildJob(false); await renderSnapshot(window.__psSnapshotId||''); await renderSnapshots();}; await renderSnapshots(); await renderSnapshot(''); const rs=window.__psSelectedSupplier||{}; if((rs.accountNumber||rs.accountName)&&$s('#psSelectedSupplier'))$s('#psSelectedSupplier').innerHTML=`<div class="success">تأمین‌کننده بازیابی شد: ${safe(rs.accountName||'')} | ${safe(rs.accountNumber||'')}</div>`; await checkReadJob(false); await checkBuildJob(false); if(getJob('read')||getJob('build'))startSupplierSleepPolling(); };
  function boardStatusFa(s){return ({new:'جدید',seen:'بررسی شد',site_updated:'سایت بروزرسانی شد',closed:'بسته شد'}[String(s||'new')]||s||'')}
  function boardTypeFa(t){return ({stock_out:'اتمام کالا',stock_in:'ورود کالا'}[String(t||'')]||t||'')}
  function canManageBoardEventsUI(){const u=state.user||{}; return u.role==='admin' || u.canManageBoardEvents===true;}
  function canViewPurchaseInvoicesUI(){const u=state.user||{}; return u.role==='admin' || u.canViewPurchaseInvoices===true;}
  function canPostPurchaseToBoardUI(){const u=state.user||{}; return u.role==='admin' || u.canPostPurchaseToBoard===true;}
  function boardRow(x){ const canManage=canManageBoardEventsUI(); return `<tr><td>${safe(boardDate(x.createdAt||'', x.createdAtDisplay||x.createdAtTehran||''))}</td><td>${safe(boardTypeFa(x.type))}</td><td><b>${safe(x.itemCode)}</b><br>${safe(x.itemName)}</td><td>${x.qty!=null?money(x.qty):''}</td><td>${x.totalQtyAfter!=null?money(x.totalQtyAfter):''}</td><td>${safe(x.sellerName||x.createdByName||x.supplierName||'')}</td><td>${safe(x.invoiceNo||x.purchaseInvoiceNo||'')}</td><td>${safe(boardStatusFa(x.status))}</td><td>${canManage?`<select class="board-status" data-id="${safe(x._id)}"><option value="new" ${x.status==='new'?'selected':''}>جدید</option><option value="seen" ${x.status==='seen'?'selected':''}>بررسی شد</option><option value="site_updated" ${x.status==='site_updated'?'selected':''}>سایت بروزرسانی شد</option><option value="closed" ${x.status==='closed'?'selected':''}>بسته شد</option></select>`:'-'}</td></tr>`; }
  async function loadBoardEvents(){ const box=$s('#tabloEvents'); if(!box)return; const status=$s('#tabloStatus')?.value||'all'; const type=$s('#tabloType')?.value||'all'; box.innerHTML='<div class="info">در حال خواندن تابلو...</div>'; const r=await getJson(`/api/board/events?status=${encodeURIComponent(status)}&type=${encodeURIComponent(type)}&limit=200`); const rows=r.list||[]; box.innerHTML=rows.length?`<div class="table-scroll"><table class="table"><thead><tr><th>زمان</th><th>نوع</th><th>کالا</th><th>تعداد</th><th>موجودی کل بعد</th><th>ثبت‌کننده/فروشنده</th><th>فاکتور</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows.map(boardRow).join('')}</tbody></table></div>`:'<div class="muted">رویدادی وجود ندارد.</div>'; $sa('.board-status').forEach(sel=>sel.onchange=async()=>{const r=await postJson('/api/board/events/status',{id:sel.dataset.id,status:sel.value}); if(!r.ok) alert(r.error||'خطا در تغییر وضعیت'); await loadBoardEvents();}); }
  async function loadPurchaseInvoices(){ const box=$s('#tabloPurchases'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن ۳۰ فاکتور خرید آخر از شایگان...</div>'; const r=await getJson('/api/board/purchase-invoices?limit=30'); const rows=r.list||[]; box.innerHTML=rows.length?`<div class="table-scroll"><table class="table"><thead><tr><th>شماره خرید</th><th>تاریخ</th><th>تأمین‌کننده</th><th>مبلغ</th><th>ردیف</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows.map(x=>`<tr><td><button class="linklike purchase-view" data-no="${safe(x.invNo)}">${safe(x.invNo)}</button></td><td>${safe(toJalaliDisplay(x.invDate))}</td><td>${safe(x.supplierName)}<br><small>${safe(x.supplierNumber)}</small></td><td>${money(x.totalAmount)}</td><td>${money(x.rowCount)}</td><td>${x.announced?'<span class="oktext">اعلام شده</span>':'-'}</td><td><button class="mini purchase-view" data-no="${safe(x.invNo)}">مشاهده</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">فاکتور خریدی پیدا نشد.</div>'; $sa('.purchase-view').forEach(b=>b.onclick=()=>viewPurchaseInvoice(b.dataset.no)); }
  async function viewPurchaseInvoice(no){ const box=$s('#tabloPurchaseDetail'); if(!box)return; box.innerHTML='<div class="info">در حال خواندن فاکتور خرید...</div>'; const r=await getJson(`/api/board/purchase-invoices/${encodeURIComponent(no)}`); if(!r.ok){box.innerHTML=`<div class="error">${safe(r.error||'خطا')}</div>`;return;} const inv=r.invoice||{}, lines=r.lines||[]; const announceBtn=canPostPurchaseToBoardUI()?'<button class="btn green" id="announcePurchaseToBoard">اعلام ورود در تابلو</button>':'<div class="muted">دسترسی اعلام ورود کالا برای این کاربر فعال نیست.</div>'; box.innerHTML=`<div class="card mt"><div class="card-header"><h5>فاکتور خرید ${safe(inv.invNo)}</h5></div><div class="card-body"><div class="info">تاریخ: ${safe(toJalaliDisplay(inv.invDate))} | تأمین‌کننده: ${safe(inv.supplierName)} | مبلغ: ${money(inv.totalAmount)}</div><div class="table-scroll"><table class="table"><thead><tr><th>کد کالا</th><th>نام کالا</th><th>انبار</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>${lines.map(x=>`<tr><td>${safe(x.itemCode)}</td><td>${safe(x.itemName)}</td><td>${safe(x.stockNumber)} ${safe(x.stockName)}</td><td>${money(x.qty)}</td><td>${money(x.price)}</td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>${announceBtn}<div id="announceOut" class="mt"></div></div></div>`; if($s('#announcePurchaseToBoard')) $s('#announcePurchaseToBoard').onclick=async()=>{if(!confirm('کالاهای این فاکتور خرید در تابلو به عنوان ورود کالا اعلام شود؟'))return; const r=await postJson(`/api/board/purchase-invoices/${encodeURIComponent(no)}/announce`,{}); $s('#announceOut').innerHTML=r.ok?`<div class="success">اعلام شد. جدید: ${money(r.inserted)} | تکراری/رد شده: ${money(r.skipped)}</div>`:`<div class="error">${safe(r.error||'خطا')}</div>`; await loadBoardEvents();}; }
  window.pageTablo=async function(){ const purchaseReviewCard=canViewPurchaseInvoicesUI()?`<div class="card"><div class="card-header"><h5>بررسی فاکتورهای خرید برای اعلام ورود کالا</h5></div><div class="card-body"><button class="btn" id="loadPurchaseInvoicesBtn">خواندن ۳۰ فاکتور خرید آخر</button><div id="tabloPurchases" class="mt"></div><div id="tabloPurchaseDetail" class="mt"></div></div></div>`:`<div class="card"><div class="card-header"><h5>بررسی فاکتورهای خرید</h5></div><div class="card-body"><div class="muted">دسترسی مرور فاکتورهای خرید برای این کاربر فعال نیست.</div></div></div>`; setPage('تابلو',`<main class="main-content"><div class="card"><div class="card-header"><h5>تابلو: ورود کالا و اتمام موجودی</h5></div><div class="card-body"><div class="info">اتمام کالا بعد از صدور فاکتور فروش یا تبدیل پیش‌فاکتور و صفر شدن موجودی کل در انبارهای فعال خودکار ثبت می‌شود. زمان تابلو از ساعت سرور خوانده و با تقویم تهران نمایش داده می‌شود.</div><div class="row three"><div class="form-group"><label>نوع</label><select id="tabloType"><option value="all">همه</option><option value="stock_out">اتمام کالا</option><option value="stock_in">ورود کالا</option></select></div><div class="form-group"><label>وضعیت</label><select id="tabloStatus"><option value="all">همه</option><option value="new">جدید</option><option value="seen">بررسی شد</option><option value="site_updated">سایت بروزرسانی شد</option><option value="closed">بسته شد</option></select></div><div class="form-group"><label>&nbsp;</label><button class="btn" id="tabloReload">بروزرسانی تابلو</button></div></div><div id="tabloEvents" class="mt"></div></div></div>${purchaseReviewCard}</main>`); $s('#tabloReload').onclick=loadBoardEvents; $s('#tabloStatus').onchange=loadBoardEvents; $s('#tabloType').onchange=loadBoardEvents; if($s('#loadPurchaseInvoicesBtn')) $s('#loadPurchaseInvoicesBtn').onclick=loadPurchaseInvoices; await loadBoardEvents(); };
  const oldRenderMenu=window.renderMenu||renderMenu;
  window.renderMenu=renderMenu=function(){ if(oldRenderMenu) oldRenderMenu(); const chip=document.querySelector('.user-chip'); const role=typeof userRole==='function'?userRole():'admin'; if(chip) chip.innerHTML=`${safe(state.user?.fullName||state.user?.username||'')}<br><small>${safe((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V48}</small>`; };
  const oldRoute=window.route||route;
  window.route=route=async function(){ const p=location.hash.slice(1)||(typeof firstAllowedPage==='function'?firstAllowedPage():'dashboard'); if(p==='supplier-aging') return window.pageSupplierAging(); if(p==='tablo') return window.pageTablo(); return oldRoute.apply(this,arguments); };
  async function refreshVersionText(){ try{ const r=await getJson('/api/version'); const ht=$s('#healthText'); if(ht) ht.textContent=`online | ${r.version||V48}`; }catch{} try{renderMenu();}catch{} }
  setTimeout(refreshVersionText,300);
})();

// 0.9.19.54 - Proforma convert local deduct + board stock-out fix UI safety layer
(function(){
  const V51='0.9.19.54-proforma-convert-local-deduct-board';
  function invErr(e){ return (e && (e.message || e.error)) ? String(e.message || e.error) : String(e || 'خطای نامشخص'); }
  function cardexUrl(code, stockNumber=''){
    return `/api/items/${encodeURIComponent(code||'')}/kardex${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`;
  }
  window.renderInventory = renderInventory = async function(itemCode,target,selectable=false,stockNumber=''){
    const box = $(target); if(!box) return;
    box.innerHTML='در حال خواندن موجودی و اصلاح cache کالا...';
    try{
      const r=await api(`/api/items/${encodeURIComponent(itemCode)}/inventory${stockNumber?`?stockNumber=${encodeURIComponent(stockNumber)}`:''}`);
      if(!r.ok){ box.innerHTML=`<div class="error">${esc(r.error||'خطا در خواندن موجودی')}</div>`; return; }
      const rows=applyStockFilterRows(r.list||[],stockNumber);
      if(!rows.length){ box.innerHTML=`<div class="warn">برای این کالا در انبارهای فعال موجودی پیدا نشد. ${r.refresh?.zeroUntrusted?'پاسخ صفر live refresh مشکوک بود و cache قبلی حذف نشد.':''}</div>`; return; }
      const note = r.refresh ? `<div class="small muted">منبع: ${esc(r.source||'')} | ردیف موجودی: ${fmt(rows.length)} | refresh: ${esc(r.refresh.source||'')}</div>` : '';
      box.innerHTML=note+'<div id="invRowsSafeBox"></div>';
      renderInventoryRows(rows,'#invRowsSafeBox',selectable);
    }catch(e){ box.innerHTML=`<div class="error">خطا در خواندن موجودی کالا: ${esc(invErr(e))}</div><div class="small muted">کد کالا: ${esc(itemCode)}</div>`; }
  };
  window.renderInventorySearch = renderInventorySearch = async function(query,target,selectable=false,stockNumber=''){
    const box=$(target); if(!box) return;
    box.innerHTML='در حال جستجوی موجودی از snapshot یکپارچه...';
    try{
      const r=await searchInventoryRowsFull(query,stockNumber);
      if(!r.ok){ box.innerHTML=`<div class="error">${esc(r.error||'خطا در جستجوی موجودی')}</div>`; return; }
      const rows=r.list||[];
      if(!rows.length){ box.innerHTML='<div class="warn">نتیجه‌ای برای این جستجو/انبار پیدا نشد.</div>'; return; }
      box.innerHTML=`<div class="small muted">${fmt(rows.length)} ردیف انبار منطبق با «${esc(query)}» | منبع: ${esc(r.source||'snapshot')} ${r.exactRefresh?`| refresh دقیق کالا: ${r.exactRefresh.ok?'موفق':'ناموفق'}`:''}</div><div id="stockGroupBox" class="form-group"></div><div id="stockRowsBox"></div>`;
      renderGroupSelect(r.groups||[],'stock','#stockRowsBox',rows,selectable);
      renderInventoryRows(rows,'#stockRowsBox',selectable);
    }catch(e){ box.innerHTML=`<div class="error">خطا در جستجوی موجودی: ${esc(invErr(e))}</div>`; }
  };
  window.renderKardex = renderKardex = async function(item,target,stockNumber=''){
    const box=$(target); if(!box) return;
    const code = (typeof item==='string') ? item : (item.itemCode||item.ItemCode||'');
    box.innerHTML='در حال خواندن کاردکس...';
    try{
      const r=await api(cardexUrl(code,stockNumber));
      if(!r.ok){ box.innerHTML=`<div class="error">خطا در خواندن کاردکس: ${esc(r.error||'نامشخص')}</div><div class="small muted">کد کالا: ${esc(code)} | انبار: ${esc(stockNumber||'همه')}</div>`; return; }
      let h=`<div class="small muted">کد کالا: ${esc(code)} | ردیف‌ها: ${fmt((r.rows||[]).length)} | موجودی ensure: ${r.inventoryEnsure?.ok?'موفق':'ناموفق/بدون تغییر'}</div>`;
      h+='<table class="table"><thead><tr><th>تاریخ</th><th>فاکتور</th><th>طرف حساب</th><th>ورود</th><th>خروج</th><th>مانده</th><th>قیمت خرید/تمام‌شده</th><th>قیمت فروش</th><th>سود</th></tr></thead><tbody>';
      h+=(r.rows||[]).map(x=>`<tr><td>${esc(x.date||'')}</td><td>${esc(x.invoiceNumber||'')}</td><td>${esc(x.accountName||'')}</td><td>${fmt(x.inQty)}</td><td>${fmt(x.outQty)}</td><td>${fmt(x.remainQty)}</td><td>${fmt(x.costPrice)}</td><td>${fmt(x.salePrice)}</td><td>${fmt(x.grossProfit)}</td></tr>`).join('');
      box.innerHTML=h+'</tbody></table>';
    }catch(e){ box.innerHTML=`<div class="error">کاردکس خوانده نشد: ${esc(invErr(e))}</div><div class="small muted">کد کالا: ${esc(code)} | endpoint: ${esc(cardexUrl(code,stockNumber))}</div><button class="btn" id="retryKardexSafe">تلاش مجدد</button>`; const b=$('#retryKardexSafe'); if(b)b.onclick=()=>renderKardex(item,target,stockNumber); }
  };
  const oldRenderMenu51=window.renderMenu||renderMenu;
  window.renderMenu=renderMenu=function(){ if(oldRenderMenu51) oldRenderMenu51(); const chip=document.querySelector('.user-chip'); const role=typeof userRole==='function'?userRole():'admin'; if(chip) chip.innerHTML=`${esc(state.user?.fullName||state.user?.username||'')}<br><small>${esc((window.ROLE_LABELS&&ROLE_LABELS[role])||role)}</small><br><small>${V51}</small>`; };
})();

/* Final activation for admin backup and deterministic turnover workflows. */
(function(){
  const inheritedMenu=window.renderMenu||renderMenu;
  window.renderMenu=renderMenu=function(){inheritedMenu.apply(this,arguments);if(userRole()!=='admin')return;const m=$('#menu');if(m&&!m.querySelector('[data-page="backup-management"]')){const b=document.createElement('button');b.className='navbtn';b.dataset.page='backup-management';b.textContent='مدیریت پشتیبان‌گیری';b.onclick=()=>{location.hash='backup-management';route();};m.appendChild(b);}};
  const inheritedRoute=window.route||route;
  window.route=route=async function(){const p=location.hash.slice(1)||firstAllowedPage();if(p==='turnover')return window.__stablePageTurnover();if(p==='backup-management'&&userRole()==='admin')return window.pageBackupManagement();return inheritedRoute.apply(this,arguments);};
  try{renderMenu();}catch{}
})();
