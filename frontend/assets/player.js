import {$,$$,api,esc,safeUrl,button,icon} from './shared.js';

const audioExtensions = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;
const videoExtensions = /\.(mp4|webm|mov|m4v)$/i;
const languageNames = {ru:'Русский',kk:'Қазақша',en:'English',ar:'العربية',tr:'Türkçe'};

export function mediaKind(file) {
    const type = String(file.mime_type || file.content_type || file.file_type || '').toLowerCase();
    const name = String(file.file_name || file.name || '').toLowerCase();
    if (type.startsWith('video/') || videoExtensions.test(name)) return 'video';
    if (type.startsWith('audio/') || audioExtensions.test(name)) return 'audio';
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name)) return 'image';
    return 'file';
}

function fileUrl(file) {
    return safeUrl(file.url || (file.id ? `/api/lesson-files/${file.id}` : ''));
}

function mediaRole(file) {
    const role = String(file.media_role || '').toLowerCase();
    if (role === 'subtitle' || role === 'voiceover' || role === 'audio' || role === 'attachment' || role === 'notes') return role;
    return mediaKind(file);
}

function variantLabel(file, role) {
    const language = String(file.media_language || '').trim().toLowerCase();
    const detail = languageNames[language] || language.toUpperCase() ||
        String(file.caption || file.file_name || '').replace(/\.[^.]+$/, '');
    const title = role === 'subtitle' ? 'С субтитрами' : role === 'voiceover' ? 'Озвучка' : 'Оригинал';
    return `${title}${detail ? ` · ${detail}` : ''}`;
}

function videoMarkup(file, index, variants = [], fileRole = 'original') {
    const url = fileUrl(file);
    if (!url) return '';
    const id = Number(file.id) || '';
    const name = esc(file.file_name || file.name || 'Видеоурок');
    const sources = [{file, role:fileRole}, ...variants];
    const variantOptions = sources.map((source, sourceIndex) => {
        const sourceUrl = fileUrl(source.file);
        if (!sourceUrl) return '';
        const label = variantLabel(source.file, source.role);
        return `<option value="${sourceIndex}" data-video-url="${esc(sourceUrl)}" data-video-label="${esc(label)}">${esc(label)}</option>`;
    }).join('');
    const variantPicker = sources.length > 1
        ? `<label class="media-track-control"><span>Версия видео</span><select data-video-variant aria-label="Выберите видео">${variantOptions}</select></label>`
        : '';
    return `<section class="media-card" data-player="${index}" data-file-id="${id}"><div class="media-title">${icon('play')}${name}</div><video controls preload="metadata" playsinline src="${esc(url)}" aria-label="${name}"><a href="${esc(url)}">Открыть видео</a></video><div class="media-tools">${variantPicker}${button('−10 с','rewind','','small')}${button('+10 с','forward','','small')}<label>Скорость<select data-speed aria-label="Скорость воспроизведения">${[.5,.75,1,1.25,1.5,1.75,2].map(n=>`<option ${n===1?'selected':''}>${n}</option>`).join('')}</select></label>${button('На весь экран','fullscreen','','small')}<span class="media-status" aria-live="polite">Позиция синхронизируется с аккаунтом</span></div></section>`;
}

export function fileMarkup(file, index) {
    const url = fileUrl(file);
    if (!url) return '';
    const kind = mediaRole(file);
    const name = esc(file.file_name || file.name || `Материал ${index + 1}`);
    if (kind === 'video') return videoMarkup(file, index);
    if (kind === 'audio' || kind === 'voiceover') return `<section class="media-card" data-player="${index}" data-file-id="${Number(file.id) || ''}"><div class="media-title">${icon('play')}${kind==='audio'?'Отдельное аудио · можно слушать независимо':'Аудио к уроку'} · ${name}</div><audio controls preload="metadata" src="${esc(url)}" aria-label="Аудио к уроку: ${name}"><a href="${esc(url)}">Открыть аудио</a></audio><div class="media-tools"><label>Скорость<select data-speed aria-label="Скорость воспроизведения">${[.5,.75,1,1.25,1.5,1.75,2].map(n=>`<option ${n===1?'selected':''}>${n}</option>`).join('')}</select></label><span class="media-status" aria-live="polite">Позиция синхронизируется с аккаунтом</span></div></section>`;
    const downloadUrl = safeUrl(`${url}${url.includes('?')?'&':'?'}download=1`);
    if (kind === 'image') return `<div class="media-card"><img class="media-image" src="${esc(url)}" alt="${name}" loading="lazy"><div class="media-title"><a href="${esc(url)}" target="_blank" rel="noopener">${name}</a></div><div class="material-actions"><a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Открыть</a><a class="btn small" href="${esc(downloadUrl)}">Скачать</a></div></div>`;
    const title = kind === 'notes' ? 'Конспект / текстовый материал' : 'Учебный материал';
    return `<section class="list-row material-row"><span class="material-icon">${icon('file')}</span><div class="grow"><strong>${kind==='notes'?title:name}</strong><p>${kind==='notes'?name:'Материал урока'}${file.caption?` · ${esc(file.caption)}`:''}</p><div class="material-actions"><a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Открыть</a><a class="btn small" href="${esc(downloadUrl)}">Скачать</a></div></div></section>`;
}

export function lessonMediaMarkup(files) {
    const videos = files.filter(file => mediaRole(file) === 'video' && mediaKind(file) === 'video');
    const subtitleVideos = files.filter(file => mediaRole(file) === 'subtitle' && mediaKind(file) === 'video');
    const voiceoverVideos = files.filter(file => mediaRole(file) === 'voiceover' && mediaKind(file) === 'video');
    const variants = [
        ...subtitleVideos.map(file => ({file, role:'subtitle'})),
        ...voiceoverVideos.map(file => ({file, role:'voiceover'}))
    ];
    const audio = files.filter(file => mediaRole(file) === 'audio' ||
        (mediaRole(file) === 'voiceover' && mediaKind(file) === 'audio'));
    const consumed = new Set([...videos, ...subtitleVideos, ...voiceoverVideos, ...audio]);
    const other = files.filter(file => !consumed.has(file));
    const mainVideo = videos[0] || variants[0]?.file;
    const mainRole = videos.length ? 'original' : variants[0]?.role;
    const mainVariants = videos.length ? variants : variants.slice(1);
    const videoCount = mainVideo ? Math.max(1, videos.length) : 0;
    return [
        ...(mainVideo ? [videoMarkup(mainVideo, 0, mainVariants, mainRole)] : []),
        ...videos.slice(1).map((file, index) => videoMarkup(file, index + 1)),
        ...audio.map((file, index) => fileMarkup(file, videoCount + index)),
        ...other.map((file, index) => fileMarkup(file, videoCount + audio.length + index))
    ].join('');
}

export async function attachPlayers(root, lessonId) {
    const disposers = [];
    for (const card of $$('[data-player]', root)) {
        const media = $('video,audio', card);
        const status = $('.media-status', card);
        const fileId = Number(card.dataset.fileId) || null;
        const variantSelect = $('[data-video-variant]', card);
        let lastSaved = -1, lastTime = 0, queue = Promise.resolve(), alive = true, loaded = false, variantGeneration = 0;
        const body = () => ({lesson_id:Number(lessonId), ...(fileId ? {file_id:fileId} : {}), position_seconds:Number(media.currentTime) || 0, duration_seconds:Number.isFinite(media.duration) ? media.duration : 0});
        const save = (final = false) => {
            if (!loaded || !Number.isFinite(media.duration)) return;
            const snapshot = body();
            if (Math.abs(snapshot.position_seconds - lastSaved) < 1) return;
            lastSaved = snapshot.position_seconds;
            status.textContent = 'Сохраняем позицию…';
            if (final) {
                fetch('/api/progress',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot),keepalive:true}).catch(()=>{});
                return;
            }
            queue = queue.catch(()=>{}).then(()=>api('/progress',{method:'POST',body:snapshot})).then(()=>{if(alive)status.textContent='Позиция сохранена'}).catch(error=>{lastSaved=-1;if(alive)status.textContent='Не сохранено: '+error.message});
        };
        const changeVariant = () => {
            const option = variantSelect?.selectedOptions[0];
            const nextUrl = option?.dataset.videoUrl;
            if (!nextUrl || media.src === new URL(nextUrl, location.href).href) return;
            save();
            const generation = ++variantGeneration;
            const position = Number(media.currentTime) || 0;
            const wasPlaying = !media.paused;
            const restore = () => {
                if (!alive || generation !== variantGeneration) return;
                if (position > 0) {
                    try { media.currentTime = Math.min(position, Number.isFinite(media.duration) ? Math.max(0, media.duration - .25) : position); } catch {}
                }
                if (wasPlaying) media.play().catch(()=>{if(alive)status.textContent='Не удалось запустить выбранное видео'});
            };
            media.addEventListener('loadedmetadata', restore, {once:true});
            media.src = nextUrl;
            media.load();
        };
        const resume = async () => {
            try {
                const r = await api(`/progress?lesson_id=${lessonId}${fileId ? `&file_id=${fileId}` : ''}`);
                const p = r.progress || r, seconds = Number(p.position_seconds) || 0;
                if (alive && seconds > 0 && seconds < media.duration - 2) {
                    media.currentTime = seconds;
                    status.textContent = 'Продолжаем с сохранённой позиции';
                }
            } catch { if (alive) status.textContent = 'Не удалось загрузить позицию'; }
            finally { loaded = true; }
        };
        if (media.readyState >= 1) resume();
        else media.addEventListener('loadedmetadata', resume, {once:true});
        const tick = () => {
            if (Date.now() - lastTime >= 10000) { lastTime = Date.now(); save(); }
        };
        const pause = () => save();
        media.addEventListener('timeupdate', tick);
        media.addEventListener('pause', pause);
        media.addEventListener('ended', pause);
        media.addEventListener('error',()=>{status.textContent='Не удалось открыть файл. Обновите страницу или обратитесь в поддержку.'});
        variantSelect?.addEventListener('change', changeVariant);
        $('[data-speed]',card).onchange = e => media.playbackRate = Number(e.target.value);
        card.addEventListener('click',async e=>{
            const b=e.target.closest('[data-action]');if(!b)return;
            const a=b.dataset.action;
            if(a==='rewind')media.currentTime=Math.max(0,media.currentTime-10);
            if(a==='forward')media.currentTime=Math.min(media.duration||0,media.currentTime+10);
            if(a==='fullscreen')try{if(media.requestFullscreen)await media.requestFullscreen();else if(media.webkitEnterFullscreen)media.webkitEnterFullscreen()}catch{status.textContent='Полноэкранный режим недоступен в этом браузере'}
        });
        const hide = () => save(true);
        window.addEventListener('pagehide', hide);
        disposers.push(()=>{
            save(); alive=false; media.pause();
            media.removeEventListener('timeupdate',tick);
            media.removeEventListener('pause',pause); media.removeEventListener('ended',pause);
            variantSelect?.removeEventListener('change',changeVariant);
            window.removeEventListener('pagehide',hide);
        });
    }
    return ()=>disposers.forEach(fn=>fn());
}
