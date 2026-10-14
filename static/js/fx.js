/* Visual effects shared by the page: cursor spotlight, button ripples,
   confetti, number tweens and the beat that drives the background. */

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Cards light up their border where the cursor is. */
export function setupSpotlight(selector) {
    document.querySelectorAll(selector).forEach(card => {
        card.addEventListener('pointermove', (e) => {
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
            card.style.setProperty('--my', `${e.clientY - rect.top}px`);
        });
    });
}

/** Material-style ripple on every .btn press. */
export function setupRipples() {
    document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.btn');
        if (!btn || btn.disabled || reducedMotion.matches) return;
        const rect = btn.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2.2;
        const ripple = document.createElement('span');
        ripple.className = 'ripple';
        ripple.style.width = ripple.style.height = `${size}px`;
        ripple.style.left = `${e.clientX - rect.left}px`;
        ripple.style.top = `${e.clientY - rect.top}px`;
        btn.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove());
    });
}

const tweens = new WeakMap();

/** Animate the integer shown in `el` towards `to`. */
export function tweenNumber(el, to, suffix = '%', duration = 700) {
    const from = Number.parseFloat(el.textContent) || 0;
    cancelAnimationFrame(tweens.get(el));
    if (reducedMotion.matches || from === to) {
        el.textContent = `${Math.round(to)}${suffix}`;
        return;
    }
    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = `${Math.round(from + (to - from) * eased)}${suffix}`;
        if (t < 1) tweens.set(el, requestAnimationFrame(step));
    };
    tweens.set(el, requestAnimationFrame(step));
}

const root = document.documentElement;
let beat = 0;

/** 0–1 bass energy; the aurora and the play button breathe with it. */
export function setBeat(value) {
    // Fast attack, slow release so it pulses instead of flickering
    beat = value > beat ? value : beat * 0.9 + value * 0.1;
    root.style.setProperty('--beat', beat.toFixed(3));
}

const logo = document.querySelector('.logo-icon');
const logoBars = logo ? [...logo.querySelectorAll('.logo-bar')] : [];

/** Drive the header logo from the spectrum (null = back to idle animation). */
export function setLogoLevels(levels) {
    if (!logo) return;
    if (!levels) {
        logo.classList.remove('live');
        logo.style.setProperty('--level', '0');
        return;
    }
    logo.classList.add('live');
    logoBars.forEach((bar, i) => {
        bar.style.setProperty('--h', Math.max(0.18, Math.min(1, levels[i] ?? 0)).toFixed(3));
    });
    const avg = levels.reduce((a, b) => a + b, 0) / (levels.length || 1);
    logo.style.setProperty('--level', avg.toFixed(3));
}

/* ── Confetti ─────────────────────────────────────────────── */
const CONFETTI_COLORS = ['#8b5cf6', '#3b82f6', '#ec4899', '#22d3ee', '#4ade80', '#fb923c', '#fde68a'];
const NOTES = ['♪', '♫', '♬'];

export function confetti(originEl) {
    if (reducedMotion.matches) return;
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);

    const rect = originEl ? originEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    const ox = rect.left + rect.width / 2;
    const oy = rect.top + rect.height / 3;

    const parts = Array.from({ length: 160 }, (_, i) => {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
        const speed = 7 + Math.random() * 11;
        return {
            x: ox, y: oy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.35,
            size: 6 + Math.random() * 7,
            color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            note: i % 7 === 0 ? NOTES[i % NOTES.length] : null,
            wobble: Math.random() * 10,
        };
    });

    const start = performance.now();
    const DURATION = 2600;
    const frame = (now) => {
        const elapsed = now - start;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        const fade = Math.max(0, 1 - Math.max(0, elapsed - DURATION * 0.6) / (DURATION * 0.4));
        for (const p of parts) {
            p.vx *= 0.985;
            p.vy = p.vy * 0.985 + 0.32;
            p.x += p.vx + Math.sin((elapsed / 200) + p.wobble) * 0.6;
            p.y += p.vy;
            p.rot += p.vr;
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            if (p.note) {
                ctx.font = `${p.size * 2.2}px sans-serif`;
                ctx.fillText(p.note, 0, 0);
            } else {
                ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            }
            ctx.restore();
        }
        if (elapsed < DURATION) {
            requestAnimationFrame(frame);
        } else {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    };
    requestAnimationFrame(frame);
}

/** Run a DOM change as a View Transition when the browser supports it. */
export function morph(update) {
    if (document.startViewTransition && !reducedMotion.matches) {
        document.startViewTransition(update);
    } else {
        update();
    }
}
