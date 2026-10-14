/* Multitrack mixer: plays every stem in sync through the Web Audio API, with
   per-track waveform, level meter, mute/solo/volume and a master spectrum. */

import { setBeat, setLogoLevels } from './fx.js';

// Stems drift apart slightly when played as separate <audio> elements;
// re-align any that is further than this from the master track
const MAX_DRIFT_SECONDS = 0.08;
const SEEK_STEP_SECONDS = 5;
const WAVE_BAR = 2;
const WAVE_GAP = 1;

const DOWNLOAD_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

export function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setRangeFill(input) {
    const max = Number(input.max) || 1;
    input.style.setProperty('--fill', `${(Number(input.value) / max) * 100}%`);
}

/** Draw a mirrored bar waveform of `peaks` into `canvas`. */
function drawWave(canvas, peaks, color) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = color;
    const n = Math.floor(w / (WAVE_BAR + WAVE_GAP));
    const mid = h / 2;
    for (let i = 0; i < n; i++) {
        const from = Math.floor((i * peaks.length) / n);
        const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
        let v = 0;
        for (let j = from; j < to && j < peaks.length; j++) v = Math.max(v, peaks[j]);
        // sqrt: quiet passages stay visible without flattening loud ones
        const bh = Math.max(1.5, Math.sqrt(Math.min(1, v)) * (h - 4));
        ctx.fillRect(i * (WAVE_BAR + WAVE_GAP), mid - bh / 2, WAVE_BAR, bh);
    }
}

export class Mixer {
    constructor(root) {
        this.root = root;
        this.playBtn = root.querySelector('#mixerPlay');
        this.seek = root.querySelector('#mixerSeek');
        this.timeEl = root.querySelector('#mixerTime');
        this.durationEl = root.querySelector('#mixerDuration');
        this.tracksEl = root.querySelector('#mixerTracks');
        this.canvas = root.querySelector('#mixerVisualizer');

        this.tracks = [];
        this.ctx = null;
        this.analyser = null;
        this.freq = null;
        this.duration = 0;
        this.raf = null;
        this.syncTimer = null;
        this.seeking = false;
        this.lastSecond = -1;
        this.bars = [];
        this.caps = [];

        this.playBtn.addEventListener('click', () => this.toggle());
        this.seek.addEventListener('input', () => {
            this.seeking = true;
            setRangeFill(this.seek);
            this.timeEl.textContent = formatClock(Number(this.seek.value));
        });
        this.seek.addEventListener('change', () => {
            this.seeking = false;
            this.seekTo(Number(this.seek.value));
        });

        let resizeQueued = false;
        this.resizeObserver = new ResizeObserver(() => {
            if (resizeQueued) return;
            resizeQueued = true;
            requestAnimationFrame(() => {
                resizeQueued = false;
                this.tracks.forEach(t => this.renderWave(t));
            });
        });
        this.resizeObserver.observe(this.tracksEl);
    }

    get masterAudio() {
        return this.tracks[0] && this.tracks[0].audio;
    }

    get playing() {
        const m = this.masterAudio;
        return !!m && !m.paused;
    }

    /** stems: [{ stem, file, label, emoji, color, downloadUrl }] */
    load(stems) {
        this.destroy();
        this.tracks = stems.map((s, i) => this.createTrack(s, i));
        const m = this.masterAudio;
        if (!m) return;
        m.addEventListener('loadedmetadata', () => this.setDuration(m.duration));
        m.addEventListener('ended', () => {
            this.pause();
            this.seekTo(0);
        });
        this.applyMix();
        this.raf = requestAnimationFrame(this.frame);
    }

    setDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        this.duration = seconds;
        this.seek.max = String(seconds);
        this.seek.disabled = false;
        this.playBtn.disabled = false;
        this.durationEl.textContent = formatClock(seconds);
    }

    createTrack(info, index) {
        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = `/stream/${encodeURIComponent(info.file)}`;

        const track = { ...info, index, audio, muted: false, solo: false, volume: 1, level: 0, peaks: null };

        const row = document.createElement('div');
        row.className = 'track';
        row.style.setProperty('--track-color', info.color);
        row.style.setProperty('--i', String(index));

        const head = document.createElement('div');
        head.className = 'track-head';
        const emoji = document.createElement('span');
        emoji.className = 'track-emoji';
        emoji.textContent = info.emoji;
        const label = document.createElement('span');
        label.className = 'track-label';
        label.textContent = info.label;
        head.append(emoji, label);
        if (index < 9) {
            const key = document.createElement('span');
            key.className = 'track-key';
            key.textContent = String(index + 1);
            key.title = `Tecla ${index + 1}: silenciar · Mayús+${index + 1}: solo`;
            head.append(key);
        }

        const ctrl = document.createElement('div');
        ctrl.className = 'track-ctrl';
        const makeToggle = (cls, text, title, key) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `track-btn ${cls}`;
            btn.textContent = text;
            btn.title = `${title}: ${info.label}`;
            btn.setAttribute('aria-pressed', 'false');
            btn.addEventListener('click', () => this.setFlag(track, key, !track[key]));
            return btn;
        };
        track.muteBtn = makeToggle('mute', 'M', 'Silenciar', 'muted');
        track.soloBtn = makeToggle('solo', 'S', 'Solo', 'solo');
        ctrl.append(track.muteBtn, track.soloBtn);

        const wave = document.createElement('div');
        wave.className = 'track-wave';
        wave.setAttribute('aria-label', `Forma de onda de ${info.label}; clic para saltar`);
        const loading = document.createElement('div');
        loading.className = 'wave-loading';
        track.baseCanvas = document.createElement('canvas');
        track.playedCanvas = document.createElement('canvas');
        track.playedCanvas.className = 'wave-played';
        track.playhead = document.createElement('div');
        track.playhead.className = 'wave-playhead';
        track.hover = document.createElement('div');
        track.hover.className = 'wave-hover';
        wave.append(loading, track.baseCanvas, track.playedCanvas, track.playhead, track.hover);
        this.bindWave(wave);

        const volume = document.createElement('input');
        volume.type = 'range';
        volume.className = 'track-volume';
        volume.min = '0';
        volume.max = '1';
        volume.step = '0.01';
        volume.value = '1';
        volume.setAttribute('aria-label', `Volumen de ${info.label}`);
        setRangeFill(volume);
        volume.addEventListener('input', () => {
            track.volume = Number(volume.value);
            setRangeFill(volume);
            this.applyMix();
        });

        const download = document.createElement('a');
        download.className = 'track-download';
        download.href = info.downloadUrl;
        download.title = `Descargar ${info.label}`;
        download.setAttribute('aria-label', `Descargar ${info.label}`);
        download.innerHTML = DOWNLOAD_ICON;

        row.append(head, ctrl, wave, volume, download);
        this.tracksEl.appendChild(row);
        track.row = row;

        fetch(`/peaks/${encodeURIComponent(info.file)}`)
            .then(r => (r.ok ? r.json() : Promise.reject()))
            .then(data => {
                if (!this.tracks.includes(track)) return;
                track.peaks = data.peaks;
                if (!this.duration) this.setDuration(data.duration);
                loading.remove();
                this.renderWave(track);
            })
            .catch(() => loading.remove());

        return track;
    }

    renderWave(track) {
        if (!track.peaks) return;
        drawWave(track.baseCanvas, track.peaks, `${track.color}55`);
        drawWave(track.playedCanvas, track.peaks, track.color);
    }

    bindWave(wave) {
        const ratioAt = (e) => {
            const rect = wave.getBoundingClientRect();
            return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        };
        let scrubbing = false;
        let lastScrub = 0;
        wave.addEventListener('pointerdown', (e) => {
            if (!this.duration) return;
            scrubbing = true;
            wave.setPointerCapture(e.pointerId);
            this.seekTo(ratioAt(e) * this.duration);
        });
        wave.addEventListener('pointermove', (e) => {
            const ratio = ratioAt(e);
            this.tracks.forEach(t => {
                t.hover.style.left = `${ratio * 100}%`;
                t.hover.dataset.time = formatClock(ratio * this.duration);
            });
            const now = performance.now();
            if (scrubbing && now - lastScrub > 40) {
                lastScrub = now;
                this.seekTo(ratio * this.duration);
            }
        });
        const stop = () => { scrubbing = false; };
        wave.addEventListener('pointerup', stop);
        wave.addEventListener('pointercancel', stop);
    }

    /* ── Audio graph ─────────────────────────────────────── */

    ensureGraph() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        try {
            if (!this.ctx) {
                this.ctx = new AudioCtx();
                this.masterGain = this.ctx.createGain();
                this.analyser = this.ctx.createAnalyser();
                this.analyser.fftSize = 2048;
                this.analyser.smoothingTimeConstant = 0.78;
                this.masterGain.connect(this.analyser);
                this.analyser.connect(this.ctx.destination);
                this.freq = new Uint8Array(this.analyser.frequencyBinCount);
            }
            this.tracks.forEach(t => {
                if (t.source) return;
                t.source = this.ctx.createMediaElementSource(t.audio);
                t.gain = this.ctx.createGain();
                t.analyser = this.ctx.createAnalyser();
                t.analyser.fftSize = 512;
                t.wave = new Float32Array(t.analyser.fftSize);
                t.source.connect(t.gain);
                t.gain.connect(t.analyser);
                t.analyser.connect(this.masterGain);
            });
        } catch {
            // Without Web Audio the mixer still works through element volume
        }
        this.applyMix();
    }

    applyMix() {
        const anySolo = this.tracks.some(t => t.solo);
        this.tracks.forEach(t => {
            const audible = anySolo ? t.solo : !t.muted;
            if (t.gain) {
                t.audio.muted = false;
                t.audio.volume = 1;
                t.gain.gain.setTargetAtTime(audible ? t.volume : 0, this.ctx.currentTime, 0.015);
            } else {
                t.audio.muted = !audible;
                t.audio.volume = t.volume;
            }
            t.row.classList.toggle('silent', !audible);
        });
    }

    setFlag(track, key, value) {
        track[key] = value;
        (key === 'muted' ? track.muteBtn : track.soloBtn).setAttribute('aria-pressed', String(value));
        this.applyMix();
    }

    /* ── Transport ───────────────────────────────────────── */

    toggle() {
        if (!this.masterAudio || this.playBtn.disabled) return;
        if (this.playing) this.pause(); else this.play();
    }

    async play() {
        const m = this.masterAudio;
        if (!m) return;
        this.ensureGraph();
        if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
        const t = m.currentTime;
        this.tracks.forEach(tr => { tr.audio.currentTime = t; });
        try {
            await Promise.all(this.tracks.map(tr => tr.audio.play()));
        } catch {
            this.pause();
            this.root.dispatchEvent(new CustomEvent('mixer-error', { detail: 'No se pudo reproducir el audio' }));
            return;
        }
        this.playBtn.classList.add('playing');
        this.playBtn.setAttribute('aria-label', 'Pausar');
        clearInterval(this.syncTimer);
        // An interval (not rAF) so stems stay aligned even in a background tab
        this.syncTimer = setInterval(() => this.resync(), 250);
    }

    pause() {
        this.tracks.forEach(t => t.audio.pause());
        this.playBtn.classList.remove('playing');
        this.playBtn.setAttribute('aria-label', 'Reproducir');
        clearInterval(this.syncTimer);
        this.syncTimer = null;
    }

    resync() {
        const m = this.masterAudio;
        if (!m || m.paused) return;
        this.tracks.slice(1).forEach(t => {
            if (!t.audio.ended && Math.abs(t.audio.currentTime - m.currentTime) > MAX_DRIFT_SECONDS) {
                t.audio.currentTime = m.currentTime;
            }
        });
    }

    seekTo(seconds) {
        const t = Math.min(Math.max(0, seconds), this.duration || seconds);
        this.tracks.forEach(tr => { tr.audio.currentTime = t; });
        this.renderPosition(t, true);
    }

    seekBy(delta) {
        const m = this.masterAudio;
        if (m) this.seekTo(m.currentTime + delta);
    }

    /** Keyboard shortcuts; returns true when the key was used. */
    handleKey(e) {
        if (!this.tracks.length) return false;
        if (e.code === 'Space') { this.toggle(); return true; }
        if (e.code === 'ArrowLeft') { this.seekBy(-SEEK_STEP_SECONDS); return true; }
        if (e.code === 'ArrowRight') { this.seekBy(SEEK_STEP_SECONDS); return true; }
        const digit = /^Digit([1-9])$/.exec(e.code);
        if (digit) {
            const track = this.tracks[Number(digit[1]) - 1];
            if (!track) return false;
            if (e.shiftKey) this.setFlag(track, 'solo', !track.solo);
            else this.setFlag(track, 'muted', !track.muted);
            return true;
        }
        return false;
    }

    /* ── Rendering loop ──────────────────────────────────── */

    renderPosition(t, force = false) {
        const ratio = this.duration ? Math.min(1, t / this.duration) : 0;
        const pct = ratio * 100;
        this.tracks.forEach(tr => {
            tr.playedCanvas.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
            tr.playhead.style.left = `${pct}%`;
        });
        if (!this.seeking) {
            this.seek.value = String(t);
            setRangeFill(this.seek);
            const second = Math.floor(t);
            if (force || second !== this.lastSecond) {
                this.lastSecond = second;
                this.timeEl.textContent = formatClock(t);
            }
        }
    }

    frame = (now) => {
        const m = this.masterAudio;
        if (!m) return;
        this.renderPosition(m.currentTime);
        const live = this.playing && this.analyser;
        this.updateLevels(live);
        this.drawVisualizer(now, live);
        this.raf = requestAnimationFrame(this.frame);
    };

    updateLevels(live) {
        this.tracks.forEach(t => {
            let level = 0;
            if (live && t.analyser) {
                t.analyser.getFloatTimeDomainData(t.wave);
                let sum = 0;
                for (let i = 0; i < t.wave.length; i++) sum += t.wave[i] * t.wave[i];
                level = Math.min(1, Math.sqrt(sum / t.wave.length) * 4);
            }
            t.level = level > t.level ? level : t.level * 0.86;
            t.row.style.setProperty('--level', t.level.toFixed(3));
        });
    }

    drawVisualizer(now, live) {
        const canvas = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const count = Math.max(24, Math.floor(w / 7));
        if (this.bars.length !== count) {
            this.bars = new Array(count).fill(0);
            this.caps = new Array(count).fill(0);
        }

        let bass = 0;
        if (live) {
            this.analyser.getByteFrequencyData(this.freq);
            const nyquist = this.ctx.sampleRate / 2;
            const binOf = (hz) => Math.min(this.freq.length - 1, Math.round((hz / nyquist) * this.freq.length));
            const lo = Math.log(35);
            const hi = Math.log(16000);
            for (let i = 0; i < count; i++) {
                // Log-spaced bands, like the ear hears them
                const f1 = Math.exp(lo + ((hi - lo) * i) / count);
                const f2 = Math.exp(lo + ((hi - lo) * (i + 1)) / count);
                const b1 = binOf(f1);
                const b2 = Math.max(b1 + 1, binOf(f2));
                let v = 0;
                for (let b = b1; b < b2; b++) v = Math.max(v, this.freq[b]);
                const target = Math.pow(v / 255, 1.4);
                this.bars[i] = target > this.bars[i] ? target : this.bars[i] * 0.88 + target * 0.12;
            }
            for (let b = binOf(40); b <= binOf(150); b++) bass = Math.max(bass, this.freq[b]);
            bass = Math.pow(bass / 255, 2.2);
            const bands = [0.04, 0.12, 0.28, 0.5, 0.75].map(p => this.bars[Math.floor(p * count)] * 1.3);
            setLogoLevels(bands);
        } else {
            // Idle: a slow breathing wave so the panel never looks dead
            const t = now / 1000;
            for (let i = 0; i < count; i++) {
                const target = 0.05 + 0.04 * Math.sin(t * 1.6 + i * 0.22) + 0.03 * Math.sin(t * 0.7 + i * 0.05);
                this.bars[i] = this.bars[i] * 0.9 + target * 0.1;
            }
            setLogoLevels(null);
        }
        setBeat(bass);
        this.playBtn.style.setProperty('--beat', bass.toFixed(3));

        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, '#8b5cf6');
        gradient.addColorStop(0.45, '#3b82f6');
        gradient.addColorStop(0.75, '#ec4899');
        gradient.addColorStop(1, '#f59e0b');

        const slot = w / count;
        const barW = Math.max(2, slot * 0.62);
        const base = h * 0.72;
        const maxH = base - 6;
        for (let i = 0; i < count; i++) {
            const bh = Math.max(2, this.bars[i] * maxH);
            const x = i * slot + (slot - barW) / 2;
            ctx.globalAlpha = 1;
            ctx.fillStyle = gradient;
            ctx.fillRect(x, base - bh, barW, bh);
            // Reflection
            ctx.globalAlpha = 0.18;
            ctx.fillRect(x, base + 2, barW, bh * 0.35);
            // Falling peak caps
            this.caps[i] = Math.max(this.caps[i] - 0.006, this.bars[i]);
            ctx.globalAlpha = live ? 0.9 : 0.25;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x, base - this.caps[i] * maxH - 4, barW, 2);
        }
        ctx.globalAlpha = 1;
    }

    destroy() {
        cancelAnimationFrame(this.raf);
        this.raf = null;
        this.pause();
        this.tracks.forEach(t => {
            try {
                if (t.source) t.source.disconnect();
                if (t.analyser) t.analyser.disconnect();
            } catch { /* already disconnected */ }
            t.audio.removeAttribute('src');
            t.audio.load();
        });
        this.tracks = [];
        this.tracksEl.replaceChildren();
        this.duration = 0;
        this.lastSecond = -1;
        this.seek.value = '0';
        this.seek.max = '0';
        setRangeFill(this.seek);
        this.seek.disabled = true;
        this.playBtn.disabled = true;
        this.timeEl.textContent = '0:00';
        this.durationEl.textContent = '0:00';
        setBeat(0);
        setLogoLevels(null);
    }
}
