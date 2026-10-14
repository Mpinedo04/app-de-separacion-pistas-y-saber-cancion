import { confetti, morph, reducedMotion, setupRipples, setupSpotlight, tweenNumber } from './fx.js';
import { Mixer, formatClock } from './mixer.js';

/* ═══════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════ */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `~${minutes} min` : `~${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function stemName(filename) {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(0, dot) : filename;
}

function showToast(message, type = 'error') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'error' ? '⚠️' : '✓';
    const text = document.createElement('span');
    // textContent: server messages may contain file names, never treat them as HTML
    text.textContent = message;
    const timer = document.createElement('span');
    timer.className = 'toast-timer';
    const lifetime = type === 'error' ? 8000 : 4500;
    timer.style.animationDuration = `${lifetime}ms`;
    toast.append(icon, text, timer);
    container.appendChild(toast);

    const dismiss = () => {
        if (toast.classList.contains('leaving')) return;
        toast.classList.add('leaving');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        setTimeout(() => toast.remove(), 600);
    };
    toast.addEventListener('click', dismiss);
    setTimeout(dismiss, lifetime);
}

/** fetch() that returns parsed JSON and throws the server's own error message. */
async function apiFetch(url, options, fallbackError) {
    let res;
    try {
        res = await fetch(url, options);
    } catch {
        throw new Error('No se pudo conectar con el servidor. ¿Sigue abierto SoundForge?');
    }
    let data = null;
    try {
        data = await res.json();
    } catch { /* non-JSON response */ }
    if (!res.ok) {
        const err = new Error((data && data.error) || fallbackError);
        err.status = res.status;
        throw err;
    }
    return data || {};
}

/** POST a FormData with upload progress (fetch cannot report it). */
function uploadWithProgress(url, formData, { onProgress, onUploaded } = {}, fallbackError) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.responseType = 'json';
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        });
        xhr.upload.addEventListener('load', () => onUploaded && onUploaded());
        xhr.addEventListener('load', () => {
            const data = xhr.response;
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data || {});
            } else {
                const err = new Error((data && data.error) || fallbackError);
                err.status = xhr.status;
                reject(err);
            }
        });
        xhr.addEventListener('error', () => {
            reject(new Error('No se pudo conectar con el servidor. ¿Sigue abierto SoundForge?'));
        });
        xhr.send(formData);
    });
}

// Keep in sync with ALLOWED_EXTENSIONS in app.py
const ACCEPTED_EXTENSIONS = [
    '.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma', '.opus',
    '.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.ts',
];

// Keep in sync with MAX_UPLOAD_MB in app.py. Checked here because the
// server drops the connection on oversized uploads instead of replying.
const MAX_UPLOAD_MB = 500;

/** Returns an error message, or null when the file can be used. */
function validateFile(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        return 'Formato de archivo no soportado. Usa: ' + ACCEPTED_EXTENSIONS.join(', ');
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        return `El archivo pesa ${formatFileSize(file.size)}; el máximo es ${MAX_UPLOAD_MB} MB`;
    }
    return null;
}

document.querySelectorAll('input[type="file"]').forEach(input => {
    input.accept = ACCEPTED_EXTENSIONS.join(',');
});
document.querySelectorAll('.dropzone-hint').forEach(hint => {
    hint.textContent = ACCEPTED_EXTENSIONS.join(' ');
});

const LAST_TASK_KEY = 'soundforge:lastTask';
const BASE_TITLE = document.title;

function rememberTask(taskId) {
    try {
        if (taskId) localStorage.setItem(LAST_TASK_KEY, taskId);
        else localStorage.removeItem(LAST_TASK_KEY);
    } catch { /* storage unavailable */ }
}

function lastTask() {
    try {
        return localStorage.getItem(LAST_TASK_KEY);
    } catch {
        return null;
    }
}

/* ═══════════════════════════════════════════
   EFFECTS & HARDWARE CHIP
   ═══════════════════════════════════════════ */
setupSpotlight('.glass-card');
setupRipples();

(async function showHardware() {
    const chip = document.getElementById('systemChip');
    const text = document.getElementById('systemText');
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const info = await apiFetch('/system', undefined, '');
            if (info.checked) {
                chip.dataset.state = info.gpu ? 'gpu' : 'cpu';
                text.textContent = info.gpu ? `GPU · ${info.gpu.replace(/^NVIDIA\s+/i, '')}` : 'Solo CPU (más lento)';
                return;
            }
        } catch { /* server busy; retry */ }
        await new Promise(r => setTimeout(r, 1500));
    }
    chip.hidden = true;
})();

/* ═══════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════ */
// Display names and colours; keys in sync with MODES in app.py,
// colours in sync with the --stem-* tokens in styles.css
const STEM_INFO = {
    vocals: { label: 'Voz', emoji: '🎤', color: '#f472b6' },
    drums: { label: 'Batería', emoji: '🥁', color: '#fb923c' },
    bass: { label: 'Bajo', emoji: '🔊', color: '#60a5fa' },
    guitar: { label: 'Guitarra', emoji: '🎸', color: '#4ade80' },
    piano: { label: 'Piano', emoji: '🎹', color: '#c084fc' },
    other: { label: 'Otros', emoji: '🎶', color: '#22d3ee' },
    instrumental: { label: 'Instrumental', emoji: '🎵', color: '#818cf8' },
};
const MODE_STEMS = {
    vocals: ['vocals', 'instrumental'],
    multitrack: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
};

let sepFile = null;
let sepMode = 'vocals';
let sepTaskId = null;
let sepPollTimer = null;
let sepSourceFile = null;
let sepSawProgress = false;
let elapsedTimer = null;
let elapsedOrigin = 0;

let idFile = null;

/* ═══════════════════════════════════════════
   DRAG & DROP SETUP
   ═══════════════════════════════════════════ */
function setupDropzone(dropzoneEl, fileInput, onFileSelected) {
    dropzoneEl.addEventListener('click', (e) => {
        if (e.target === fileInput) return;
        fileInput.click();
    });

    dropzoneEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            onFileSelected(fileInput.files[0]);
        }
    });

    // dragleave fires when moving over children, so count enters/leaves
    let depth = 0;
    dropzoneEl.addEventListener('dragenter', (e) => {
        e.preventDefault();
        depth++;
        dropzoneEl.classList.add('drag-over');
    });
    dropzoneEl.addEventListener('dragover', (e) => e.preventDefault());
    dropzoneEl.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (!depth) dropzoneEl.classList.remove('drag-over');
    });
    dropzoneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0;
        dropzoneEl.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            onFileSelected(files[0]);
        }
    });
}

/* ═══════════════════════════════════════════
   SEPARATION LOGIC
   ═══════════════════════════════════════════ */
const cardsGrid = document.getElementById('cardsGrid');
const sepCard = document.getElementById('separateCard');
const sepDropzone = document.getElementById('sepDropzone');
const sepFileInput = document.getElementById('sepFileInput');
const sepFileInfo = document.getElementById('sepFileInfo');
const sepFileName = document.getElementById('sepFileName');
const sepFileSize = document.getElementById('sepFileSize');
const sepFileRemove = document.getElementById('sepFileRemove');
const sepModePicker = document.getElementById('sepModePicker');
const sepBtn = document.getElementById('sepBtn');
const sepProgress = document.getElementById('sepProgress');
const sepProgressText = document.getElementById('sepProgressText');
const sepPercent = document.getElementById('sepPercent');
const sepProgressFill = document.getElementById('sepProgressFill');
const sepForge = document.getElementById('sepForge');
const sepDevice = document.getElementById('sepDevice');
const sepStepper = document.getElementById('sepStepper');
const sepElapsed = document.getElementById('sepElapsed');
const sepResults = document.getElementById('sepResults');
const sepLoading = document.getElementById('separateLoading');
const sepUploadRing = document.getElementById('sepUploadRing');
const sepUploadPercent = document.getElementById('sepUploadPercent');
const sepReset = document.getElementById('sepReset');
const SEP_BTN_HTML = sepBtn.innerHTML;

const mixer = new Mixer(document.getElementById('mixer'));
document.getElementById('mixer').addEventListener('mixer-error', (e) => showToast(e.detail));

sepModePicker.querySelectorAll('.mode-option').forEach(option => {
    option.addEventListener('click', () => {
        sepMode = option.dataset.mode;
        sepModePicker.dataset.mode = sepMode;
        sepModePicker.querySelectorAll('.mode-option').forEach(o => {
            const active = o === option;
            o.classList.toggle('active', active);
            o.setAttribute('aria-checked', String(active));
        });
    });
});

setupDropzone(sepDropzone, sepFileInput, (file) => {
    const problem = validateFile(file);
    if (problem) {
        showToast(problem);
        return;
    }
    sepFile = file;
    sepFileName.textContent = file.name;
    sepFileSize.textContent = formatFileSize(file.size);
    // Restart the slide-in animation when swapping files
    sepFileInfo.classList.remove('visible');
    void sepFileInfo.offsetWidth;
    sepFileInfo.classList.add('visible');
    sepBtn.disabled = false;
});

sepFileRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    sepFile = null;
    sepFileInput.value = '';
    sepFileInfo.classList.remove('visible');
    sepBtn.disabled = true;
});

const RING_LENGTH = 2 * Math.PI * 44;

function setUploadProgress(fraction) {
    sepUploadRing.style.strokeDashoffset = String(RING_LENGTH * (1 - fraction));
    sepUploadPercent.textContent = `${Math.round(fraction * 100)}%`;
}

/** Bars shaped like a song; they take each stem's colour as it gets processed. */
function buildForge(mode) {
    const colors = (MODE_STEMS[mode] || MODE_STEMS.vocals).map(s => STEM_INFO[s].color);
    const count = window.innerWidth < 600 ? 32 : 56;
    sepForge.replaceChildren();
    for (let i = 0; i < count; i++) {
        const bar = document.createElement('i');
        const x = i / count;
        const envelope = 0.35 + 0.45 * Math.sin(Math.PI * x) + 0.2 * Math.sin(x * 23);
        bar.style.setProperty('--h', Math.min(1, Math.max(0.15, envelope + (Math.random() - 0.5) * 0.3)).toFixed(2));
        bar.style.setProperty('--d', `${(-Math.random() * 1.8).toFixed(2)}s`);
        bar.style.setProperty('--c', colors[i % colors.length]);
        sepForge.appendChild(bar);
    }
    sepForge.dataset.mode = mode;
}

function updateForge(progress) {
    const bars = sepForge.children;
    const done = Math.round((progress / 100) * bars.length);
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('done', i < done);
}

function startElapsed(elapsedSeconds) {
    elapsedOrigin = Date.now() - elapsedSeconds * 1000;
    if (elapsedTimer) return;
    const tick = () => {
        sepElapsed.textContent = `⏱ ${formatClock((Date.now() - elapsedOrigin) / 1000)}`;
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
}

function stopElapsed() {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    sepElapsed.textContent = '';
}

function showSeparationRunning(mode) {
    sepBtn.disabled = true;
    sepBtn.innerHTML = '<div class="spinner"></div> Separando…';
    sepBtn.style.display = 'none';
    sepDropzone.style.display = 'none';
    sepFileInfo.style.display = 'none';
    sepModePicker.style.display = 'none';
    sepCard.classList.add('busy');
    buildForge(mode);
    updateForge(0);
    sepPercent.textContent = '0%';
    sepProgressFill.style.width = '0%';
    sepProgressText.textContent = 'Preparando…';
    sepDevice.hidden = true;
    sepStepper.hidden = true;
    sepProgress.classList.add('visible');
}

sepBtn.addEventListener('click', async () => {
    if (!sepFile) return;

    sepBtn.disabled = true;
    setUploadProgress(0);
    sepLoading.querySelector('.loading-text').textContent = 'Subiendo archivo…';
    sepLoading.classList.add('visible');

    try {
        const formData = new FormData();
        formData.append('file', sepFile);

        const uploadData = await uploadWithProgress('/upload', formData, {
            onProgress: setUploadProgress,
            onUploaded: () => {
                sepLoading.querySelector('.loading-text').textContent = 'Preparando…';
            },
        }, 'Error al subir el archivo');

        sepLoading.classList.remove('visible');
        showSeparationRunning(sepMode);

        const sepData = await apiFetch('/separate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: uploadData.filename,
                original_name: sepFile.name,
                mode: sepMode,
            })
        }, 'Error al iniciar la separación');

        sepTaskId = sepData.task_id;
        sepSawProgress = true;
        rememberTask(sepTaskId);

        pollSeparationStatus();

    } catch (err) {
        sepLoading.classList.remove('visible');
        showToast(err.message);
        resetSeparation({ keepFile: true });
    }
});

function progressMessage(data) {
    if (data.status === 'queued') return 'En cola, esperando otra separación…';
    const eta = data.eta_seconds != null
        ? `quedan ${formatDuration(data.eta_seconds)}`
        : 'calculando tiempo…';
    if (data.steps === 2) {
        const what = data.step === 2 ? 'separando instrumentos' : 'separando la voz';
        return `Paso ${data.step || 1} de 2: ${what} · ${eta}`;
    }
    return `Separando pistas · ${eta}`;
}

function renderProgress(data) {
    if (sepForge.dataset.mode !== data.mode) buildForge(data.mode);
    const progress = data.progress || 0;
    tweenNumber(sepPercent, progress);
    sepProgressFill.style.width = progress + '%';
    updateForge(progress);
    sepProgressText.textContent = progressMessage(data);
    document.title = `${progress}% · Separando — SoundForge`;

    if (data.device && sepDevice.hidden) {
        sepDevice.dataset.device = data.device;
        sepDevice.textContent = data.device === 'gpu' ? '⚡ GPU' : '🐢 CPU';
        sepDevice.hidden = false;
    }

    if (data.steps === 2) {
        sepStepper.hidden = false;
        const step = data.step || 1;
        sepStepper.querySelectorAll('.step').forEach(el => {
            const n = Number(el.dataset.step);
            el.classList.toggle('active', n === step);
            el.classList.toggle('done', n < step);
        });
        sepStepper.querySelector('.step-line').style.setProperty('--p', step >= 2 ? '100%' : `${Math.min(100, (progress / 85) * 100)}%`);
    }

    if (data.status === 'processing' && data.elapsed_seconds != null) {
        startElapsed(data.elapsed_seconds);
    }
}

function pollSeparationStatus(networkFailures = 0) {
    // setTimeout chain instead of setInterval so slow responses never overlap
    sepPollTimer = setTimeout(async () => {
        const taskId = sepTaskId;
        if (!taskId) return;
        let data;
        try {
            data = await apiFetch(`/status/${taskId}`, undefined, 'Error al consultar estado');
        } catch (err) {
            if (taskId !== sepTaskId) return;
            // The separation keeps running server-side; tolerate brief hiccups
            if (!err.status && networkFailures < 5) {
                pollSeparationStatus(networkFailures + 1);
                return;
            }
            rememberTask(null);
            showToast(err.message);
            resetSeparation();
            return;
        }
        if (taskId !== sepTaskId) return;  // user reset meanwhile

        if (data.status === 'complete') {
            showSeparationResults(data, sepSawProgress);
            if (sepSawProgress) showToast('¡Separación completada!', 'success');
        } else if (data.status === 'error') {
            rememberTask(null);
            showToast('Error durante la separación: ' + (data.error || 'desconocido'));
            resetSeparation();
        } else {
            sepSawProgress = true;
            renderProgress(data);
            pollSeparationStatus();
        }
    }, 1000);
}

function downloadUrl(file, originalStem, label) {
    const ext = file.slice(file.lastIndexOf('.'));
    const niceName = `${originalStem} (${label})${ext}`;
    return `/download/${encodeURIComponent(file)}?name=${encodeURIComponent(niceName)}`;
}

function showSeparationResults(data, celebrate) {
    const originalStem = stemName(data.original_name || 'pista');
    const files = data.files || {};
    const multitrack = data.mode === 'multitrack';

    // In multitrack mode the instrumental is the sum of the instrument stems,
    // so it is offered as a download instead of a mixer track.
    // Flask sorts JSON keys alphabetically, so order by STEM_INFO.
    const order = Object.keys(STEM_INFO);
    const rank = stem => (order.includes(stem) ? order.indexOf(stem) : order.length);
    const stems = Object.entries(files)
        .filter(([stem, file]) => file && !(multitrack && stem === 'instrumental'))
        .sort(([a], [b]) => rank(a) - rank(b))
        .map(([stem, file]) => {
            const info = STEM_INFO[stem] || { label: stem, emoji: '🎵', color: '#8b5cf6' };
            return { stem, file, ...info, downloadUrl: downloadUrl(file, originalStem, info.label) };
        });

    const expected = multitrack ? 6 : 2;
    if (stems.length < expected) {
        showToast('El separador no generó todas las pistas');
    }

    document.getElementById('downloadAll').href =
        `/download-all/${sepTaskId}?name=${encodeURIComponent(originalStem)}`;
    const instrumentalLink = document.getElementById('downloadInstrumentalFull');
    instrumentalLink.classList.toggle('hidden', !(multitrack && files.instrumental));
    if (multitrack && files.instrumental) {
        instrumentalLink.href = downloadUrl(files.instrumental, originalStem, 'Instrumental');
    }
    document.getElementById('mixerSong').textContent = data.original_name || '';

    // Identify with the original mix (Shazam recognises it far better than
    // the instrumental); fall back to the instrumental if it was purged
    sepSourceFile = data.source || files.instrumental;

    stopElapsed();
    document.title = `✓ Listo — SoundForge`;

    morph(() => {
        cardsGrid.classList.add('studio');
        sepCard.classList.remove('busy');
        sepProgress.classList.remove('visible');
        sepBtn.style.display = 'none';
        sepDropzone.style.display = 'none';
        sepFileInfo.style.display = 'none';
        sepModePicker.style.display = 'none';
        sepResults.classList.add('visible');
        sepReset.classList.add('visible');
    });
    mixer.load(stems);

    if (celebrate) {
        setTimeout(() => confetti(sepCard), reducedMotion.matches ? 0 : 350);
    }
}

/* ═══════════════════════════════════════════
   SONG CARD (identify results)
   ═══════════════════════════════════════════ */
const songTemplate = document.getElementById('songCardTemplate');

function safeImageUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
    } catch {
        return '';
    }
}

function renderSong(container, data) {
    const card = songTemplate.content.firstElementChild.cloneNode(true);
    const cover = safeImageUrl(data.cover_url || '');
    if (cover) {
        card.style.setProperty('--cover', `url("${cover.replace(/"/g, '%22')}")`);
        const img = document.createElement('img');
        img.src = cover;
        img.alt = 'Portada del álbum';
        card.querySelector('.song-cover').replaceChildren(img);
    }
    const title = data.title || 'Desconocido';
    const artist = data.artist || 'Artista desconocido';
    card.querySelector('.song-title').textContent = title;
    card.querySelector('.song-artist').textContent = artist;
    card.querySelector('.song-album').textContent = data.album ? `Álbum: ${data.album}` : '';

    const query = encodeURIComponent(`${title} ${artist}`);
    const links = [
        ['Shazam', safeImageUrl(data.shazam_url || '')],
        ['Spotify', `https://open.spotify.com/search/${query}`],
        ['YouTube', `https://www.youtube.com/results?search_query=${query}`],
    ];
    const linksEl = card.querySelector('.song-links');
    links.filter(([, href]) => href).forEach(([name, href]) => {
        const a = document.createElement('a');
        a.className = 'song-link';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = `${name} ↗`;
        linksEl.appendChild(a);
    });

    container.replaceChildren(card);
    container.classList.add('visible');
}

// Identify the separated song
document.getElementById('identifyFromSep').addEventListener('click', async function () {
    const btn = this;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<div class="spinner"></div> Escuchando…';
    btn.disabled = true;

    try {
        const data = await apiFetch('/identify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: sepSourceFile })
        }, 'No se pudo identificar la canción');

        renderSong(document.getElementById('inlineIdentifyResult'), data);
        showToast('¡Canción identificada!', 'success');

    } catch (err) {
        showToast(err.message);
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
});

function resetSeparation({ keepFile = false } = {}) {
    sepTaskId = null;
    sepSourceFile = null;
    sepSawProgress = false;
    rememberTask(null);
    if (sepPollTimer) {
        clearTimeout(sepPollTimer);
        sepPollTimer = null;
    }
    stopElapsed();
    mixer.destroy();
    document.title = BASE_TITLE;

    if (!keepFile) {
        sepFile = null;
        sepFileInput.value = '';
        sepFileInfo.classList.remove('visible');
    }

    morph(() => {
        cardsGrid.classList.remove('studio');
        sepCard.classList.remove('busy');
        sepBtn.disabled = !sepFile;
        sepBtn.style.display = '';
        sepBtn.innerHTML = SEP_BTN_HTML;
        sepProgress.classList.remove('visible');
        sepProgressFill.style.width = '0%';
        sepPercent.textContent = '0%';
        sepResults.classList.remove('visible');
        sepReset.classList.remove('visible');
        sepDropzone.style.display = '';
        sepFileInfo.style.display = '';
        sepModePicker.style.display = '';
        const inline = document.getElementById('inlineIdentifyResult');
        inline.classList.remove('visible');
        inline.replaceChildren();
    });
}

document.getElementById('sepResetBtn').addEventListener('click', () => resetSeparation());

// Resume the last separation after a page reload (it keeps running on the server)
(function resumeLastSeparation() {
    const taskId = lastTask();
    if (!taskId) return;
    sepTaskId = taskId;
    showSeparationRunning('vocals');
    pollSeparationStatus();
})();

/* ═══════════════════════════════════════════
   KEYBOARD SHORTCUTS (mixer)
   ═══════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
    if (!sepResults.classList.contains('visible')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : document.body;
    const typing = target.closest('input, textarea, select, [contenteditable]');
    const interactive = target.closest('button, a, input, select, textarea');
    // Let focused controls keep Space/arrows; digits are safe anywhere but text fields
    if (/^(Space|ArrowLeft|ArrowRight)$/.test(e.code) ? interactive : typing) return;
    if (mixer.handleKey(e)) e.preventDefault();
});

/* ═══════════════════════════════════════════
   IDENTIFY LOGIC
   ═══════════════════════════════════════════ */
const idCard = document.getElementById('identifyCard');
const idDropzone = document.getElementById('idDropzone');
const idFileInputEl = document.getElementById('idFileInput');
const idFileInfo = document.getElementById('idFileInfo');
const idFileNameEl = document.getElementById('idFileName');
const idFileSizeEl = document.getElementById('idFileSize');
const idFileRemove = document.getElementById('idFileRemove');
const idBtn = document.getElementById('idBtn');
const idResult = document.getElementById('idResult');
const idLoading = document.getElementById('identifyLoading');
const idLoadingText = idLoading.querySelector('.loading-text');
const idResetDiv = document.getElementById('idReset');
const ID_BTN_HTML = idBtn.innerHTML;

setupDropzone(idDropzone, idFileInputEl, (file) => {
    const problem = validateFile(file);
    if (problem) {
        showToast(problem);
        return;
    }
    idFile = file;
    idFileNameEl.textContent = file.name;
    idFileSizeEl.textContent = formatFileSize(file.size);
    idFileInfo.classList.remove('visible');
    void idFileInfo.offsetWidth;
    idFileInfo.classList.add('visible');
    idBtn.disabled = false;
});

idFileRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    idFile = null;
    idFileInputEl.value = '';
    idFileInfo.classList.remove('visible');
    idBtn.disabled = true;
});

idBtn.addEventListener('click', async () => {
    if (!idFile) return;

    idBtn.disabled = true;
    idLoadingText.textContent = 'Subiendo…';
    idLoading.classList.add('visible');
    idCard.classList.add('busy');

    try {
        // One request: the server identifies the file and deletes it afterwards
        const formData = new FormData();
        formData.append('file', idFile);

        const data = await uploadWithProgress('/identify-file', formData, {
            onProgress: (f) => { idLoadingText.textContent = `Subiendo… ${Math.round(f * 100)}%`; },
            onUploaded: () => { idLoadingText.textContent = 'Escuchando…'; },
        }, 'No se pudo identificar la canción');

        idLoading.classList.remove('visible');
        idCard.classList.remove('busy');

        idDropzone.style.display = 'none';
        idFileInfo.style.display = 'none';
        idBtn.style.display = 'none';
        renderSong(idResult, data);
        idResetDiv.classList.add('visible');

        showToast('¡Canción identificada!', 'success');

    } catch (err) {
        idLoading.classList.remove('visible');
        idCard.classList.remove('busy');
        idBtn.disabled = false;
        idBtn.innerHTML = ID_BTN_HTML;
        showToast(err.message);
    }
});

function resetIdentify() {
    idFile = null;
    idFileInputEl.value = '';
    idFileInfo.classList.remove('visible');
    idFileInfo.style.display = '';
    idBtn.disabled = true;
    idBtn.style.display = '';
    idBtn.innerHTML = ID_BTN_HTML;
    idResult.classList.remove('visible');
    idResult.replaceChildren();
    idResetDiv.classList.remove('visible');
    idDropzone.style.display = '';
}

document.getElementById('idResetBtn').addEventListener('click', resetIdentify);
