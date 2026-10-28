export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, ''');
};
const paths={book:'M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3z M12 7a3 3 0 0 1 3-3h6v15h-5a4 4 0 0 0-4 2',home:'m3 10 9-7 9 7 M5 9v12h14V9 M9 21v-7h6v7',users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',exam:'M9 5H5v16h14V5h-4 M9 3h6v4H9z M8 12h8 M8 16h5',wallet:'M3 6h17v15H3z M3 6V3h15v3 M15 11h7v5h-7z',award:'M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12 M8 14l-1 8 5-3 5 3-1-8',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',arrow:'M5 12h14 M14 7l5 5-5 5',back:'M19 12H5 M10 17l-5-5 5-5',check:'m5 12 4 4L19 6',plus:'M12 5v14 M5 12h14',close:'m6 6 12 12 M6 18 18 6',menu:'M4 6h16 M4 12h16 M4 18h16',file:'M14 2H4v20h16V8z M14 2v6h6 M8 13h8 M8 17h5',play:'m8 4 12 8-12 8z',lock:'M5 10h14v12H5z M8 10V6a4 4 0 0 1 8 0v4',logout:'M9 3H4v18h5 M8 12h13 M17 8l4 4-4 4',clock:'M12 8v5l3 2 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20',refresh:'M20 11a8 8 0 1 0-2 7 M20 4v7h-7'};
export const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.book}"/></svg>`;
export function fmtDate(value){if(!value)return '—';const d=new Date(String(value).includes('T')?value:String(value).replace(' ','T')+'Z');return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('ru',{dateStyle:'medium',timeStyle:'short'}).format(d)}
export const money=(minor,currency='RUB')=>new Intl.NumberFormat('ru',{style:'currency',currency,maximumFractionDigits:2}).format(Number(minor||0)/100);
export const nameOf=u=>[u?.first_name,u?.last_name].filter(Boolean).join(' ')||u?.login||u?.username||`Ученик ${u?.account_id||u?.id||''}`;
export function safeUrl(value){if(!value)return '';try{const u=new URL(String(value),location.origin);return u.origin===location.origin||u.protocol==='https:'?u.href:''}catch{return ''}}
export async function api(path,options={}){const headers=new Headers(options.headers||{});if(options.body&&!(options.body instanceof FormData)){headers.set('Content-Type','application/json');if(typeof options.body!=='string')options={...options,body:JSON.stringify(options.body)}}let response;try{response=await fetch(path.startsWith('/api/')?path:'/api'+path,{...options,headers,credentials:'same-origin'})}catch{throw new Error('Нет соединения с сервером. Проверьте интернет и повторите действие.')}const data=await response.json().catch(()=>null);if(!response.ok||!data||data.ok===false){const error=new Error(data?.error||`Сервер не выполнил запрос (${response.status}).`);error.status=response.status;error.data=data;throw error}return data}
export const button=(text,action,extra='',kind='')=>`<button type="button" class="btn ${kind}" data-action="${esc(action)}" ${extra}>${text}</button>`;
export const tag=(text,kind='')=>`<span class="tag ${kind}">${esc(text)}</span>`;
export const empty=(title,detail='')=>`<div class="empty">${icon('book')}<strong>${esc(title)}</strong>${esc(detail)}</div>`;
export function toast(text,error=false){const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=text;$('#toasts').append(node);setTimeout(()=>node.remove(),error?10000:5500)}
export function showError(node,error){node.innerHTML=`<div class="notice error" role="alert">${esc(error?.message||error)}</div>`}
export function setBusy(b,busy){if(!b)return;b.disabled=busy;if(busy){b.dataset.label=b.innerHTML;b.textContent='Подождите…'}else if(b.dataset.label){b.innerHTML=b.dataset.label;delete b.dataset.label}}
export async function runAction(b,work){setBusy(b,true);try{return await work()}finally{if(b?.isConnected)setBusy(b,false)}}
export function bindActions(root,actions){root.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el||!root.contains(el))return;const action=actions[el.dataset.action];if(!action)return;e.preventDefault();try{await action(el,e)}catch(error){toast(error.message,true)}})}
export function shell({user,admin=false,active,items}){
    const homeHref=admin?'/admin/#overview':'#study';
    $('#root').innerHTML=`<div class="sidebar-backdrop" id="sidebar-backdrop" data-action="close-menu" aria-hidden="true"></div><div class="shell"><aside class="sidebar" id="sidebar"><a class="brand" href="${homeHref}"><img src="/logo.png" alt=""><div><strong>RAUDA ILM</strong><small>${admin?'Управление школой':'Школа знаний'}</small></div></a><nav class="nav" aria-label="Основная навигация">${items.map(([id,label,i])=>`<a href="#${id}" ${active===id?'aria-current="page"':''}>${icon(i)}${esc(label)}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="identity"><strong>${esc(nameOf(user))}</strong><small>${admin?'Панель администратора':`RAUDA ID ${esc(user.account_id||user.id)}`}</small></div>${admin?'<a href="/">← Кабинет ученика</a>':['owner','superadmin','admin'].includes(user.role)?'<a href="/admin/">Управление школой →</a>':''}<button class="btn ghost" style="color:#d4dbcf;justify-content:flex-start;padding-left:0" data-action="logout">${icon('logout')}Выйти</button></div></aside><div class="workspace"><header class="topbar"><div class="actions"><button type="button" class="btn ghost mobile-menu" data-action="menu" aria-label="Открыть меню">${icon('menu')}</button><button type="button" class="btn small" data-action="go-back" aria-label="Назад">${icon('back')}Назад</button><small>${admin?'Рабочее пространство':'Личный кабинет'}</small></div><div class="actions"><a href="${homeHref}" class="topbar-logo-link" title="На главную"><img src="/logo.png" alt="RAUDA ILM" class="topbar-logo"></a></div></header><main class="content" id="main" tabindex="-1"></main></div></div>`;
    const closeMenu=()=>{
        $('#sidebar')?.classList.remove('open');
        $('#sidebar-backdrop')?.classList.remove('open');
    };
    bindActions($('#root'),{
        menu(){
            const isOpen=$('#sidebar').classList.toggle('open');
            $('#sidebar-backdrop')?.classList.toggle('open',isOpen);
        },
        'close-menu':()=>closeMenu(),
        'go-back'(){
            closeMenu();
            if(history.length>1&&location.hash&&location.hash!=='#study'&&location.hash!=='#overview'&&location.hash!=='#'){
                history.back();
            }else{
                location.hash=admin?'#overview':'#study';
            }
        },
        async logout(){await api('/auth/logout',{method:'POST'});location.reload()}
    });
    $$('.nav a, .brand, .topbar-logo-link').forEach(a=>a.addEventListener('click',closeMenu));
}
export const pageHead=(title,description='',actions='')=>`<div class="pagehead"><div><div class="eyebrow">RAUDA ILM</div><h1>${esc(title)}</h1>${description?`<p>${esc(description)}</p>`:''}</div><div class="actions"><button type="button" class="btn small" onclick="if(history.length>1&&location.hash&&location.hash!=='#study'&&location.hash!=='#overview'){history.back()}else{location.hash='#study'}">${icon('back')}Назад</button>${actions}</div></div>`;
export function field({name,label,type='text',value='',required=false,options=[],help='',wide=false,min,max,step,placeholder=''}){const attrs=`name="${esc(name)}" ${required?'required':''} ${min!==undefined?`min="${min}"`:''} ${max!==undefined?`max="${max}"`:''} ${step?`step="${step}"`:''} placeholder="${esc(placeholder)}"`;if(type==='checkbox')return `<label class="field checkbox ${wide?'wide':''}"><input type="checkbox" ${attrs} ${value===true||value===1||value==='1'?'checked':''}><span>${esc(label)}</span></label>`;return `<label class="field ${wide?'wide':''}"><span>${esc(label)}${required?' *':''}</span>${type==='textarea'?`<textarea ${attrs}>${esc(value)}</textarea>`:type==='select'?`<select ${attrs}>${options.map(o=>{const v=Array.isArray(o)?o[0]:o.id,t=Array.isArray(o)?o[1]:o.name||o.title;return `<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(t)}</option>`}).join('')}</select>`:`<input type="${type}" ${attrs} value="${esc(value)}" ${type==='password'?'minlength="8" autocomplete="new-password"':''}>`}${help?`<small>${esc(help)}</small>`:''}</label>`}
export function formValues(form){const v=Object.fromEntries(new FormData(form));$$('input[type=checkbox][name]',form).forEach(el=>v[el.name]=el.checked);$$('input[type=number][name]',form).forEach(el=>v[el.name]=el.value===''?null:Number(el.value));return v}
export function dialog(title,body,{wide=false}={}){closeDialogs();const d=document.createElement('dialog');d.innerHTML=`<div class="dialog-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost" aria-label="Закрыть">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;if(wide)d.style.width='min(960px, calc(100% - 32px))';document.body.append(d);$('.dialog-head button',d).onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}});d.showModal();return d}
export function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close())}
export function formDialog({title,fields=[],extra='',onSave,onMount,submit='Сохранить',wide=false}){const d=dialog(title,`<form><div class="formgrid">${fields.map(field).join('')}</div>${extra}<div class="form-error" role="alert" style="margin-top:15px"></div><div class="form-footer"><button type="button" class="btn" data-cancel>Отмена</button><button class="btn primary" type="submit">${esc(submit)}</button></div></form>`,{wide});const form=$('form',d);$('[data-cancel]',d).onclick=()=>d.close();form.addEventListener('submit',async e=>{e.preventDefault();if(!form.reportValidity())return;const btn=$('[type=submit]',form);setBusy(btn,true);$('.form-error',form).textContent='';try{await onSave(formValues(form),form,d);if(d.isConnected)d.close()}catch(error){$('.form-error',form).textContent=error.message}finally{setBusy(btn,false)}});onMount?.(form,d);return d}
export async function confirmAction(title,message,work){return new Promise(resolve=>{const d=dialog(title,`<p class="muted">${esc(message)}</p><div class="form-error" role="alert" style="margin-top:15px"></div><div class="form-footer"><button class="btn" data-cancel>Отмена</button><button class="btn danger" data-confirm>Подтвердить</button></div>`);$('[data-cancel]',d).onclick=()=>{d.close();resolve(false)};$('[data-confirm]',d).onclick=async e=>{setBusy(e.currentTarget,true);try{await work();d.close();resolve(true)}catch(error){$('.form-error',d).textContent=error.message;setBusy($('[data-confirm]',d),false)}}})}
export const statusLabel=s=>({paid:'Оплачен',succeeded:'Оплачен',pending:'Ожидает оплаты',waiting_for_capture:'Ожидает подтверждения',cancelled:'Отменён',canceled:'Отменён',failed:'Ошибка',active:'Активен',expired:'Истёк',blocked:'Заблокирован',completed:'Завершён',submitted:'Отправлен',in_progress:'В процессе',student:'Ученик',admin:'Администратор',superadmin:'Главный администратор',owner:'Владелец'}[s]||s||'—');
