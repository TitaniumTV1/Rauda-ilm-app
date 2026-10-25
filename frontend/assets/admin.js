import {$,$$,api,esc,icon,button,tag,empty,shell,pageHead,field,formValues,formDialog,dialog,toast,showError,setBusy,runAction,bindActions,fmtDate,money,safeUrl,confirmAction,closeDialogs} from './shared.js';
import {authenticate} from './auth.js';
import {renderPeople} from './admin-people.js';
import {renderExams,renderCertificates} from './admin-assessments.js';
import {renderPayments,renderSettings} from './admin-commerce.js';

const nav=[['overview','Обзор','home'],['learning','Обучение','book'],['people','Ученики и группы','users'],['exams','Экзамены','exam'],['payments','Оплаты и тарифы','wallet'],['certificates','Сертификаты','award'],['settings','Настройки школы','settings']];
const kinds={courses:['Курсы','курс'],programs:['Программы','программу'],semesters:['Семестры','семестр'],subjects:['Предметы и книги','предмет / книгу'],lessons:['Уроки','урок']};
const mediaRoleOptions=[['auto','Определить автоматически'],['voiceover','Видео с озвучкой'],['subtitle','Видео с субтитрами'],['audio','Отдельное аудио под видео'],['notes','Конспект / книга'],['attachment','Другой материал']];
const mediaRoleNames={auto:'Определяется по формату',voiceover:'Видео с озвучкой',subtitle:'Видео с субтитрами',audio:'Аудио под видео',notes:'Конспект / книга',attachment:'Другой материал'};
const mediaFileAccepts={
    auto:'audio/*,video/*,image/*,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,.pdf,.txt,.md,.doc,.docx,.rtf,.odt',
    subtitle:'video/*,.mp4,.webm,.mov,.m4v',
    voiceover:'video/*,.mp4,.webm,.mov,.m4v',
    audio:'audio/*,.mp3,.mp4a,.m4a,.aac,.ogg,.opus,.wav,.flac',
    notes:'application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,.pdf,.txt,.md,.doc,.docx,.rtf,.odt',
    attachment:'audio/*,video/*,image/*,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,.pdf,.txt,.md,.doc,.docx,.rtf,.odt'
};

function configureMediaFilePicker(form){
    const input=form.elements.files,role=form.elements.media_role;
    if(!input||!role)return;
    const update=()=>{input.accept=mediaFileAccepts[role.value]||mediaFileAccepts.auto};
    role.addEventListener('change',update);
    update();
}

let user,catalog={},adminOffers=[],version=0;
export const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

async function route(){
    const v=++version;closeDialogs();
    const [page='overview',tab]=(location.hash.slice(1)||'overview').split('/');
    $$('.nav a').forEach(a=>a.setAttribute('aria-current',a.hash==='#'+page?'page':'false'));
    const main=$('#main');
    main.innerHTML='<div class="loading" role="status">Загружаем данные…</div>';
    try{
        const routes={overview,learning,people:()=>renderPeople(main,user),exams:()=>renderExams(main,user),payments:()=>renderPayments(main,user),certificates:()=>renderCertificates(main,user),settings:()=>renderSettings(main,user)};
        await (routes[page]||overview)(main,tab);
        if(v===version)main.focus({preventScroll:true});
    }catch(error){
        if(v===version){
            main.innerHTML=pageHead(nav.find(x=>x[0]===page)?.[1]||'Управление школой');
            const block=document.createElement('div');
            showError(block,error);
            main.append(block);
            main.insertAdjacentHTML('beforeend',button('Повторить загрузку','retry'));
            bindActions(main,{retry:route});
        }
    }
}

async function overview(main){
    const results=await Promise.allSettled([api('/admin/learning/catalog'),api('/admin/learning/exams')]);
    const c=results[0].status==='fulfilled'?results[0].value:null,e=results[1].status==='fulfilled'?results[1].value:null;
    main.innerHTML=`${pageHead('Обзор школы','Учебные материалы, ученики, сертификаты и тарифы в одном месте.')}
    <div class="hero">
        <div>
            <div class="eyebrow">Управление RAUDA ILM</div>
            <h2>Всё для учебного процесса</h2>
            <p>Настраивайте курсы, связывайте их с тарифами оплаты, загружайте шаблоны сертификатов для курсов и книг.</p>
        </div>
        <img class="logo-large" src="/logo.png" alt="Логотип школы">
    </div>
    <div class="grid four">${[['Курсы',c?.courses?.length,'book'],['Программы',c?.programs?.length,'book'],['Уроки',c?.lessons?.length,'play'],['Экзамены',e?.exams?.length,'exam']].map(([t,n,i])=>`<div class="card metric">${icon(i)}<strong>${n??'—'}</strong><small>${t}${n===undefined?' · нет доступа':''}</small></div>`).join('')}</div>
    <section class="section">
        <div class="section-title"><h2>Быстрые действия</h2></div>
        <div class="grid three">${[['learning/courses','Курсы и тарифы оплаты','Редактируйте курсы, привязывайте тарифы и загружайте шаблоны сертификатов.','book'],['payments','Управление тарифами и оплатой','Создавайте и полностью удаляйте ненужные тарифы.','wallet'],['certificates','Шаблоны и сертификаты','Проверяйте выданные сертификаты по курсам и книгам.','award']].map(([href,title,text,i])=>`<a class="card" href="#${href}" style="text-decoration:none">${icon(i)}<h3 style="margin:15px 0 9px">${title}</h3><p class="muted" style="font-size:12px">${text}</p></a>`).join('')}</div>
    </section>`;
}

async function learning(main,kind='courses'){
    if(!kinds[kind])kind='courses';
    const [catData,offersData]=await Promise.all([
        api('/admin/learning/catalog'),
        api('/admin/offers').catch(()=>({offers:[]}))
    ]);
    catalog=catData;
    adminOffers=offersData.offers||[];
    const rows=catalog[kind]||[];
    const caption=x=>[catalog.courses?.find(c=>c.id===x.course_id)?.name,catalog.programs?.find(p=>p.id===x.program_id)?.name,catalog.semesters?.find(s=>s.id===x.semester_id)?.name].filter(Boolean).join(' / ');

    main.innerHTML=`${pageHead('Обучение','Курс (с привязкой оплаты и сертификата) → семестр → предмет / книга → урок.',button(`${icon('plus')}Добавить ${kinds[kind][1]}`,'create','','primary'))}
    <nav class="tabs" aria-label="Разделы обучения">${Object.entries(kinds).map(([key,[title]])=>`<a class="${key===kind?'active':''}" href="#learning/${key}">${title}</a>`).join('')}</nav>
    <div class="card">
        <div class="toolbar">
            ${field({name:'search',label:'Поиск',placeholder:'Название или описание'})}
            ${field({name:'visibility',label:'Показывать',type:'select',options:[['all','Все материалы'],['active','Опубликованные'],['hidden','Скрытые']]})}
        </div>
        <div id="content-list"></div>
    </div>`;

    const draw=()=>{
        const q=$('[name=search]',main).value.toLowerCase(),visibility=$('[name=visibility]',main).value;
        const filtered=rows.filter(x=>(!q||`${x.name||x.title} ${x.description||''}`.toLowerCase().includes(q))&&(visibility==='all'||((x.is_visible??x.is_active)!==0)===(visibility==='active')));

        $('#content-list').innerHTML=filtered.length?table(
            ['Название',kind==='courses'?'Связанные тарифы / Сертификат':'Расположение','Состояние','Действия'],
            filtered.map(x=>{
                let middleCol=esc(caption(x)||'—');
                if(kind==='courses'){
                    const linkedOffers=adminOffers.filter(o=>Number(o.course_id)===Number(x.id));
                    const offersLabel=linkedOffers.length?linkedOffers.map(o=>`${esc(o.name)} (${money(o.amount_minor,o.currency)})`).join(', '):'Тариф не привязан';
                    const certBadge=Number(x.certificate_enabled)===1?tag(x.certificate_template?'Шаблон сертификата загружен':'Сертификат включён','good'):tag('Без сертификата','neutral');
                    middleCol=`<div><strong>${offersLabel}</strong><div style="margin-top:4px">${certBadge}</div></div>`;
                }else if(kind==='subjects'){
                    const certBadge=(Number(x.certificate_enabled)===1||x.certificate_template)?tag('Шаблон сертификата книги','good'):'';
                    middleCol=`<div>${esc(caption(x)||'—')}${x.author?`<br><small>Шейх: ${esc(x.author)}</small>`:''}${certBadge?`<div style="margin-top:4px">${certBadge}</div>`:''}</div>`;
                }
                return `<tr>
                    <td><strong>${esc(x.name||x.title)}</strong><small>${esc(x.description||'')}</small></td>
                    <td>${middleCol}</td>
                    <td>${tag((x.is_visible??x.is_active)!==0?'Опубликован':'Скрыт',(x.is_visible??x.is_active)!==0?'good':'neutral')}</td>
                    <td><div class="actions">
                        ${button('Изменить','edit',`data-id="${x.id}"`,'small')}
                        ${kind==='courses'?`<a class="btn small" href="#payments">Тарифы и оплата</a>`:''}
                        ${kind==='lessons'?button('Материалы','files',`data-id="${x.id}"`,'small'):''}
                        ${button('Скрыть','archive',`data-id="${x.id}"`,'small ghost')}
                    </div></td>
                </tr>`;
            })
        ):empty('Материалы не найдены','Добавьте первый материал или измените фильтр.');
    };

    $('[name=search]',main).oninput=draw;
    $('[name=visibility]',main).onchange=draw;
    draw();

    bindActions(main,{
        create:()=>editContent(kind,{}),
        edit:b=>editContent(kind,rows.find(x=>String(x.id)===b.dataset.id)),
        files:b=>manageFiles(rows.find(x=>String(x.id)===b.dataset.id)),
        archive:b=>confirmAction('Скрыть материал','Материал будет скрыт для учеников. Существующие результаты обучения сохранятся.',async()=>{
            await api(`/admin/learning/${kind}/${b.dataset.id}`,{method:'DELETE'});
            toast('Материал скрыт');
            await route();
        })
    });
}

function curriculumFields(kind,item){
    const fields=[];
    if(kind!=='courses')fields.push({name:'course_id',label:'Курс',type:'select',required:true,value:item.course_id||'',options:[['','Выберите курс'],...(catalog.courses||[]).map(x=>[x.id,x.name])]});
    if(['semesters','subjects','lessons'].includes(kind))fields.push({name:'program_id',label:'Программа',type:'select',required:true,value:item.program_id||'',options:[['','Выберите программу'],...(catalog.programs||[]).map(x=>[x.id,x.name])]});
    if(['subjects','lessons'].includes(kind))fields.push({name:'semester_id',label:'Семестр',type:'select',required:true,value:item.semester_id||'',options:[['','Выберите семестр'],...(catalog.semesters||[]).map(x=>[x.id,x.name||`Семестр ${x.number}`])]});
    if(kind==='lessons')fields.push({name:'subject_id',label:'Предмет / Книга',type:'select',value:item.subject_id||'',options:[['','Без предмета'],...(catalog.subjects||[]).map(x=>[x.id,x.name])]});

    fields.push(
        {name:kind==='lessons'?'title':'name',label:'Название',required:true,value:item.title||item.name||'',wide:true},
        {name:'description',label:'Описание',type:'textarea',value:item.description||'',wide:true}
    );

    if(kind==='courses'){
        fields.push(
            {name:'teacher_name',label:'Имя шейха / преподавателя курса',value:item.teacher_name||item.author||''},
            {name:'certificate_enabled',label:'Выдавать сертификат по этому курсу',type:'checkbox',value:Number(item.certificate_enabled)===1,wide:true}
        );
    }
    if(kind==='subjects'){
        fields.push(
            {name:'author',label:'Имя шейха / автора книги (отображается над плеером)',value:item.author||''},
            {name:'certificate_enabled',label:'Выдавать сертификат по этой книге / предмету',type:'checkbox',value:Number(item.certificate_enabled)===1,wide:true}
        );
    }
    if(kind==='lessons'){
        fields.push(
            {name:'author',label:'Имя шейха (если отличается от предмета)',value:item.author||item.sheikh_name||''},
            {name:'content',label:'Текст урока',type:'textarea',value:item.content||'',wide:true},
            {name:'lesson_number',label:'Номер урока',type:'number',min:1,value:item.lesson_number||1},
            {name:'sort_order',label:'Порядок показа',type:'number',min:0,value:item.sort_order||0}
        );
    }
    if(kind==='subjects')fields.push({name:'sort_order',label:'Порядок показа',type:'number',min:0,value:item.sort_order||0});
    if(kind==='semesters')fields.push({name:'number',label:'Номер семестра',type:'number',min:1,required:true,value:item.number||1});
    fields.push({name:kind==='lessons'?'is_visible':'is_active',label:'Опубликовать для учеников',type:'checkbox',value:(item.is_visible??item.is_active)!==0,wide:true});
    return fields;
}

function cascade(form){
    const connect=(parent,child,list,parentKey,blank)=>{
        const p=form.elements[parent],c=form.elements[child];
        if(!p||!c)return;
        const fill=()=>{
            const previous=c.value;
            c.innerHTML=`<option value="">${blank}</option>`+list.filter(x=>!p.value||String(x[parentKey])===p.value).map(x=>`<option value="${x.id}">${esc(x.name||x.title||`Семестр ${x.number}`)}</option>`).join('');
            c.value=[...c.options].some(o=>o.value===previous)?previous:'';
            c.dispatchEvent(new Event('change'));
        };
        p.addEventListener('change',fill);
        fill();
    };
    connect('semester_id','subject_id',catalog.subjects||[],'semester_id','Без предмета');
    connect('program_id','semester_id',catalog.semesters||[],'program_id','Выберите семестр');
    connect('course_id','program_id',catalog.programs||[],'course_id','Выберите программу');
}

function editContent(kind,item){
    let savedId=item.id;
    const uploadedFiles=new Set(),uploadedCovers=new Set(),uploadedCertTemplates=new Set();

    const mediaExtra=kind==='lessons'?`<div class="section"><div class="formgrid">${field({name:'files',label:'Видео, аудио и материалы урока',type:'file',wide:true,help:'Загружайте видео с субтитрами и видео с озвучкой как обычные видеофайлы.'})}${field({name:'media_role',label:'Тип загружаемых файлов',type:'select',value:'auto',options:mediaRoleOptions})}${field({name:'media_language',label:'Язык видео или аудио',placeholder:'ru, kk, en'})}</div><p class="muted" style="font-size:11px;margin-top:10px">Роли «Видео с субтитрами» и «Видео с озвучкой» переключаются прямо над видеоплеером. Отдельное аудио появится с надписью «аудиоформат».</p></div>`:'';

    const currentCover=safeUrl(item.cover_image);
    const currentCertTemplate=safeUrl(item.certificate_template||item.certificate_url);
    const linkedOffer=kind==='courses'&&item.id?adminOffers.find(o=>Number(o.course_id)===Number(item.id)):null;

    const paymentLinkExtra=kind==='courses'?`
        <div class="divider"></div>
        <section class="section">
            <h3>Связанный тариф и оплата курса</h3>
            <p class="muted" style="font-size:12px;margin-bottom:10px">Укажите стоимость и срок доступа, чтобы сразу создать или обновить тариф, привязанный к этому курсу.</p>
            <div class="formgrid">
                ${field({name:'offer_name',label:'Название тарифа (оставьте пустым, если не нужно менять)',value:linkedOffer?.name||(item.name?`Доступ к курсу «${item.name}»`:''),placeholder:'Например: Полный доступ к курсу'})}
                ${field({name:'offer_price_rub',label:'Стоимость (RUB)',type:'number',min:0,step:'1',value:linkedOffer?Math.round(Number(linkedOffer.amount_minor||0)/100):'',placeholder:'Например: 2500'})}
                ${field({name:'offer_access_days',label:'Срок доступа (дней, 0 = бессрочно)',type:'number',min:0,value:linkedOffer?.access_days??0})}
            </div>
        </section>
    `:'';

    const certTemplateExtra=['courses','subjects'].includes(kind)?`
        <div class="divider"></div>
        <section class="section">
            <h3>Индивидуальный шаблон сертификата (${kind==='courses'?'для курса':'для книги / предмета'})</h3>
            <div data-cert-preview>${currentCertTemplate?`<p class="muted">Загружен шаблон: <a href="${esc(currentCertTemplate)}" target="_blank" rel="noopener">Посмотреть текущий шаблон</a></p>`:'<p class="muted">Индивидуальный шаблон ещё не загружен.</p>'}</div>
            <div class="formgrid">
                ${field({name:'certificate_file',label:'Загрузить свой шаблон сертификата (PNG, JPG или PDF)',type:'file',wide:true,help:'При сдаче экзамена имя и фамилия ученика будут автоматически подставлены на этот сертификат.'})}
            </div>
        </section>
    `:'';

    const coverExtra=['courses','subjects'].includes(kind)?`<section class="section"><h3>Обложка</h3><div data-cover-preview>${currentCover?`<img src="${esc(currentCover)}" alt="Текущая обложка" style="display:block;max-width:220px;max-height:150px;object-fit:cover;margin:12px 0">`:'<p class="muted">Обложка ещё не добавлена.</p>'}</div><div class="formgrid">${field({name:'cover_file',label:'Загрузить обложку',type:'file',wide:true,help:'JPG, PNG или WebP, до 5 МБ.'})}</div>${item.cover_image?button('Удалить обложку','cover-delete','','small ghost'):''}</section>${certTemplateExtra}${paymentLinkExtra}`:'';

    formDialog({
        title:`${item.id?'Изменить':'Добавить'} ${kinds[kind][1]}`,
        fields:curriculumFields(kind,item),
        extra:kind==='lessons'?mediaExtra:coverExtra,
        wide:true,
        onMount(form){
            cascade(form);
            if(form.elements.files){form.elements.files.multiple=true;configureMediaFilePicker(form)}
            if(form.elements.cover_file)form.elements.cover_file.accept='image/jpeg,image/png,image/webp';
            if(form.elements.certificate_file)form.elements.certificate_file.accept='image/jpeg,image/png,image/webp,application/pdf';
            if(form.elements.cover_file&&item.id){
                bindActions(form,{
                    'cover-delete':async b=>{
                        await runAction(b,async()=>{
                            await api(`/admin/learning/covers/${kind}/${savedId}`,{method:'DELETE'});
                            item.cover_image='';
                            const preview=form.querySelector('[data-cover-preview]');
                            if(preview)preview.innerHTML='<p class="muted">Обложка ещё не добавлена.</p>';
                            b.remove();
                            toast('Обложка удалена');
                        });
                    }
                });
            }
        },
        async onSave(values,form){
            const mediaRole=values.media_role||'auto',mediaLanguage=values.media_language||'';
            const offerName=String(values.offer_name||'').trim();
            const offerPriceRub=values.offer_price_rub;
            const offerAccessDays=Number(values.offer_access_days||0);

            delete values.files;delete values.media_role;delete values.media_language;
            delete values.cover_file;delete values.certificate_file;
            delete values.offer_name;delete values.offer_price_rub;delete values.offer_access_days;

            for(const key of ['course_id','program_id','semester_id','subject_id'])if(key in values)values[key]=values[key]?Number(values[key]):null;
            const result=await api(`/admin/learning/${kind}${savedId?'/'+savedId:''}`,{method:savedId?'PATCH':'POST',body:values});
            savedId=result.item?.id||savedId;

            const coverFile=form.elements.cover_file?.files?.[0];
            if(coverFile&&savedId&&!uploadedCovers.has(coverFile)){
                const data=new FormData();data.append('file',coverFile);
                try{await api(`/admin/learning/covers/${kind}/${savedId}`,{method:'POST',body:data});uploadedCovers.add(coverFile)}
                catch(error){throw new Error(`Материал сохранён. Обложка не загружена: ${error.message}`)}
            }

            const certFile=form.elements.certificate_file?.files?.[0];
            if(certFile&&savedId&&!uploadedCertTemplates.has(certFile)){
                const data=new FormData();data.append('file',certFile);data.append('kind',kind);data.append('target_id',String(savedId));
                try{await api(`/admin/learning/certificate-templates/${kind}/${savedId}`,{method:'POST',body:data});uploadedCertTemplates.add(certFile)}
                catch(error){throw new Error(`Материал сохранён. Шаблон сертификата не загружен: ${error.message}`)}
            }

            if(kind==='courses'&&savedId&&offerName&&offerPriceRub!==null&&offerPriceRub!==undefined&&offerPriceRub!==''){
                const offerPayload={
                    name:offerName,
                    course_id:Number(savedId),
                    amount_minor:Math.round(Number(offerPriceRub)*100),
                    currency:'RUB',
                    access_days:offerAccessDays>0?offerAccessDays:null,
                    access_unlimited:offerAccessDays<=0,
                    is_active:true
                };
                try{
                    if(linkedOffer?.id)await api(`/admin/offers/${linkedOffer.id}`,{method:'PATCH',body:offerPayload});
                    else await api('/admin/offers',{method:'POST',body:offerPayload});
                }catch(error){
                    toast(`Курс сохранён, но тариф не обновлён: ${error.message}`,true);
                }
            }

            if(kind==='lessons'){
                const files=[...(form.elements.files?.files||[])];
                for(let i=0;i<files.length;i++){
                    if(uploadedFiles.has(i))continue;
                    const data=new FormData();data.append('file',files[i]);data.append('sort_order',String(i));data.append('media_role',mediaRole);data.append('media_language',mediaLanguage);
                    try{await api(`/admin/lessons/${savedId}/files`,{method:'POST',body:data});uploadedFiles.add(i)}
                    catch(error){throw new Error(`Урок сохранён. Файл «${files[i].name}» не загружен: ${error.message}`)}
                }
            }
            toast('Изменения сохранены');
            await route();
        }
    });
}

async function manageFiles(lesson){
    const response=await api(`/learning/lessons/${lesson.id}`),files=response.lesson?.files||[];
    const fileRows=files.map(f=>{
        const role=mediaRoleNames[f.media_role||'auto']||'Определяется по формату';
        const language=f.media_language?` · ${esc(f.media_language)}`:'';
        return `<div class="list-row"><div class="grow"><a href="${esc(safeUrl(f.url||`/api/lesson-files/${f.id}`))}" target="_blank" rel="noopener">${esc(f.file_name||f.original_name||'Файл')}</a><p>${esc(f.mime_type||f.content_type||'')} · ${esc(role)}${language}</p></div>${button('Удалить','delete',`data-id="${f.id}"`,'small danger')}</div>`;
    });
    const d=dialog(`Материалы: ${lesson.title}`,`<div class="list">${fileRows.join('')||empty('Файлов пока нет')}</div><div class="divider"></div><form id="file-upload"><div class="formgrid"><label class="field wide"><span>Добавить файлы</span><input type="file" name="files" multiple required><small>Для вариантов «Видео с субтитрами» и «Видео с озвучкой» выбирайте обычные видеофайлы. Для конспектов и книг — PDF, TXT, MD, DOC, DOCX.</small></label>${field({name:'media_role',label:'Тип загружаемых файлов',type:'select',value:'auto',options:mediaRoleOptions})}${field({name:'media_language',label:'Язык видео или аудио',placeholder:'ru, kk, en'})}</div><div class="notice info">Видео с субтитрами и видео с озвучкой переключаются справа над видеоплеером. Отдельное аудио появится с надписью «аудиоформат».</div><div class="form-error" role="alert"></div><div class="form-footer"><button type="submit" class="btn primary">Загрузить</button></div></form>`);
    bindActions(d,{
        delete:b=>confirmAction('Удалить файл','Файл будет удалён из урока. Это действие нельзя отменить.',async()=>{
            await api(`/admin/lesson-files/${b.dataset.id}`,{method:'DELETE'});
            d.close();
            await manageFiles(lesson);
        })
    });
    const form=$('#file-upload',d),uploaded=new Set();
    configureMediaFilePicker(form);
    form.onsubmit=async e=>{
        e.preventDefault();
        setBusy($('[type=submit]',form),true);
        $('.form-error',form).textContent='';
        try{
            for(const f of form.elements.files.files){
                if(uploaded.has(f))continue;
                const data=new FormData();
                data.append('file',f);
                data.append('media_role',form.elements.media_role.value);
                data.append('media_language',form.elements.media_language.value);
                await api(`/admin/lessons/${lesson.id}/files`,{method:'POST',body:data});
                uploaded.add(f);
            }
            d.close();
            toast('Файлы загружены');
            await manageFiles(lesson);
        }catch(error){
            $('.form-error',form).textContent=error.message;
        }finally{
            setBusy($('[type=submit]',form),false);
        }
    };
}

async function start(){try{({user}=await authenticate({admin:true}));shell({user,admin:true,items:nav});window.addEventListener('hashchange',route);await route()}catch(error){showError($('#root'),error)}}
start();
