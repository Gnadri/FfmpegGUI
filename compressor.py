import os
import shutil
import subprocess
import webbrowser
import uuid
import threading
import time
from flask import Flask, request, render_template_string, jsonify
from threading import Timer
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.secret_key = "your_secret_key_here"

# We'll store uploaded files in this "temp" folder for each job
# and then delete it after each job finishes.
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "temp")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Keep track of ffmpeg jobs by job_id
jobs = {}

# Make the names consistent with the code below
TEMP_FOLDER = UPLOAD_FOLDER

def cleanup_temp_folder():
    """Remove the entire temp folder after each job, then recreate."""
    if os.path.exists(TEMP_FOLDER):
        shutil.rmtree(TEMP_FOLDER, ignore_errors=True)
    os.makedirs(TEMP_FOLDER, exist_ok=True)

# Default output filename if user leaves it blank
DEFAULT_OUTPUT_FILENAME = "output.mp4"

HTML_TEMPLATE = r"""
<!DOCTYPE html>
<html>
<head>
    <title>FFmpeg Video Compressor</title>
    <style>
        body {
            font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
            margin: 0; 
            padding: 0;
            background: linear-gradient(to bottom right, #111, #333);
            color: #eee;
        }
        .header {
            background: rgba(255,255,255,0.05);
            padding: 1em;
            text-align: center;
            border-bottom: 1px solid #444;
        }
        .tabs {
            display: flex;
            justify-content: center;
            background: #222;
            margin-bottom: 1em;
        }
        .tabs button {
            background: none;
            border: none;
            padding: 1em;
            color: #aaa;
            cursor: pointer;
            font-size: 1em;
            transition: color 0.3s;
        }
        .tabs button:hover {
            color: #fff;
        }
        .tabs button.active {
            color: #fff;
            border-bottom: 2px solid #fff;
        }
        .tabcontent {
            display: none;
            max-width: 700px;
            background: #1f1f1f;
            padding: 2em;
            border-radius: 10px;
            margin: auto;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            margin-bottom: 3em;
        }
        h1 {
            margin: 0;
        }
        .section {
            background: #2a2a2a;
            padding: 1em;
            border-radius: 5px;
            margin-bottom: 1.5em;
        }
        .section h3 {
            margin-top: 0;
            margin-bottom: 0.8em;
            color: #fff;
            font-size: 1.2em;
            text-align: center;
        }
        label {
            display: block;
            margin: 1em 0 0.5em;
            font-weight: bold;
            font-size: 1.05em;
            color: #ccc;
        }
        input[type=text],
        input[type=file],
        select {
            width: 100%;
            padding: 0.7em;
            box-sizing: border-box;
            border: 1px solid #444;
            border-radius: 4px;
            background: #2e2e2e;
            color: #eee;
            font-size: 1em;
        }
        button.submit-btn,
        button#estimateBtn {
            margin-top: 1.5em;
            padding: 0.7em 1.5em;
            background: #444;
            color: #eee;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1em;
            transition: background 0.3s;
            display: inline-block;
            margin-right: 1em;
        }
        button.submit-btn:hover,
        button#estimateBtn:hover {
            background: #555;
        }
        .progress-container {
            width: 100%;
            background: #444;
            border-radius: 25px;
            overflow: hidden;
            margin-top: 1em;
        }
        .progress-bar {
            height: 20px;
            width: 0%;
            background-color: #eee;
            transition: width 0.3s ease;
        }
        .loading-text {
            font-size: 1.1em;
            color: #ccc;
            margin-top: 0.5em;
            text-align: center;
        }
        #progressSection {
            display: none;
            margin-top: 2em;
        }
        .message {
            margin-top: 2em;
            background: #2a2a2a;
            padding: 1em;
            border-radius: 4px;
            font-size: 1.05em;
            text-align: center;
            color: #ddd;
            display: none;
        }
        .note {
            font-size: 0.9em;
            color: #aaa;
            margin-top: 0.5em;
        }
        #estimatedSize {
            margin-top: 1em;
            text-align: center;
            font-size: 1em;
            color: #ccc;
            display: none;
        }
    </style>
</head>
<body>

<div class="header">
    <h1>FFmpeg Video Compression</h1>
</div>

<div class="tabs">
    <button class="tablinks active" onclick="openTab(event, 'compressionTab')">Compression</button>
    <button class="tablinks" onclick="openTab(event, 'convertTab')">Convert Format</button>
</div>

<!-- COMPRESSION TAB -->
<div id="compressionTab" class="tabcontent" style="display:block;">
    <form id="compressForm">
        <div class="section">
            <label for="input_file_compress">Select Input File:</label>
            <input type="file" id="input_file_compress" required>
            <div class="note">Choose a video file from your computer.</div>
        </div>

        <div class="section">
            <label for="bitrate">Bitrate (e.g. 1000k):</label>
            <input type="text" id="bitrate" placeholder="e.g. 1000k" required>
            <div class="note">Specify the video bitrate to compress to.</div>
        </div>

        <div class="section">
            <h3>Output Settings</h3>
            <label for="output_dir_compress">Output Directory:</label>
            <input type="text" id="output_dir_compress" placeholder="e.g. C:\\Users\\Me\\Videos" required>
            <div class="note">By default, files go to the above folder.</div>

            <label for="output_filename">Output Filename:</label>
            <input type="text" id="output_filename" placeholder="If blank or no extension, will use .mp4">
            <div class="note">If blank or no extension, we'll default to .mp4</div>
        </div>

        <div class="section" style="background: none; box-shadow: none; margin-bottom: 0;">
            <button type="button" id="estimateBtn">Estimate Size</button>
            <button type="submit" class="submit-btn">Compress</button>
        </div>
    </form>

    <div id="estimatedSize"></div>
</div>

<!-- CONVERT FORMAT TAB -->
<div id="convertTab" class="tabcontent">
    <form id="convertForm">
        <div class="section">
            <label for="input_file_convert">Select Input File:</label>
            <input type="file" id="input_file_convert" required>
            <div class="note">Choose a video file from your computer.</div>
        </div>

        <div class="section">
            <h3>Convert to Format</h3>
            <label for="convert_format">Output Format:</label>
            <select id="convert_format">
                <option value="mp4">MP4</option>
                <option value="webm">WEBM</option>
                <option value="avi">AVI</option>
                <option value="mov">MOV</option>
                <option value="gif">GIF</option>
            </select>
            <div class="note">Choose a target video format. Basic ffmpeg conversion will be used.</div>
        </div>

        <div class="section">
            <h3>Output Settings</h3>
            <label for="output_dir_convert">Output Directory:</label>
            <input type="text" id="output_dir_convert" placeholder="e.g. C:\\Users\\Me\\Videos" required>
            <div class="note">By default, files go to the above folder.</div>

            <label for="convert_outfilename">Output Filename :</label>
            <input type="text" id="convert_outfilename" placeholder="If blank, we'll derive it from the original file + chosen format">
            <div class="note">If blank or no extension, we'll guess from the input file & format.</div>
        </div>

        <div class="section" style="background: none; box-shadow: none; margin-bottom: 0;">
            <button type="submit" class="submit-btn">Convert</button>
        </div>
    </form>
</div>

<div id="progressSection">
    <div class="loading-text">Processing, please wait...</div>
    <div class="progress-container">
        <div class="progress-bar" id="progressBar"></div>
    </div>
</div>

<div class="message" id="finalMessage"></div>

<script>
function openTab(evt, tabName) {
    const tabcontents = document.getElementsByClassName("tabcontent");
    for (let i=0; i<tabcontents.length; i++){
        tabcontents[i].style.display = "none";
    }
    const tablinks = document.getElementsByClassName("tablinks");
    for (let i=0; i<tablinks.length; i++){
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    document.getElementById(tabName).style.display = "block";
    evt.currentTarget.className += " active";
}

let currentJobId = null;
let intervalId = null;

/********************************************************
 * POLL PROGRESS
 ********************************************************/
async function pollProgress() {
    if (!currentJobId) return;
    try {
        const resp = await fetch('/progress/' + currentJobId);
        const data = await resp.json();
        // Optional debugging
        console.log("Progress check:", data);

        if (data.status === "running") {
            document.getElementById('progressBar').style.width = data.progress + '%';
        } else {
            // Done or error
            clearInterval(intervalId);
            document.getElementById('progressBar').style.width = '100%';
            const msgDiv = document.getElementById('finalMessage');
            msgDiv.style.display = 'block';
            msgDiv.textContent = data.message;
        }
    } catch(err) {
        clearInterval(intervalId);
        const msgDiv = document.getElementById('finalMessage');
        msgDiv.style.display = 'block';
        msgDiv.textContent = "Error polling progress: " + err;
    }
}

/********************************************************
 * ESTIMATE FILE SIZE (Compression Tab)
 ********************************************************/
document.getElementById('estimateBtn').addEventListener('click', async function() {
    const fileInput = document.getElementById('input_file_compress');
    const bitrate   = document.getElementById('bitrate').value.trim();
    if(!fileInput.files[0]) {
        alert("No file selected.");
        return;
    }
    if(!bitrate) {
        alert("Bitrate is required.");
        return;
    }
    const formData = new FormData();
    formData.append('input_file', fileInput.files[0]);
    formData.append('bitrate', bitrate);

    try {
        const resp = await fetch('/estimate', { method: 'POST', body: formData });
        const data = await resp.json();
        const estDiv = document.getElementById('estimatedSize');
        if(data.estimated_size_mb !== undefined) {
            estDiv.textContent = "Estimated final size: " + data.estimated_size_mb.toFixed(2) + " MB";
            estDiv.style.display = 'block';
        } else {
            estDiv.textContent = data.message || "Error estimating size.";
            estDiv.style.display = 'block';
        }
    } catch(err) {
        alert("Error calling /estimate: " + err);
    }
});

/********************************************************
 * COMPRESSION SUBMIT
 ********************************************************/
document.getElementById('compressForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const fileInput = document.getElementById('input_file_compress');
    const bitrate   = document.getElementById('bitrate').value.trim();
    const outDir    = document.getElementById('output_dir_compress').value.trim();
    let outFilename = document.getElementById('output_filename').value.trim();

    if(!fileInput.files[0]) {
        alert("No file selected.");
        return;
    }
    if(!bitrate) {
        alert("Bitrate is required.");
        return;
    }
    if(!outDir) {
        alert("Output directory is required.");
        return;
    }
    if(outFilename && !outFilename.includes(".")) {
        outFilename += ".mp4";
    } else if(!outFilename) {
        outFilename = "output.mp4";
    }

    const formData = new FormData();
    formData.append('input_file', fileInput.files[0]);
    formData.append('bitrate', bitrate);
    formData.append('output_dir', outDir);
    formData.append('output_filename', outFilename);

    try {
        const resp = await fetch('/compress', { method: 'POST', body: formData });
        const data = await resp.json();
        console.log("Compress start response:", data);

        if(data.job_id) {
            currentJobId = data.job_id;
            document.getElementById('progressSection').style.display = 'block';
            intervalId = setInterval(pollProgress, 1000);
        } else {
            alert(data.message || "Error starting compression.");
        }
    } catch(err) {
        alert("Error calling /compress: " + err);
    }
});

/********************************************************
 * CONVERSION SUBMIT
 ********************************************************/
document.getElementById('convertForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const fileInput = document.getElementById('input_file_convert');
    const format    = document.getElementById('convert_format').value;
    const outDir    = document.getElementById('output_dir_convert').value.trim();
    let outFilename = document.getElementById('convert_outfilename').value.trim();

    if(!fileInput.files[0]) {
        alert("No file selected.");
        return;
    }
    if(!outDir) {
        alert("Output directory is required.");
        return;
    }
    if(outFilename && !outFilename.includes(".")) {
        outFilename += "." + format;
    }

    const formData = new FormData();
    formData.append('input_file', fileInput.files[0]);
    formData.append('format', format);
    formData.append('output_dir', outDir);
    formData.append('output_filename', outFilename);

    try {
        const resp = await fetch('/convert', { method: 'POST', body: formData });
        const data = await resp.json();
        console.log("Convert start response:", data);

        if(data.job_id) {
            currentJobId = data.job_id;
            document.getElementById('progressSection').style.display = 'block';
            intervalId = setInterval(pollProgress, 1000);
        } else {
            alert(data.message || "Error starting conversion.");
        }
    } catch(err) {
        alert("Error calling /convert: " + err);
    }
});
</script>
</body>
</html>
"""

###############################
# SERVER-SIDE LOGIC
###############################
def get_duration(path):
    """Get total duration in seconds using ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        path
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode == 0 and proc.stdout.strip():
            return float(proc.stdout.strip())
    except:
        pass
    return 0.0  # fallback if something goes wrong

# Provide the cleanup function used by run_ffmpeg_generic()
def cleanup_temp_folder():
    """Remove the entire temp folder after each job, then recreate."""
    if os.path.exists(TEMP_FOLDER):
        shutil.rmtree(TEMP_FOLDER, ignore_errors=True)
    os.makedirs(TEMP_FOLDER, exist_ok=True)

def run_ffmpeg_generic(job_id, command, total_duration):
    """Run ffmpeg with `-y` to avoid overwrite prompts.
       Parse out_time_ms= lines to track progress.
       On completion, remove the temp folder so no leftover files remain.
    """
    # Ensure -y appears before the output path
    if len(command) >= 3:
        out_idx = len(command) - 1
        command.insert(out_idx, "-y")

    print(f"[DEBUG] Starting FFmpeg command: {' '.join(command)}")

    jobs[job_id]["status"] = "running"
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    try:
        for raw in p.stdout:
            line = raw.strip()
            if line.startswith("out_time_ms="):
                try:
                    out_ms = float(line.split("=", 1)[1])
                    if total_duration > 0:
                        pct = min(max((out_ms / 1_000_000.0) / total_duration * 100, 0), 100)
                        jobs[job_id]["progress"] = pct
                except ValueError:
                    pass
        p.wait()
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = f"An exception occurred: {e}"
        cleanup_temp_folder()
        return

    # After finishing, remove the entire temp folder
    cleanup_temp_folder()

    if p.returncode == 0:
        jobs[job_id]["status"] = "done"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["message"] = "Operation completed successfully!"
    else:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = "FFmpeg failed. Please check your settings or paths."

def run_ffmpeg_compress(job_id, in_path, bitrate, out_path, duration):
    cmd = [
        "ffmpeg",
        "-i", in_path,
        "-b:v", bitrate,
        "-progress", "pipe:1",
        "-nostats",
        out_path
    ]
    run_ffmpeg_generic(job_id, cmd, duration)

def run_ffmpeg_convert(job_id, in_path, fmt, out_path, duration):
    cmd = [
        "ffmpeg",
        "-i", in_path,
        "-b:v", "2000k",
        "-progress", "pipe:1",
        "-nostats",
        out_path
    ]
    run_ffmpeg_generic(job_id, cmd, duration)

from flask import render_template_string, jsonify, request
from werkzeug.utils import secure_filename

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route("/estimate", methods=["POST"])
def estimate():
    """Calculate approximate file size from user-chosen bitrate * duration."""
    if "input_file" not in request.files:
        return jsonify(message="No file selected.")
    f = request.files["input_file"]
    if not f or f.filename == "":
        return jsonify(message="No file selected.")

    bitrate = request.form.get("bitrate", "").strip()
    if not bitrate:
        return jsonify(message="Bitrate is required.")

    # Save input to a temp file
    in_name = secure_filename(f.filename)
    in_path = os.path.join(TEMP_FOLDER, in_name)
    f.save(in_path)

    duration = get_duration(in_path)

    def parse_bps(s):
        s = s.lower().strip()
        if s.endswith("k"):
            return float(s[:-1]) * 1_000
        if s.endswith("m"):
            return float(s[:-1]) * 1_000_000
        return float(s)

    try:
        bps = parse_bps(bitrate)
    except ValueError:
        try:
            os.remove(in_path)
        except FileNotFoundError:
            pass
        return jsonify(message="Invalid bitrate format (e.g. 1000k, 1M).")

    est_mb = 0.0
    if duration > 0 and bps > 0:
        size_bytes = (bps * duration) / 8.0
        est_mb = size_bytes / (1024.0 * 1024.0)

    try:
        os.remove(in_path)
    except FileNotFoundError:
        pass
    return jsonify(estimated_size_mb=est_mb)

@app.route("/compress", methods=["POST"])
def compress():
    """Handle the compression job."""
    if "input_file" not in request.files:
        return jsonify(message="No file selected.")
    f = request.files["input_file"]
    if not f or f.filename == "":
        return jsonify(message="No file selected.")

    bitrate = request.form.get("bitrate", "").strip()
    if not bitrate:
        return jsonify(message="Bitrate is required.")

    out_dir = request.form.get("output_dir", "").strip()
    if not out_dir:
        return jsonify(message="Output directory is required.")
    os.makedirs(out_dir, exist_ok=True)

    out_fname = request.form.get("output_filename", "").strip() or DEFAULT_OUTPUT_FILENAME

    in_name = secure_filename(f.filename)
    in_path = os.path.join(TEMP_FOLDER, in_name)
    f.save(in_path)

    final_path = os.path.join(out_dir, out_fname)
    duration = get_duration(in_path)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "running", "progress": 0.0, "message": ""}

    t = threading.Thread(
        target=run_ffmpeg_compress,
        args=(job_id, in_path, bitrate, final_path, duration),
        daemon=True
    )
    t.start()

    return jsonify(job_id=job_id)

@app.route("/convert", methods=["POST"])
def convert():
    """Handle format conversion job."""
    if "input_file" not in request.files:
        return jsonify(message="No file selected.")
    f = request.files["input_file"]
    if not f or f.filename == "":
        return jsonify(message="No file selected.")

    fmt = request.form.get("format", "mp4").lower().strip()
    out_dir = request.form.get("output_dir", "").strip()
    if not out_dir:
        return jsonify(message="Output directory is required.")
    os.makedirs(out_dir, exist_ok=True)

    out_name = request.form.get("output_filename", "").strip()
    in_name = secure_filename(f.filename)
    in_path = os.path.join(TEMP_FOLDER, in_name)
    f.save(in_path)

    if not out_name:
        base, _ = os.path.splitext(in_name)
        out_name = base + "." + fmt
    else:
        if "." not in out_name:
            out_name += "." + fmt

    final_path = os.path.join(out_dir, out_name)
    if not final_path.endswith(f".{fmt}"):
        final_path += f".{fmt}"

    duration = get_duration(in_path)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "running", "progress": 0.0, "message": ""}

    t = threading.Thread(
        target=run_ffmpeg_convert,
        args=(job_id, in_path, fmt, final_path, duration),
        daemon=True
    )
    t.start()

    return jsonify(job_id=job_id)

@app.route("/progress/<job_id>")
def progress(job_id):
    """Poll the job's status & progress. Return JSON."""
    job = jobs.get(job_id)
    if not job:
        return jsonify(status="error", message="Invalid job ID.")

    if job["status"] == "running":
        return jsonify(status="running", progress=int(job["progress"]))
    else:
        return jsonify(
            status=job["status"],
            progress=int(job["progress"]),
            message=job["message"]
        )

def open_browser():
    webbrowser.open("http://127.0.0.1:5000")

if __name__ == "__main__":
    Timer(1.0, open_browser).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
