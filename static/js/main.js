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

        function showToast(message, type = 'error') {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.innerHTML = `
                <span class="toast-icon">${type === 'error' ? '⚠️' : '✅'}</span>
                <span>${message}</span>
            `;
            container.appendChild(toast);
            setTimeout(() => {
                if (toast.parentNode) toast.remove();
            }, 4500);
        }

        const ACCEPTED_EXTENSIONS = ['.mp4', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.webm'];

        function isValidFile(file) {
            const ext = '.' + file.name.split('.').pop().toLowerCase();
            return ACCEPTED_EXTENSIONS.includes(ext);
        }

        /* ═══════════════════════════════════════════
           STATE
           ═══════════════════════════════════════════ */
        let sepFile = null;
        let sepFilePath = null;
        let sepTaskId = null;
        let sepPollingInterval = null;

        let idFile = null;
        let idFilePath = null;

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
        const sepPercent = document.getElementById('sepPercent');
        const sepProgressFill = document.getElementById('sepProgressFill');
        const sepResults = document.getElementById('sepResults');
        const sepLoading = document.getElementById('separateLoading');
        const sepReset = document.getElementById('sepReset');

        setupDropzone(sepDropzone, sepFileInput, (file) => {
            if (!isValidFile(file)) {
                showToast('Formato de archivo no soportado. Usa: ' + ACCEPTED_EXTENSIONS.join(', '));
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
            sepFilePath = null;
            sepFileInput.value = '';
            sepFileInfo.classList.remove('visible');
            sepBtn.disabled = true;
        });

        sepBtn.addEventListener('click', async () => {
            if (!sepFile) return;

            // Upload first
            sepBtn.disabled = true;
            sepLoading.classList.add('visible');
            sepLoading.querySelector('.loading-text').textContent = 'Subiendo archivo…';

            try {
                const formData = new FormData();
                formData.append('file', sepFile);

                const uploadRes = await fetch('/upload', { method: 'POST', body: formData });
                if (!uploadRes.ok) throw new Error('Error al subir el archivo');

                const uploadData = await uploadRes.json();
                sepFilePath = uploadData.filepath;

                sepLoading.classList.remove('visible');

                // Start separation
                sepBtn.innerHTML = '<div class="spinner"></div> Separando…';
                sepProgress.classList.add('visible');
                sepDropzone.style.display = 'none';
                sepFileInfo.style.display = 'none';

                const sepRes = await fetch('/separate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filepath: sepFilePath })
                });

                if (!sepRes.ok) throw new Error('Error al iniciar la separación');

                const sepData = await sepRes.json();
                sepTaskId = sepData.task_id;

                // Poll status
                pollSeparationStatus();

            } catch (err) {
                sepLoading.classList.remove('visible');
                sepBtn.disabled = false;
                sepBtn.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line>
                    </svg>
                    Separar
                `;
                showToast(err.message);
            }
        });

        function pollSeparationStatus() {
            sepPollingInterval = setInterval(async () => {
                try {
                    const res = await fetch(`/status/${sepTaskId}`);
                    if (!res.ok) throw new Error('Error al consultar estado');

                    const data = await res.json();

                    // Update progress
                    const progress = data.progress || 0;
                    sepProgressFill.style.width = progress + '%';
                    sepPercent.textContent = progress + '%';

                    if (data.status === 'complete' || data.status === 'completed' || data.status === 'done') {
                        clearInterval(sepPollingInterval);
                        sepPollingInterval = null;

                        // Show results
                        sepProgress.classList.remove('visible');
                        sepBtn.style.display = 'none';

                        const instrumentalFile = data.files.instrumental;
                        const vocalsFile = data.files.vocals;

                        // Set audio sources
                        document.getElementById('instrumentalPlayer').src = `/stream/${instrumentalFile}`;
                        document.getElementById('vocalsPlayer').src = `/stream/${vocalsFile}`;

                        // Set download links
                        document.getElementById('downloadInstrumental').href = `/download/${instrumentalFile}`;
                        document.getElementById('downloadVocals').href = `/download/${vocalsFile}`;

                        // Store instrumental filename for identify
                        document.getElementById('identifyFromSep').dataset.filename = instrumentalFile;

                        sepResults.classList.add('visible');
                        sepReset.classList.add('visible');

                        showToast('¡Separación completada!', 'success');
                    } else if (data.status === 'error' || data.status === 'failed') {
                        clearInterval(sepPollingInterval);
                        sepPollingInterval = null;
                        showToast('Error durante la separación');
                        resetSeparation();
                    }

                } catch (err) {
                    clearInterval(sepPollingInterval);
                    sepPollingInterval = null;
                    showToast(err.message);
                    resetSeparation();
                }
            }, 1000);
        }

        // Identify from instrumental
        document.getElementById('identifyFromSep').addEventListener('click', async function () {
            const btn = this;
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<div class="spinner"></div> Buscando…';
            btn.disabled = true;

            try {
                // The instrumental file is on the server, we need the filepath
                // We'll use the instrumental filename to construct the path
                const instrumentalFilename = btn.dataset.filename;

                const res = await fetch('/identify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filepath: instrumentalFilename })
                });

                if (!res.ok) throw new Error('No se pudo identificar la canción');

                const data = await res.json();

                // Show inline result
                const container = document.getElementById('inlineIdentifyResult');

                document.getElementById('inlineSongTitle').textContent = data.title || 'Desconocido';
                document.getElementById('inlineSongArtist').textContent = data.artist || 'Artista desconocido';
                document.getElementById('inlineSongAlbum').textContent = data.album ? `Álbum: ${data.album}` : '';

                const coverEl = document.getElementById('inlineSongCover');
                if (data.cover_url) {
                    coverEl.innerHTML = `<img src="${data.cover_url}" alt="Portada del álbum">`;
                } else {
                    coverEl.innerHTML = '🎵';
                }

                container.classList.add('visible');
                showToast('¡Canción identificada!', 'success');

            } catch (err) {
                showToast(err.message);
            } finally {
                btn.innerHTML = originalHTML;
                btn.disabled = false;
            }
        });

        function resetSeparation() {
            sepFile = null;
            sepFilePath = null;
            sepTaskId = null;
            if (sepPollingInterval) {
                clearInterval(sepPollingInterval);
                sepPollingInterval = null;
            }
            sepFileInput.value = '';
            sepFileInfo.classList.remove('visible');
            sepBtn.disabled = true;
            sepBtn.style.display = '';
            sepBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line>
                </svg>
                Separar
            `;
            sepProgress.classList.remove('visible');
            sepProgressFill.style.width = '0%';
            sepPercent.textContent = '0%';
            sepResults.classList.remove('visible');
            sepReset.classList.remove('visible');
            sepDropzone.style.display = '';
            document.getElementById('inlineIdentifyResult').classList.remove('visible');

            // Pause audio
            document.getElementById('instrumentalPlayer').pause();
            document.getElementById('vocalsPlayer').pause();
            document.getElementById('instrumentalPlayer').src = '';
            document.getElementById('vocalsPlayer').src = '';
        }

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
            if (!isValidFile(file)) {
                showToast('Formato de archivo no soportado. Usa: ' + ACCEPTED_EXTENSIONS.join(', '));
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
            idFilePath = null;
            idFileInputEl.value = '';
            idFileInfo.classList.remove('visible');
            idBtn.disabled = true;
        });

        idBtn.addEventListener('click', async () => {
            if (!idFile) return;

            idBtn.disabled = true;
            idLoading.classList.add('visible');
            idLoading.querySelector('.loading-text').textContent = 'Subiendo archivo…';

            try {
                // Upload
                const formData = new FormData();
                formData.append('file', idFile);

                const uploadRes = await fetch('/upload', { method: 'POST', body: formData });
                if (!uploadRes.ok) throw new Error('Error al subir el archivo');

                const uploadData = await uploadRes.json();
                idFilePath = uploadData.filepath;

                // Identify
                idLoading.querySelector('.loading-text').textContent = 'Identificando canción…';

                const idRes = await fetch('/identify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filepath: idFilePath })
                });

                if (!idRes.ok) throw new Error('No se pudo identificar la canción');

                const data = await idRes.json();

                idLoading.classList.remove('visible');

                // Show result
                document.getElementById('idSongTitle').textContent = data.title || 'Desconocido';
                document.getElementById('idSongArtist').textContent = data.artist || 'Artista desconocido';
                document.getElementById('idSongAlbum').textContent = data.album ? `Álbum: ${data.album}` : '';

                const coverEl = document.getElementById('idSongCover');
                if (data.cover_url) {
                    coverEl.innerHTML = `<img src="${data.cover_url}" alt="Portada del álbum">`;
                } else {
                    coverEl.innerHTML = '🎵';
                }

                idDropzone.style.display = 'none';
                idFileInfo.style.display = 'none';
                idBtn.style.display = 'none';
                idResult.classList.add('visible');
                idResetDiv.classList.add('visible');

                showToast('¡Canción identificada!', 'success');

            } catch (err) {
                idLoading.classList.remove('visible');
                idBtn.disabled = false;
                idBtn.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    Identificar
                `;
                showToast(err.message);
            }
        });

        function resetIdentify() {
            idFile = null;
            idFilePath = null;
            idFileInputEl.value = '';
            idFileInfo.classList.remove('visible');
            idBtn.disabled = true;
            idBtn.style.display = '';
            idBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                Identificar
            `;
            idResult.classList.remove('visible');
            idResetDiv.classList.remove('visible');
            idDropzone.style.display = '';
        }

        /* ═══════════════════════════════════════════
           CLEANUP ON UNLOAD
           ═══════════════════════════════════════════ */
        window.addEventListener('beforeunload', () => {
            fetch('/cleanup', { method: 'POST', keepalive: true }).catch(() => {});
        });
