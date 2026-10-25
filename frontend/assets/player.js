import {$,$$,api,esc,safeUrl} from './shared.js';

const audioExtensions = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;
const videoExtensions = /\.(mp4|webm|mov|m4v)$/i;
const languageNames = {ru:'Русский',kk:'Қазақша',en:'English',ar:'العربية',tr:'Türkçe'};

const pIcons = {
    play: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>',
    pause: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    volume: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    mute: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6"/></svg>',
    fullscreen: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
    file: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H4v20h16V8z M14 2v6h6 M8 13h8 M8 17h5"/></svg>'
};

function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

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
    const detail = languageNames[language] || (language ? language.toUpperCase() : '');
    const title = role === 'subtitle' ? 'Субтитры' : role === 'voiceover' ? 'Озвучка' : 'Озвучка / Оригинал';
    return `${title}${detail ? ` (${detail})` : ''}`;
}

function videoMarkup(file, index, variants = [], fileRole = 'original', meta = {}) {
    const url = fileUrl(file);
    if (!url) return '';
    const id = Number(file.id) || '';
    const subjectName = meta.subjectName || 'Предмет';
    const sheikhName = meta.sheikhName || '';
    const sources = [{file, role:fileRole}, ...variants];

    const variantOptions = sources.map((source, sourceIndex) => {
        const sourceUrl = fileUrl(source.file);
        if (!sourceUrl) return '';
        const label = variantLabel(source.file, source.role);
        return `<option value="${sourceIndex}" data-video-url="${esc(sourceUrl)}" data-video-label="${esc(label)}">${esc(label)}</option>`;
    }).join('');

    const variantPicker = `<div class="player-variant-switch"><label class="media-track-control"><span>Режим:</span><select data-video-variant aria-label="Выбор субтитров или озвучки">${variantOptions}</select></label></div>`;

    return `<section class="media-card custom-video-section" data-player="${index}" data-file-id="${id}" oncontextmenu="return false">
        <div class="player-header-bar">
            <div class="player-meta-info">
                <strong class="player-subject-title">${esc(subjectName)}</strong>
                ${sheikhName ? `<span class="player-sheikh-name">${esc(sheikhName)}</span>` : ''}
            </div>
            ${variantPicker}
        </div>
        <div class="custom-video-shell" data-video-container>
            <video preload="metadata" playsinline controlslist="nodownload noplaybackrate" disablepictureinpicture disableremoteplayback oncontextmenu="return false" src="${esc(url)}"></video>
            <div class="custom-player-controls">
                <button type="button" class="btn small player-btn" data-action="toggle-play" aria-label="Пуск / Пауза">${pIcons.play}</button>
                <button type="button" class="btn small player-btn" data-action="rewind" title="Назад 10 сек">−10с</button>
                <button type="button" class="btn small player-btn" data-action="forward" title="Вперёд 10 сек">+10с</button>
                <input type="range" class="player-seek" data-seek min="0" max="100" step="0.1" value="0" aria-label="Позиция воспроизведения">
                <span class="player-time" data-time>0:00 / 0:00</span>
                <select class="player-speed" data-speed aria-label="Скорость">${[.5,.75,1,1.25,1.5,1.75,2].map(n=>`<option value="${n}" ${n===1?'selected':''}>${n}x</option>`).join('')}</select>
                <button type="button" class="btn small player-btn" data-action="toggle-mute" aria-label="Звук">${pIcons.volume}</button>
                <button type="button" class="btn small player-btn" data-action="fullscreen" aria-label="На весь экран">${pIcons.fullscreen}</button>
            </div>
        </div>
        <div class="media-footer"><span class="media-status" aria-live="polite">Позиция синхронизируется с аккаунтом</span></div>
    </section>`;
}

export function fileMarkup(file, index, meta = {}) {
    const url = fileUrl(file);
    if (!url) return '';
    const kind = mediaRole(file);
    const name = esc(file.file_name || file.name || `Материал ${index + 1}`);
    if (kind === 'video') return videoMarkup(file, index, [], 'original', meta);
    if (kind === 'audio' || kind === 'voiceover') {
        return `<section class="media-card custom-audio-section" data-player="${index}" data-file-id="${Number(file.id) || ''}" oncontextmenu="return false">
            <div class="audio-format-header"><span>аудиоформат</span></div>
            <audio preload="metadata" controlslist="nodownload" disableremoteplayback oncontextmenu="return false" src="${esc(url)}"></audio>
            <div class="custom-player-controls audio-controls">
                <button type="button" class="btn small player-btn" data-action="toggle-play" aria-label="Пуск / Пауза">${pIcons.play}</button>
                <button type="button" class="btn small player-btn" data-action="rewind" title="Назад 10 сек">−10с</button>
                <button type="button" class="btn small player-btn" data-action="forward" title="Вперёд 10 сек">+10с</button>
                <input type="range" class="player-seek" data-seek min="0" max="100" step="0.1" value="0" aria-label="Позиция аудио">
                <span class="player-time" data-time>0:00 / 0:00</span>
                <select class="player-speed" data-speed aria-label="Скорость">${[.5,.75,1,1.25,1.5,1.75,2].map(n=>`<option value="${n}" ${n===1?'selected':''}>${n}x</option>`).join('')}</select>
                <button type="button" class="btn small player-btn" data-action="toggle-mute" aria-label="Звук">${pIcons.volume}</button>
            </div>
            <div class="media-footer"><span class="media-status" aria-live="polite">Позиция синхронизируется с аккаунтом</span></div>
        </section>`;
    }
    if (kind === 'image') {
        return `<div class="media-card" oncontextmenu="return false"><img class="media-image" src="${esc(url)}" alt="${name}" loading="lazy" draggable="false"></div>`;
    }
    const title = kind === 'notes' ? 'Конспект / текстовый материал' : 'Учебный материал';
    return `<section class="list-row material-row"><span class="material-icon">${pIcons.file}</span><div class="grow"><strong>${kind==='notes'?title:name}</strong><p>${kind==='notes'?name:'Материал урока'}${file.caption?` · ${esc(file.caption)}`:''}</p><div class="material-actions"><a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Открыть</a></div></div></section>`;
}

export function lessonMediaMarkup(files, meta = {}) {
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
        ...(mainVideo ? [videoMarkup(mainVideo, 0, mainVariants, mainRole, meta)] : []),
        ...videos.slice(1).map((file, index) => videoMarkup(file, index + 1, [], 'original', meta)),
        ...audio.map((file, index) => fileMarkup(file, videoCount + index, meta)),
        ...other.map((file, index) => fileMarkup(file, videoCount + audio.length + index, meta))
    ].join('');
}

export async function attachPlayers(root, lessonId) {
    const disposers = [];
    for (const card of $$('[data-player]', root)) {
        const media = $('video,audio', card);
        if (!media) continue;
        const status = $('.media-status', card);
        const fileId = Number(card.dataset.fileId) || null;
        const variantSelect = $('[data-video-variant]', card);
        const playBtn = $('[data-action="toggle-play"]', card);
        const muteBtn = $('[data-action="toggle-mute"]', card);
        const seekInput = $('[data-seek]', card);
        const timeLabel = $('[data-time]', card);
        const videoContainer = $('[data-video-container]', card) || card;

        let lastSaved = -1, lastTime = 0, queue = Promise.resolve(), alive = true, loaded = false, variantGeneration = 0, isSeeking = false;

        const preventDownload = e => e.preventDefault();
        card.addEventListener('contextmenu', preventDownload);
        media.addEventListener('contextmenu', preventDownload);
        media.addEventListener('dragstart', preventDownload);

        const updateUi = () => {
            if (playBtn) playBtn.innerHTML = media.paused ? pIcons.play : pIcons.pause;
            if (muteBtn) muteBtn.innerHTML = (media.muted || media.volume === 0) ? pIcons.mute : pIcons.volume;
            const dur = Number.isFinite(media.duration) ? media.duration : 0;
            const cur = Number(media.currentTime) || 0;
            if (timeLabel) timeLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
            if (seekInput && !isSeeking && dur > 0) {
                seekInput.value = String(Math.min(100, Math.max(0, (cur / dur) * 100)));
            }
        };

        const body = () => ({lesson_id:Number(lessonId), ...(fileId ? {file_id:fileId} : {}), position_seconds:Number(media.currentTime) || 0, duration_seconds:Number.isFinite(media.duration) ? media.duration : 0});
        const save = (final = false) => {
            if (!loaded || !Number.isFinite(media.duration)) return;
            const snapshot = body();
            if (Math.abs(snapshot.position_seconds - lastSaved) < 1) return;
            lastSaved = snapshot.position_seconds;
            if (status) status.textContent = 'Сохраняем позицию…';
            if (final) {
                fetch('/api/progress',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot),keepalive:true}).catch(()=>{});
                return;
            }
            queue = queue.catch(()=>{}).then(()=>api('/progress',{method:'POST',body:snapshot})).then(()=>{if(alive&&status)status.textContent='Позиция сохранена'}).catch(error=>{lastSaved=-1;if(alive&&status)status.textContent='Не сохранено: '+error.message});
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
                updateUi();
                if (wasPlaying) media.play().catch(()=>{if(alive&&status)status.textContent='Нажмите Пуск для продолжения'});
            };
            media.addEventListener('loadedmetadata', restore, {once:true});
            media.src = nextUrl;
            media.load();
        };

        const resume = async () => {
            updateUi();
            try {
                const r = await api(`/progress?lesson_id=${lessonId}${fileId ? `&file_id=${fileId}` : ''}`);
                const p = r.progress || r, seconds = Number(p.position_seconds) || 0;
                if (alive && seconds > 0 && seconds < media.duration - 2) {
                    media.currentTime = seconds;
                    updateUi();
                    if (status) status.textContent = 'Продолжаем с сохранённой позиции';
                }
            } catch { if (alive && status) status.textContent = 'Готово к воспроизведению'; }
            finally { loaded = true; updateUi(); }
        };

        if (media.readyState >= 1) resume();
        else media.addEventListener('loadedmetadata', resume, {once:true});

        const tick = () => {
            updateUi();
            if (Date.now() - lastTime >= 10000) { lastTime = Date.now(); save(); }
        };
        const onPlayPause = () => { updateUi(); if (media.paused) save(); };

        media.addEventListener('timeupdate', tick);
        media.addEventListener('play', onPlayPause);
        media.addEventListener('pause', onPlayPause);
        media.addEventListener('ended', onPlayPause);
        media.addEventListener('volumechange', updateUi);
        media.addEventListener('loadedmetadata', updateUi);
        media.addEventListener('error',()=>{if(status)status.textContent='Не удалось открыть медиафайл.'});

        if (media.tagName.toLowerCase() === 'video') {
            media.addEventListener('click', () => {
                if (media.paused) media.play().catch(()=>{});
                else media.pause();
            });
        }

        if (seekInput) {
            seekInput.addEventListener('input', () => {
                isSeeking = true;
                const dur = Number.isFinite(media.duration) ? media.duration : 0;
                if (dur > 0) {
                    const target = (Number(seekInput.value) / 100) * dur;
                    if (timeLabel) timeLabel.textContent = `${fmtTime(target)} / ${fmtTime(dur)}`;
                }
            });
            seekInput.addEventListener('change', () => {
                const dur = Number.isFinite(media.duration) ? media.duration : 0;
                if (dur > 0) media.currentTime = (Number(seekInput.value) / 100) * dur;
                isSeeking = false;
                updateUi();
            });
        }

        variantSelect?.addEventListener('change', changeVariant);
        const speedSelect = $('[data-speed]', card);
        if (speedSelect) speedSelect.onchange = e => { media.playbackRate = Number(e.target.value); };

        card.addEventListener('click', async e => {
            const b = e.target.closest('[data-action]');
            if (!b) return;
            const a = b.dataset.action;
            if (a === 'toggle-play') {
                if (media.paused) media.play().catch(()=>{});
                else media.pause();
            }
            if (a === 'toggle-mute') {
                media.muted = !media.muted;
                updateUi();
            }
            if (a === 'rewind') { media.currentTime = Math.max(0, (media.currentTime || 0) - 10); updateUi(); }
            if (a === 'forward') { media.currentTime = Math.min(media.duration || 0, (media.currentTime || 0) + 10); updateUi(); }
            if (a === 'fullscreen') {
                try {
                    if (document.fullscreenElement) await document.exitFullscreen();
                    else if (videoContainer.requestFullscreen) await videoContainer.requestFullscreen();
                    else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen();
                } catch { if (status) status.textContent = 'Полноэкранный режим недоступен'; }
            }
        });

        const hide = () => save(true);
        window.addEventListener('pagehide', hide);
        disposers.push(() => {
            save(); alive = false; media.pause();
            card.removeEventListener('contextmenu', preventDownload);
            media.removeEventListener('contextmenu', preventDownload);
            media.removeEventListener('dragstart', preventDownload);
            media.removeEventListener('timeupdate', tick);
            media.removeEventListener('play', onPlayPause);
            media.removeEventListener('pause', onPlayPause);
            media.removeEventListener('ended', onPlayPause);
            media.removeEventListener('volumechange', updateUi);
            media.removeEventListener('loadedmetadata', updateUi);
            variantSelect?.removeEventListener('change', changeVariant);
            window.removeEventListener('pagehide', hide);
        });
    }
    return () => disposers.forEach(fn => fn());
}
