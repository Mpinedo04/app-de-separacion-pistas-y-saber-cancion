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
        const sepBtn = document.getElementById('sepBtn');
        const sepProgress = document.getElementById('sepProgress');
        const sepProgressText = sepProgress.querySelector('.progress-text');
        const sepPercent = document.getElementById('sepPercent');
        const sepProgressFill = document.getElementById('sepProgressFill');
        const sepResults = document.getElementById('sepResults');
        const sepLoading = document.getElementById('separateLoading');
        const sepReset = document.getElementById('sepReset');

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
                    body: JSON.stringify({ filename: uploadData.filename, original_name: sepFile.name })
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
                if (data.status === 'queued') {
                    sepProgressText.textContent = 'En cola, esperando otra separación…';
                } else if (data.eta_seconds != null) {
                    sepProgressText.textContent = `Separando pistas… quedan ${formatDuration(data.eta_seconds)}`;
                } else {
                    sepProgressText.textContent = 'Separando pistas… (puede tardar varios minutos)';
                }

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

        function setupResult(stem, file, downloadLabel, originalStem) {
            const player = document.getElementById(`${stem}Player`);
            const link = document.getElementById(`download${stem[0].toUpperCase()}${stem.slice(1)}`);
            const card = player.closest('.result-card');
            if (!file) {
                card.style.display = 'none';
                return false;
            }
            card.style.display = '';
            const encoded = encodeURIComponent(file);
            const ext = file.slice(file.lastIndexOf('.'));
            const niceName = `${originalStem} (${downloadLabel})${ext}`;
            player.src = `/stream/${encoded}`;
            link.href = `/download/${encoded}?name=${encodeURIComponent(niceName)}`;
            return true;
        }

        function showSeparationResults(data) {
            sepProgress.classList.remove('visible');
            sepBtn.style.display = 'none';
            sepDropzone.style.display = 'none';
            sepFileInfo.style.display = 'none';

            const originalStem = stemName(data.original_name || 'pista');
            const files = data.files || {};
            const hasInstrumental = setupResult('instrumental', files.instrumental, 'Instrumental', originalStem);
            const hasVocals = setupResult('vocals', files.vocals, 'Voz', originalStem);
            if (!hasInstrumental || !hasVocals) {
                showToast('El separador solo generó una de las dos pistas');
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
            document.getElementById('inlineIdentifyResult').classList.remove('visible');

            // Stop audio
            ['instrumentalPlayer', 'vocalsPlayer'].forEach(id => {
                const player = document.getElementById(id);
                player.pause();
                player.removeAttribute('src');
                player.load();
            });
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
