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

        function showToast(message, type = 'error') {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const icon = document.createElement('span');
            icon.className = 'toast-icon';
            icon.textContent = type === 'error' ? '⚠️' : '✅';
            const text = document.createElement('span');
            // textContent: server messages may contain file names, never treat them as HTML
            text.textContent = message;
            toast.append(icon, text);
            container.appendChild(toast);
            setTimeout(() => {
                if (toast.parentNode) toast.remove();
            }, type === 'error' ? 8000 : 4500);
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

        function setCover(coverEl, url) {
            coverEl.replaceChildren();
            if (url) {
                const img = document.createElement('img');
                img.src = url;
                img.alt = 'Portada del álbum';
                coverEl.appendChild(img);
            } else {
                coverEl.textContent = '🎵';
            }
        }

        function stemName(filename) {
            const dot = filename.lastIndexOf('.');
            return dot > 0 ? filename.slice(0, dot) : filename;
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

        const SEP_BTN_HTML = document.getElementById('sepBtn').innerHTML;
        const ID_BTN_HTML = document.getElementById('idBtn').innerHTML;
        const LAST_TASK_KEY = 'soundforge:lastTask';

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
           STATE
           ═══════════════════════════════════════════ */
        let sepFile = null;
        let sepTaskId = null;
        let sepPollTimer = null;
        let sepSourceFile = null;

        let idFile = null;

        /* ═══════════════════════════════════════════
           DRAG & DROP SETUP
           ═══════════════════════════════════════════ */
        function setupDropzone(dropzoneEl, fileInput, onFileSelected) {
            // Click to browse
            dropzoneEl.addEventListener('click', (e) => {
                if (e.target === fileInput) return;
                fileInput.click();
            });

            fileInput.addEventListener('change', () => {
                if (fileInput.files.length > 0) {
                    onFileSelected(fileInput.files[0]);
                }
            });

            // Drag events
            ['dragenter', 'dragover'].forEach(evt => {
                dropzoneEl.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzoneEl.classList.add('drag-over');
                });
            });

            ['dragleave', 'drop'].forEach(evt => {
                dropzoneEl.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzoneEl.classList.remove('drag-over');
                });
            });

            dropzoneEl.addEventListener('drop', (e) => {
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    onFileSelected(files[0]);
                }
            });
        }

        /* ═══════════════════════════════════════════
           SEPARATION LOGIC
           ═══════════════════════════════════════════ */
        const sepDropzone = document.getElementById('sepDropzone');
        const sepFileInput = document.getElementById('sepFileInput');
        const sepFileInfo = document.getElementById('sepFileInfo');
        const sepFileName = document.getElementById('sepFileName');
        const sepFileSize = document.getElementById('sepFileSize');
        const sepFileRemove = document.getElementById('sepFileRemove');
        const sepModePicker = document.getElementById('sepModePicker');
        const sepBtn = document.getElementById('sepBtn');
        const sepProgress = document.getElementById('sepProgress');
        const sepProgressText = sepProgress.querySelector('.progress-text');
        const sepPercent = document.getElementById('sepPercent');
        const sepProgressFill = document.getElementById('sepProgressFill');
        const sepResults = document.getElementById('sepResults');
        const sepLoading = document.getElementById('separateLoading');
        const sepReset = document.getElementById('sepReset');

        // Display names; keep keys in sync with MODES in app.py
        const STEM_INFO = {
            vocals: { label: 'Voz', emoji: '🎤' },
            drums: { label: 'Batería', emoji: '🥁' },
            bass: { label: 'Bajo', emoji: '🔊' },
            guitar: { label: 'Guitarra', emoji: '🎸' },
            piano: { label: 'Piano', emoji: '🎹' },
            other: { label: 'Otros', emoji: '🎶' },
            instrumental: { label: 'Instrumental', emoji: '🎵' },
        };

        let sepMode = 'vocals';

        sepModePicker.querySelectorAll('.mode-option').forEach(option => {
            option.addEventListener('click', () => {
                sepMode = option.dataset.mode;
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

        function showSeparationRunning() {
            sepBtn.disabled = true;
            sepBtn.innerHTML = '<div class="spinner"></div> Separando…';
            sepProgress.classList.add('visible');
            sepDropzone.style.display = 'none';
            sepFileInfo.style.display = 'none';
            sepModePicker.style.display = 'none';
        }

        sepBtn.addEventListener('click', async () => {
            if (!sepFile) return;

            // Upload first
            sepBtn.disabled = true;
            sepLoading.classList.add('visible');
            sepLoading.querySelector('.loading-text').textContent = 'Subiendo archivo…';

            try {
                const formData = new FormData();
                formData.append('file', sepFile);

                const uploadData = await apiFetch('/upload', { method: 'POST', body: formData },
                    'Error al subir el archivo');

                sepLoading.classList.remove('visible');

                // Start separation
                showSeparationRunning();

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
            const device = { gpu: ' con la GPU', cpu: ' con la CPU' }[data.device] || '';
            const eta = data.eta_seconds != null
                ? `quedan ${formatDuration(data.eta_seconds)}`
                : '(puede tardar varios minutos)';
            if (data.steps === 2) {
                const what = data.step === 2 ? 'separando instrumentos' : 'separando la voz';
                return `Paso ${data.step || 1} de 2: ${what}${device}… ${eta}`;
            }
            return `Separando pistas${device}… ${eta}`;
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

                const progress = data.progress || 0;
                sepProgressFill.style.width = progress + '%';
                sepPercent.textContent = progress + '%';
                sepProgressText.textContent = progressMessage(data);

                if (data.status === 'complete') {
                    showSeparationResults(data);
                    showToast('¡Separación completada!', 'success');
                } else if (data.status === 'error') {
                    rememberTask(null);
                    showToast('Error durante la separación: ' + (data.error || 'desconocido'));
                    resetSeparation();
                } else {
                    pollSeparationStatus();
                }
            }, 1000);
        }

        /* ═══════════════════════════════════════════
           MIXER — plays every stem in sync
           ═══════════════════════════════════════════ */
        const mixerPlay = document.getElementById('mixerPlay');
        const mixerSeek = document.getElementById('mixerSeek');
        const mixerTime = document.getElementById('mixerTime');
        const mixerDuration = document.getElementById('mixerDuration');
        const mixerTracks = document.getElementById('mixerTracks');

        // Stems drift apart slightly when played as separate <audio> elements;
        // re-align any that is further than this from the master track
        const MAX_DRIFT_SECONDS = 0.08;

        let tracks = [];          // [{ stem, audio, row, muted, solo }]
        let mixerTimer = null;
        let mixerSeeking = false;

        const master = () => tracks[0] && tracks[0].audio;

        function formatClock(seconds) {
            if (!isFinite(seconds)) return '0:00';
            const s = Math.floor(seconds);
            return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }

        function downloadUrl(file, originalStem, label) {
            const ext = file.slice(file.lastIndexOf('.'));
            const niceName = `${originalStem} (${label})${ext}`;
            return `/download/${encodeURIComponent(file)}?name=${encodeURIComponent(niceName)}`;
        }

        function applyMuting() {
            const anySolo = tracks.some(t => t.solo);
            tracks.forEach(t => {
                const silent = anySolo ? !t.solo : t.muted;
                t.audio.muted = silent;
                t.row.classList.toggle('silent', silent);
            });
        }

        function makeTrackRow(track, file, originalStem) {
            const info = STEM_INFO[track.stem] || { label: track.stem, emoji: '🎵' };
            const row = document.createElement('div');
            row.className = 'mixer-track';

            const name = document.createElement('div');
            name.className = 'track-name';
            const emoji = document.createElement('span');
            emoji.textContent = info.emoji;
            const label = document.createElement('span');
            label.textContent = info.label;
            name.append(emoji, label);

            const toggle = (cls, text, title, key) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `track-btn ${cls}`;
                btn.textContent = text;
                btn.title = `${title}: ${info.label}`;
                btn.setAttribute('aria-pressed', 'false');
                btn.addEventListener('click', () => {
                    track[key] = !track[key];
                    btn.setAttribute('aria-pressed', String(track[key]));
                    applyMuting();
                });
                return btn;
            };

            const volume = document.createElement('input');
            volume.type = 'range';
            volume.className = 'track-volume';
            volume.min = '0';
            volume.max = '1';
            volume.step = '0.01';
            volume.value = '1';
            volume.setAttribute('aria-label', `Volumen de ${info.label}`);
            volume.addEventListener('input', () => { track.audio.volume = Number(volume.value); });

            const download = document.createElement('a');
            download.className = 'track-download';
            download.href = downloadUrl(file, originalStem, info.label);
            download.title = `Descargar ${info.label}`;
            download.setAttribute('aria-label', `Descargar ${info.label}`);
            download.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

            row.append(name, toggle('mute', 'M', 'Silenciar', 'muted'),
                toggle('solo', 'S', 'Solo', 'solo'), volume, download);
            return row;
        }

        function buildMixer(stemFiles, originalStem) {
            destroyMixer();
            tracks = stemFiles.map(([stem, file]) => {
                const audio = new Audio();
                audio.preload = 'auto';
                audio.src = `/stream/${encodeURIComponent(file)}`;
                const track = { stem, audio, muted: false, solo: false };
                track.row = makeTrackRow(track, file, originalStem);
                mixerTracks.appendChild(track.row);
                return track;
            });

            const m = master();
            if (!m) return;
            m.addEventListener('loadedmetadata', () => {
                mixerSeek.max = String(m.duration);
                mixerDuration.textContent = formatClock(m.duration);
                mixerSeek.disabled = false;
                mixerPlay.disabled = false;
            });
            m.addEventListener('ended', () => {
                pauseAll();
                seekAll(0);
            });
        }

        function syncTick() {
            const m = master();
            if (!m) return;
            if (!mixerSeeking) {
                mixerSeek.value = String(m.currentTime);
                mixerTime.textContent = formatClock(m.currentTime);
            }
            if (m.paused) return;
            tracks.slice(1).forEach(t => {
                if (!t.audio.ended && Math.abs(t.audio.currentTime - m.currentTime) > MAX_DRIFT_SECONDS) {
                    t.audio.currentTime = m.currentTime;
                }
            });
        }

        async function playAll() {
            const m = master();
            if (!m) return;
            tracks.forEach(t => { t.audio.currentTime = m.currentTime; });
            try {
                await Promise.all(tracks.map(t => t.audio.play()));
            } catch {
                pauseAll();
                showToast('No se pudo reproducir el audio');
                return;
            }
            mixerPlay.classList.add('playing');
            mixerPlay.setAttribute('aria-label', 'Pausar');
            clearInterval(mixerTimer);
            mixerTimer = setInterval(syncTick, 250);
        }

        function pauseAll() {
            tracks.forEach(t => t.audio.pause());
            mixerPlay.classList.remove('playing');
            mixerPlay.setAttribute('aria-label', 'Reproducir');
            clearInterval(mixerTimer);
            mixerTimer = null;
            syncTick();
        }

        function seekAll(seconds) {
            tracks.forEach(t => { t.audio.currentTime = seconds; });
            mixerTime.textContent = formatClock(seconds);
            mixerSeek.value = String(seconds);
        }

        function destroyMixer() {
            pauseAll();
            tracks.forEach(t => {
                t.audio.removeAttribute('src');
                t.audio.load();
            });
            tracks = [];
            mixerTracks.replaceChildren();
            mixerSeek.value = '0';
            mixerSeek.max = '0';
            mixerSeek.disabled = true;
            mixerPlay.disabled = true;
            mixerTime.textContent = '0:00';
            mixerDuration.textContent = '0:00';
        }

        mixerPlay.addEventListener('click', () => {
            const m = master();
            if (!m) return;
            if (m.paused) playAll(); else pauseAll();
        });

        mixerSeek.addEventListener('input', () => {
            mixerSeeking = true;
            mixerTime.textContent = formatClock(Number(mixerSeek.value));
        });

        mixerSeek.addEventListener('change', () => {
            mixerSeeking = false;
            seekAll(Number(mixerSeek.value));
        });

        function showSeparationResults(data) {
            sepProgress.classList.remove('visible');
            sepBtn.style.display = 'none';
            sepDropzone.style.display = 'none';
            sepFileInfo.style.display = 'none';
            sepModePicker.style.display = 'none';

            const originalStem = stemName(data.original_name || 'pista');
            const files = data.files || {};
            const multitrack = data.mode === 'multitrack';

            // In multitrack mode the instrumental is the sum of the instrument
            // stems, so it is offered as a download instead of a mixer track.
            // Flask sorts JSON keys alphabetically, so order by STEM_INFO.
            const order = Object.keys(STEM_INFO);
            const rank = stem => (order.includes(stem) ? order.indexOf(stem) : order.length);
            const mixerStems = Object.entries(files)
                .filter(([stem, file]) => file && !(multitrack && stem === 'instrumental'))
                .sort(([a], [b]) => rank(a) - rank(b));
            buildMixer(mixerStems, originalStem);

            const expected = multitrack ? 6 : 2;
            if (mixerStems.length < expected) {
                showToast('El separador no generó todas las pistas');
            }

            document.getElementById('downloadAll').href =
                `/download-all/${sepTaskId}?name=${encodeURIComponent(originalStem)}`;
            const instrumentalLink = document.getElementById('downloadInstrumentalFull');
            instrumentalLink.classList.toggle('hidden', !(multitrack && files.instrumental));
            if (multitrack && files.instrumental) {
                instrumentalLink.href = downloadUrl(files.instrumental, originalStem, 'Instrumental');
            }

            // Identify with the original mix (Shazam recognises it far better than
            // the instrumental); fall back to the instrumental if it was purged
            sepSourceFile = data.source || files.instrumental;

            sepResults.classList.add('visible');
            sepReset.classList.add('visible');
        }

        // Identify the separated song
        document.getElementById('identifyFromSep').addEventListener('click', async function () {
            const btn = this;
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<div class="spinner"></div> Buscando…';
            btn.disabled = true;

            try {
                const data = await apiFetch('/identify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: sepSourceFile })
                }, 'No se pudo identificar la canción');

                document.getElementById('inlineSongTitle').textContent = data.title || 'Desconocido';
                document.getElementById('inlineSongArtist').textContent = data.artist || 'Artista desconocido';
                document.getElementById('inlineSongAlbum').textContent = data.album ? `Álbum: ${data.album}` : '';
                setCover(document.getElementById('inlineSongCover'), data.cover_url);

                document.getElementById('inlineIdentifyResult').classList.add('visible');
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
            rememberTask(null);
            if (sepPollTimer) {
                clearTimeout(sepPollTimer);
                sepPollTimer = null;
            }
            if (!keepFile) {
                sepFile = null;
                sepFileInput.value = '';
                sepFileInfo.classList.remove('visible');
            }
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
            document.getElementById('inlineIdentifyResult').classList.remove('visible');

            destroyMixer();
        }

        // Resume the last separation after a page reload (it keeps running on the server)
        (function resumeLastSeparation() {
            const taskId = lastTask();
            if (!taskId) return;
            sepTaskId = taskId;
            showSeparationRunning();
            pollSeparationStatus();
        })();

        /* ═══════════════════════════════════════════
           IDENTIFY LOGIC
           ═══════════════════════════════════════════ */
        const idDropzone = document.getElementById('idDropzone');
        const idFileInputEl = document.getElementById('idFileInput');
        const idFileInfo = document.getElementById('idFileInfo');
        const idFileNameEl = document.getElementById('idFileName');
        const idFileSizeEl = document.getElementById('idFileSize');
        const idFileRemove = document.getElementById('idFileRemove');
        const idBtn = document.getElementById('idBtn');
        const idResult = document.getElementById('idResult');
        const idLoading = document.getElementById('identifyLoading');
        const idResetDiv = document.getElementById('idReset');

        setupDropzone(idDropzone, idFileInputEl, (file) => {
            const problem = validateFile(file);
            if (problem) {
                showToast(problem);
                return;
            }
            idFile = file;
            idFileNameEl.textContent = file.name;
            idFileSizeEl.textContent = formatFileSize(file.size);
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
            idLoading.classList.add('visible');
            idLoading.querySelector('.loading-text').textContent = 'Identificando canción…';

            try {
                // One request: the server identifies the file and deletes it afterwards
                const formData = new FormData();
                formData.append('file', idFile);

                const data = await apiFetch('/identify-file', { method: 'POST', body: formData },
                    'No se pudo identificar la canción');

                idLoading.classList.remove('visible');

                document.getElementById('idSongTitle').textContent = data.title || 'Desconocido';
                document.getElementById('idSongArtist').textContent = data.artist || 'Artista desconocido';
                document.getElementById('idSongAlbum').textContent = data.album ? `Álbum: ${data.album}` : '';
                setCover(document.getElementById('idSongCover'), data.cover_url);

                idDropzone.style.display = 'none';
                idFileInfo.style.display = 'none';
                idBtn.style.display = 'none';
                idResult.classList.add('visible');
                idResetDiv.classList.add('visible');

                showToast('¡Canción identificada!', 'success');

            } catch (err) {
                idLoading.classList.remove('visible');
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
            idResetDiv.classList.remove('visible');
            idDropzone.style.display = '';
        }
