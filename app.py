"""
Music Tool — Flask Backend
Provides audio track separation (vocals / instrumental) and song identification.
"""

import os
import re
import sys
import uuid
import shutil
import asyncio
import signal
import subprocess
import threading
import webbrowser
import mimetypes
from pathlib import Path

from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    send_from_directory,
    Response,
)
from flask_cors import CORS

# ---------------------------------------------------------------------------
# FFmpeg — dynamic PATH detection & configuration
# ---------------------------------------------------------------------------
if not shutil.which("ffmpeg"):
    custom_ffmpeg = os.environ.get("FFMPEG_PATH")
    if custom_ffmpeg and os.path.isdir(custom_ffmpeg):
        os.environ["PATH"] = custom_ffmpeg + ";" + os.environ.get("PATH", "")
    else:
        win_winget_dir = (
            r"C:\Users\Propietario\AppData\Local\Microsoft\WinGet\Packages"
            r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
            r"\ffmpeg-8.1.2-full_build\bin"
        )
        if os.path.isdir(win_winget_dir):
            os.environ["PATH"] = win_winget_dir + ";" + os.environ.get("PATH", "")

# ---------------------------------------------------------------------------
# App configuration
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "output"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB
CORS(app)

# In‑memory task store  {task_id: {status, progress, files, error}}
tasks: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _allowed_file(filename: str) -> bool:
    """Return True for common audio / video extensions."""
    ext = Path(filename).suffix.lower()
    return ext in {
        ".mp3", ".wav", ".flac", ".ogg", ".aac", ".m4a", ".wma", ".opus",
        ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".ts",
    }


def _secure_filename(filename: str) -> str:
    """Minimal sanitisation — keep the original name but strip path components
    and dodgy characters."""
    name = Path(filename).name  # strip directory parts
    name = re.sub(r'[^a-zA-Z0-9.-]', "_", name)
    return name or "unnamed"


def _parse_separator_output(line: str, task_id: str):
    """Try to extract progress or output‑file paths from a single stdout/err
    line produced by audio‑separator."""
    # Progress lines typically look like:  "  5%|▌          | …"
    m = re.search(r"(\d+)%\|", line)
    if m:
        tasks[task_id]["progress"] = int(m.group(1))
        return

    # Output file lines:  "Vocals saved to: <path>"  /  "Instrumental saved to: <path>"
    low = line.lower()
    if "saved" in low or "written" in low or "output" in low:
        # Try to grab anything that looks like a filepath after a colon
        parts = line.split(":", 1)
        if len(parts) == 2:
            candidate = parts[1].strip().strip('"').strip("'")
            if os.path.isfile(candidate):
                base = os.path.basename(candidate).lower()
                if "vocal" in base:
                    tasks[task_id]["files"]["vocals"] = candidate
                elif "instrument" in base or "accomp" in base or "no_vocal" in base:
                    tasks[task_id]["files"]["instrumental"] = candidate


def _run_separation(filepath: str, task_id: str):
    """Run audio-separator in a subprocess and update `tasks` dict."""
    try:
        tasks[task_id] = {
            "status": "processing",
            "progress": 0,
            "files": {"instrumental": "", "vocals": ""},
            "error": "",
        }

        output_dir = str(OUTPUT_DIR)
        cmd = [
            "audio-separator",
            filepath,
            "--output_dir", output_dir,
        ]

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )

        full_output = []
        for line in proc.stdout:  # type: ignore[union-attr]
            full_output.append(line)
            if len(full_output) > 20:
                full_output.pop(0)
            _parse_separator_output(line, task_id)

        proc.wait()

        if proc.returncode != 0:
            tasks[task_id]["status"] = "error"
            tasks[task_id]["error"] = "".join(full_output)
            return

        # If parsing didn't catch filenames, scan output dir for new files
        if not tasks[task_id]["files"]["vocals"] and not tasks[task_id]["files"]["instrumental"]:
            stem = Path(filepath).stem
            for f in OUTPUT_DIR.iterdir():
                if not f.is_file():
                    continue
                fname_low = f.name.lower()
                if stem.lower() not in fname_low:
                    continue
                if "vocal" in fname_low and "no_vocal" not in fname_low and "instru" not in fname_low:
                    tasks[task_id]["files"]["vocals"] = str(f)
                elif "instru" in fname_low or "no_vocal" in fname_low or "accomp" in fname_low:
                    tasks[task_id]["files"]["instrumental"] = str(f)

        tasks[task_id]["status"] = "complete"
        tasks[task_id]["progress"] = 100

    except Exception as exc:
        tasks[task_id]["status"] = "error"
        tasks[task_id]["error"] = str(exc)


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
# Routes — pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes — upload
# ---------------------------------------------------------------------------

@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file part in request"}), 400

    file = request.files["file"]
    if file.filename == "" or file.filename is None:
        return jsonify({"error": "No file selected"}), 400

    if not _allowed_file(file.filename):
        return jsonify({"error": "File type not allowed"}), 400

    safe_name = _secure_filename(file.filename)
    # Avoid collisions by prefixing a short uuid
    unique_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
    dest = UPLOAD_DIR / unique_name
    file.save(str(dest))

    return jsonify({"filename": unique_name, "filepath": str(dest)})


# ---------------------------------------------------------------------------
# Routes — separation
# ---------------------------------------------------------------------------

@app.route("/separate", methods=["POST"])
def separate():
    data = request.get_json(silent=True)
    if not data or "filepath" not in data:
        return jsonify({"error": "Missing 'filepath' in request body"}), 400

    filepath = data["filepath"]
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found on server"}), 404

    task_id = uuid.uuid4().hex
    thread = threading.Thread(target=_run_separation, args=(filepath, task_id), daemon=True)
    thread.start()

    return jsonify({"task_id": task_id, "status": "processing"})


@app.route("/status/<task_id>", methods=["GET"])
def task_status(task_id: str):
    task = tasks.get(task_id)
    if task is None:
        return jsonify({"error": "Unknown task ID"}), 404

    resp: dict = {
        "status": task["status"],
        "progress": task["progress"],
    }

    if task["status"] == "complete":
        # Return basenames so the client can use /download/ or /stream/
        resp["files"] = {
            "instrumental": os.path.basename(task["files"]["instrumental"]) if task["files"]["instrumental"] else "",
            "vocals": os.path.basename(task["files"]["vocals"]) if task["files"]["vocals"] else "",
        }
    elif task["status"] == "error":
        resp["error"] = task["error"]

    return jsonify(resp)


# ---------------------------------------------------------------------------
# Routes — identify (JSON path)
# ---------------------------------------------------------------------------

@app.route("/identify", methods=["POST"])
def identify():
    data = request.get_json(silent=True)
    if not data or "filepath" not in data:
        return jsonify({"error": "Missing 'filepath' in request body"}), 400

    filepath = data["filepath"]
    if not os.path.isfile(filepath):
        # Also try resolving a bare filename against the output directory
        candidate = OUTPUT_DIR / Path(filepath).name
        if candidate.is_file():
            filepath = str(candidate)
        else:
            return jsonify({"error": "File not found on server"}), 404

    return _do_identify(filepath)


# ---------------------------------------------------------------------------
# Routes — identify (direct file upload)
# ---------------------------------------------------------------------------

@app.route("/identify-file", methods=["POST"])
def identify_file():
    if "file" not in request.files:
        return jsonify({"error": "No file part in request"}), 400

    file = request.files["file"]
    if file.filename == "" or file.filename is None:
        return jsonify({"error": "No file selected"}), 400

    safe_name = _secure_filename(file.filename)
    unique_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
    dest = UPLOAD_DIR / unique_name
    file.save(str(dest))

    return _do_identify(str(dest))


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
            return jsonify({"error": "Could not identify the song"}), 404

        # Extract cover image from the coverart list if available
        cover_url = ""
        images = track.get("images", {})
        if isinstance(images, dict):
            cover_url = images.get("coverarthq", images.get("coverart", ""))

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
                    "Unknown",
                )
            ),
            "cover_url": cover_url,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ---------------------------------------------------------------------------
# Routes — file serving
# ---------------------------------------------------------------------------

@app.route("/download/<filename>")
def download(filename: str):
    safe = _secure_filename(filename)
    fpath = OUTPUT_DIR / safe
    if not fpath.is_file():
        return jsonify({"error": "File not found"}), 404
    return send_from_directory(str(OUTPUT_DIR), safe, as_attachment=True)


@app.route("/stream/<filename>")
def stream(filename: str):
    """Serve audio with Range‑request support so browsers can seek."""
    safe = _secure_filename(filename)
    fpath = OUTPUT_DIR / safe
    if not fpath.is_file():
        return jsonify({"error": "File not found"}), 404

    mime = mimetypes.guess_type(str(fpath))[0] or "application/octet-stream"
    size = fpath.stat().st_size

    range_header = request.headers.get("Range")
    if range_header:
        # Parse "bytes=START-END"
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            length = end - start + 1

            def _generate():
                with open(fpath, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(8192, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            resp = Response(
                _generate(),
                status=206,
                mimetype=mime,
                direct_passthrough=True,
            )
            resp.headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            resp.headers["Accept-Ranges"] = "bytes"
            resp.headers["Content-Length"] = str(length)
            return resp

    # Full file
    def _generate_full():
        with open(fpath, "rb") as f:
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                yield chunk

    resp = Response(_generate_full(), mimetype=mime, direct_passthrough=True)
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Length"] = str(size)
    return resp


# ---------------------------------------------------------------------------
# Routes — cleanup
# ---------------------------------------------------------------------------

@app.route("/cleanup", methods=["POST"])
def cleanup():
    errors = []
    for folder in (UPLOAD_DIR, OUTPUT_DIR):
        for item in folder.iterdir():
            try:
                if item.is_file():
                    item.unlink()
                elif item.is_dir():
                    shutil.rmtree(item)
            except Exception as exc:
                errors.append(f"{item.name}: {exc}")

    if errors:
        return jsonify({"status": "partial", "errors": errors}), 207

    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _open_browser():
    """Open the browser after a short delay so the server is ready."""
    import time
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == "__main__":
    threading.Thread(target=_open_browser, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
