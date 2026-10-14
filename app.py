"""
Music Tool — Flask Backend
Provides audio track separation (vocals / instrumental) and song identification.
"""

import os
import re
import sys
import glob
import json
import time
import codecs
import uuid
import shutil
import asyncio
import subprocess
import threading
import unicodedata
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    send_from_directory,
)

# ---------------------------------------------------------------------------
# FFmpeg — dynamic PATH detection & configuration
# ---------------------------------------------------------------------------

def _find_ffmpeg_dir() -> str | None:
    """Look for an FFmpeg bin folder outside PATH (FFMPEG_PATH or WinGet)."""
    custom = os.environ.get("FFMPEG_PATH")
    if custom and os.path.isdir(custom):
        return custom
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        # WinGet installs FFmpeg under a versioned folder, so don't pin the version
        pattern = os.path.join(
            local_appdata, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin"
        )
        for candidate in sorted(glob.glob(pattern), reverse=True):
            if os.path.isfile(os.path.join(candidate, "ffmpeg.exe")):
                return candidate
    return None


if not shutil.which("ffmpeg"):
    ffmpeg_dir = _find_ffmpeg_dir()
    if ffmpeg_dir:
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None

# ---------------------------------------------------------------------------
# App configuration
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "output"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_MB = 500
# Uploads and results older than this are purged automatically
FILE_MAX_AGE_HOURS = 24

ALLOWED_EXTENSIONS = {
    ".mp3", ".wav", ".flac", ".ogg", ".aac", ".m4a", ".wma", ".opus",
    ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".ts",
}

STEMS = ("vocals", "instrumental")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# In‑memory task store  {task_id: {status, progress, files, error, ...}}
tasks: dict[str, dict] = {}
# Separation models use a lot of RAM/VRAM: run one at a time, queue the rest
separation_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _allowed_file(filename: str) -> bool:
    """Return True for common audio / video extensions."""
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def _secure_filename(filename: str) -> str:
    """Keep the original name but strip path components, accents and dodgy
    characters, so the result is plain ASCII."""
    name = Path(filename).name  # strip directory parts
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-zA-Z0-9.-]", "_", name)
    name = re.sub(r"_+", "_", name).strip("._")
    return name or "unnamed"


def _resolve_in(folder: Path, name: str) -> Path | None:
    """Return the file `name` inside `folder`, or None. Only the base name is
    used, so the client can never reach files outside the folder."""
    if not name:
        return None
    candidate = folder / Path(name).name
    return candidate if candidate.is_file() else None


def _error(message: str, code: int):
    return jsonify({"error": message}), code


def _purge_old_files():
    """Delete uploads/results older than FILE_MAX_AGE_HOURS."""
    limit = time.time() - FILE_MAX_AGE_HOURS * 3600
    busy = {
        Path(t["source"]).name
        for t in tasks.values()
        if t["status"] in ("queued", "processing")
    }
    for folder in (UPLOAD_DIR, OUTPUT_DIR):
        for item in folder.iterdir():
            try:
                if item.is_file() and item.name not in busy and item.stat().st_mtime < limit:
                    item.unlink()
            except OSError:
                pass


def _output_path(task_id: str, stem: str) -> Path:
    return OUTPUT_DIR / f"{task_id}_{stem}.flac"


def _meta_path(task_id: str) -> Path:
    return OUTPUT_DIR / f"{task_id}.json"


def _task_from_disk(task_id: str) -> dict | None:
    """Rebuild a finished task from its files (e.g. after a server restart)."""
    files = {s: str(_output_path(task_id, s)) for s in STEMS if _output_path(task_id, s).is_file()}
    if not files:
        return None
    meta = {}
    try:
        meta = json.loads(_meta_path(task_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return {
        "status": "complete",
        "progress": 100,
        "files": {s: files.get(s, "") for s in STEMS},
        "error": "",
        "source": meta.get("source", ""),
        "original_name": meta.get("original_name", ""),
    }


_PROGRESS_RE = re.compile(r"(\d+)%\|")
# Remaining time inside a tqdm bar: "[01:10<02:20," or "[1:01:10<1:02:20,"
_ETA_RE = re.compile(r"<(?:(\d+):)?(\d+):(\d+)")
_ERROR_LINE_RE =re.compile(r"(error|exception|not found|no such|failed)", re.I)


# audio-separator log prefix: "2026-01-01 10:00:00.000 - ERROR - separator - "
_LOG_PREFIX_RE = re.compile(r"^\S+ \S+ - (\w+) - \w+ - ")


def _summarize_error(lines: list[str]) -> str:
    """Pick the most useful line from the separator output for the UI."""
    meaningful = [l.strip() for l in lines if l.strip() and not _PROGRESS_RE.search(l)]
    if not meaningful:
        return "El separador terminó con un error desconocido"
    logged_errors = [l for l in meaningful if (m := _LOG_PREFIX_RE.match(l)) and m.group(1) == "ERROR"]
    candidates = logged_errors or [l for l in meaningful if _ERROR_LINE_RE.search(l)] or meaningful
    line = _LOG_PREFIX_RE.sub("", candidates[-1])
    # Full upload paths are noise for the user
    line = line.replace(str(UPLOAD_DIR) + os.sep, "")
    return line[-300:]


def _handle_separator_line(line: str, task: dict, tail: list[str]):
    """Update progress / ETA from one line of audio-separator output."""
    m = _PROGRESS_RE.search(line)
    if m:
        task["progress"] = min(int(m.group(1)), 99)
        eta = _ETA_RE.search(line)
        if eta:
            h, mnt, s = eta.group(1), eta.group(2), eta.group(3)
            task["eta_seconds"] = int(h or 0) * 3600 + int(mnt) * 60 + int(s)
        return
    tail.append(line + "\n")
    if len(tail) > 40:
        tail.pop(0)


def _find_fallback_output(stem_name: str, upload_stem: str) -> Path | None:
    """Older audio-separator versions ignore custom names and write
    '<input>_(Vocals)_<model>.flac' instead."""
    marker = "(Vocals)" if stem_name == "vocals" else "(Instrumental)"
    for f in OUTPUT_DIR.iterdir():
        if f.is_file() and f.name.startswith(upload_stem) and marker in f.name:
            return f
    return None


def _run_separation(filepath: str, task_id: str):
    """Run audio-separator in a subprocess and update `tasks` dict."""
    task = tasks[task_id]
    tail: list[str] = []
    try:
        with separation_lock:
            task["status"] = "processing"

            custom_names = {"Vocals": f"{task_id}_vocals", "Instrumental": f"{task_id}_instrumental"}
            # Run the CLI with this same interpreter so it works even when the
            # Scripts folder is not in PATH
            cmd = [
                sys.executable, "-c",
                "from audio_separator.utils.cli import main; main()",
                filepath,
                "--output_dir", str(OUTPUT_DIR),
                "--output_format", "FLAC",
                "--custom_output_names", json.dumps(custom_names),
            ]
            env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )

            # tqdm writes "\r 50%|###  | 1/2 [00:35<00:35, ...]" with the \r
            # *before* each update, so a line-based reader would only see each
            # update when the next one arrives. Read raw chunks and split on
            # \r and \n ourselves to get progress in real time.
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            pending = ""
            while True:
                chunk = proc.stdout.read1(4096)  # type: ignore[union-attr]
                if not chunk:
                    break
                pending += decoder.decode(chunk)
                *lines, pending = re.split(r"[\r\n]", pending)
                for line in lines:
                    if line.strip():
                        _handle_separator_line(line, task, tail)
            if pending.strip():
                _handle_separator_line(pending, task, tail)

            proc.wait()

        if proc.returncode != 0:
            print(f"[separate {task_id}] audio-separator failed:\n{''.join(tail)}", file=sys.stderr)
            task["status"] = "error"
            task["error"] = _summarize_error(tail)
            return

        upload_stem = Path(filepath).stem
        for stem in STEMS:
            out = _output_path(task_id, stem)
            if not out.is_file():
                fallback = _find_fallback_output(stem, upload_stem)
                if fallback:
                    fallback.replace(out)
            task["files"][stem] = str(out) if out.is_file() else ""

        if not any(task["files"].values()):
            print(f"[separate {task_id}] no output files:\n{''.join(tail)}", file=sys.stderr)
            task["status"] = "error"
            task["error"] = (
                "No se generaron pistas. ¿El archivo está dañado o no contiene audio? "
                f"Detalle: {_summarize_error(tail)}"
            )
            return

        task["status"] = "complete"
        task["progress"] = 100

    except FileNotFoundError as exc:
        task["status"] = "error"
        task["error"] = f"No se pudo ejecutar el separador: {exc}"
    except Exception as exc:
        task["status"] = "error"
        task["error"] = str(exc)


def _run_async(coro):
    """Run an async coroutine from sync Flask context."""
    try:
        return asyncio.run(coro)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


# ---------------------------------------------------------------------------
# Request guards & error handlers
# ---------------------------------------------------------------------------

@app.before_request
def _reject_foreign_origins():
    """Only this app's own page may call the API. Without this, any website
    open in the browser could upload files or start jobs on localhost."""
    if request.method == "GET":
        return None
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc != request.host:
        return _error("Origen no permitido", 403)
    return None


@app.errorhandler(413)
def _too_large(_exc):
    return _error(f"El archivo supera el límite de {MAX_UPLOAD_MB} MB", 413)


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html", ffmpeg_available=FFMPEG_AVAILABLE)


# ---------------------------------------------------------------------------
# Routes — upload
# ---------------------------------------------------------------------------

@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return _error("No se recibió ningún archivo", 400)

    file = request.files["file"]
    if not file.filename:
        return _error("No se seleccionó ningún archivo", 400)

    if not _allowed_file(file.filename):
        return _error("Formato de archivo no soportado", 400)

    _purge_old_files()

    safe_name = _secure_filename(file.filename)
    # Avoid collisions by prefixing a short uuid
    unique_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
    dest = UPLOAD_DIR / unique_name
    file.save(str(dest))

    return jsonify({"filename": unique_name})


# ---------------------------------------------------------------------------
# Routes — separation
# ---------------------------------------------------------------------------

@app.route("/separate", methods=["POST"])
def separate():
    data = request.get_json(silent=True) or {}
    # "filepath" kept for compatibility with older clients
    source = _resolve_in(UPLOAD_DIR, data.get("filename") or data.get("filepath", ""))
    if source is None:
        return _error("Archivo no encontrado en el servidor", 404)

    task_id = uuid.uuid4().hex
    original_name = str(data.get("original_name") or source.name)
    # Register the task before the thread starts so /status never sees an unknown id
    tasks[task_id] = {
        "status": "queued",
        "progress": 0,
        "eta_seconds": None,
        "files": {s: "" for s in STEMS},
        "error": "",
        "source": str(source),
        "original_name": original_name,
    }
    try:
        _meta_path(task_id).write_text(
            json.dumps({"source": source.name, "original_name": original_name}),
            encoding="utf-8",
        )
    except OSError:
        pass

    thread = threading.Thread(target=_run_separation, args=(str(source), task_id), daemon=True)
    thread.start()

    return jsonify({"task_id": task_id, "status": "queued"})


@app.route("/status/<task_id>", methods=["GET"])
def task_status(task_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", task_id):
        return _error("ID de tarea no válido", 400)

    task = tasks.get(task_id) or _task_from_disk(task_id)
    if task is None:
        return _error("Tarea desconocida (puede que el servidor se haya reiniciado)", 404)

    resp: dict = {
        "status": task["status"],
        "progress": task["progress"],
    }

    if task["status"] == "processing" and task.get("eta_seconds") is not None:
        resp["eta_seconds"] = task["eta_seconds"]
    elif task["status"] == "complete":
        # Return basenames so the client can use /download/ or /stream/
        resp["files"] = {s: os.path.basename(p) if p else "" for s, p in task["files"].items()}
        resp["source"] = os.path.basename(task["source"])
        resp["original_name"] = task["original_name"]
    elif task["status"] == "error":
        resp["error"] = task["error"]

    return jsonify(resp)


# ---------------------------------------------------------------------------
# Routes — identify
# ---------------------------------------------------------------------------

@app.route("/identify", methods=["POST"])
def identify():
    data = request.get_json(silent=True) or {}
    name = data.get("filename") or data.get("filepath", "")
    filepath = _resolve_in(UPLOAD_DIR, name) or _resolve_in(OUTPUT_DIR, name)
    if filepath is None:
        return _error("Archivo no encontrado en el servidor", 404)

    return _do_identify(str(filepath))


@app.route("/identify-file", methods=["POST"])
def identify_file():
    """Identify a directly uploaded file without keeping it."""
    if "file" not in request.files:
        return _error("No se recibió ningún archivo", 400)

    file = request.files["file"]
    if not file.filename:
        return _error("No se seleccionó ningún archivo", 400)

    if not _allowed_file(file.filename):
        return _error("Formato de archivo no soportado", 400)

    unique_name = f"{uuid.uuid4().hex[:8]}_{_secure_filename(file.filename)}"
    dest = UPLOAD_DIR / unique_name
    file.save(str(dest))
    try:
        return _do_identify(str(dest))
    finally:
        dest.unlink(missing_ok=True)


def _do_identify(filepath: str):
    """Shared identification logic."""
    try:
        from shazamio import Shazam  # lazy import

        async def _recognize():
            shazam = Shazam()
            return await shazam.recognize(filepath)

        result = _run_async(_recognize())

        track = result.get("track")
        if not track:
            return _error("No se pudo identificar la canción", 404)

        # Extract cover image from the coverart list if available
        cover_url = ""
        images = track.get("images", {})
        if isinstance(images, dict):
            cover_url = images.get("coverarthq") or images.get("coverart", "")

        return jsonify({
            "title": track.get("title", "Unknown"),
            "artist": track.get("subtitle", "Unknown"),
            "album": (
                next(
                    (
                        item.get("text", "")
                        for section in track.get("sections", [])
                        for item in section.get("metadata", [])
                        if item.get("title", "").lower() == "album"
                    ),
                    "",
                )
            ),
            "cover_url": cover_url,
        })
    except Exception as exc:
        return _error(f"Error al identificar: {exc}", 500)


# ---------------------------------------------------------------------------
# Routes — file serving
# ---------------------------------------------------------------------------

def _download_name(requested: str | None, fallback: str) -> str:
    """Friendly name for the downloaded file, e.g. 'My song (Voz).flac'."""
    if not requested:
        return fallback
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", Path(requested).name).strip(" .")
    return name or fallback


@app.route("/download/<path:filename>")
def download(filename: str):
    fpath = _resolve_in(OUTPUT_DIR, filename)
    if fpath is None:
        return _error("Archivo no encontrado", 404)
    return send_from_directory(
        OUTPUT_DIR,
        fpath.name,
        as_attachment=True,
        download_name=_download_name(request.args.get("name"), fpath.name),
    )


@app.route("/stream/<path:filename>")
def stream(filename: str):
    """Serve audio; Flask handles Range requests so browsers can seek."""
    fpath = _resolve_in(OUTPUT_DIR, filename)
    if fpath is None:
        return _error("Archivo no encontrado", 404)
    return send_from_directory(OUTPUT_DIR, fpath.name, conditional=True)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _open_browser():
    """Open the browser after a short delay so the server is ready."""
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == "__main__":
    if not FFMPEG_AVAILABLE:
        print(
            "[AVISO] No se encontró FFmpeg. La separación y la identificación fallarán.\n"
            "        Instálalo (winget install Gyan.FFmpeg) o define FFMPEG_PATH.",
            file=sys.stderr,
        )
    _purge_old_files()
    threading.Thread(target=_open_browser, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
