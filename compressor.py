import os
import subprocess
import webbrowser
import uuid
import threading
import time
from flask import Flask, request, render_template_string, jsonify
from threading import Timer
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.secret_key = 'your_secret_key'

# Directory for temporary uploads
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads')
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

# Default directory for output files
DEFAULT_OUTPUT_DIR = r"E:\My Applications\FFmpeg Compressor\Compressed videos"
DEFAULT_OUTPUT_FILENAME = "output.mp4"

# A dictionary to store progress information keyed by job_id
# Structure: jobs[job_id] = {
#     "status": "running"|"done"|"error",
#     "progress": 0 to 100,
#     "message": "Success or error message"
# }
jobs = {}

HTML_TEMPLATE = """
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
        overflow-x: hidden;
    }
    .header {
        background: rgba(255,255,255,0.05);
        padding: 1em;
        text-align: center;
        border-bottom: 1px solid #444;
    }
    .container {
        background: #1f1f1f;
        padding: 2em;
        border-radius: 10px;
        max-width: 700px;
        margin: 2em auto;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        position: relative;
    }
    h1, h2, h3 {
        text-align: center;
        margin-bottom: 1.5em;
        color: #fff;
    }
    label {
        display: block;
        margin: 1em 0 0.5em;
        font-weight: bold;
        font-size: 1.1em;
        color: #ccc;
    }
    input[type=text], input[type=file] {
        width: 100%;
        padding: 0.7em;
        box-sizing: border-box;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 1em;
        background: #2e2e2e;
        color: #eee;
    }
    button {
        margin-top: 1.5em;
        padding: 0.7em 1.5em;
        background: #444;
        color: #eee;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 1em;
        transition: background 0.3s;
        display: block;
        margin-left: auto;
        margin-right: auto;
    }
    button:hover {
        background: #555;
    }
    .note {
        font-size: 0.9em;
        color: #aaa;
        margin-top: 0.5em;
    }
    .section {
        background: #2a2a2a;
        padding: 1em;
        border-radius: 5px;
        margin-bottom: 1em;
    }
    .message {
        margin-top: 2em;
        background: #2a2a2a;
        padding: 1em;
        border-radius: 4px;
        font-size: 1.05em;
        text-align: center;
        color: #ddd;
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
</style>

</head>
<body>
    <div class="header">
        <h1>FFmpeg Video Compression</h1>
    </div>
    <div class="container" id="mainContainer">
        <form id="compressForm" method="POST" action="/" enctype="multipart/form-data">
            <div class="section">
                <label for="input_file">Select Input File:</label>
                <input type="file" id="input_file" name="input_file" required>
                <div class="note">Choose a video file from your computer.</div>
            </div>

            <div class="section">
                <label for="bitrate">Bitrate (e.g. 1000k):</label>
                <input type="text" id="bitrate" name="bitrate" placeholder="e.g. 1000k" required>
                <div class="note">Specify the video bitrate to compress to.</div>
            </div>

            <div class="section">
                <h3>Output Settings</h3>
                <label for="output_dir">Output Directory:</label>
                <input type="text" id="output_dir" name="output_dir" value="{{ default_output_dir }}">
                <div class="note">By default, files go to the above folder.</div>

                <label for="output_filename">Output Filename:</label>
                <input type="text" id="output_filename" name="output_filename" value="{{ default_output_filename }}">
                <div class="note">Specify the name for the compressed file.</div>

                <label for="output_file">Or Custom Full Output Path:</label>
                <input type="text" id="output_file" name="output_file" placeholder="e.g. D:\\another_folder\\my_compressed_video.mp4">
               
            </div>

            <button type="submit">Compress</button>
        </form>

        <div id="progressSection">
            <div class="loading-text">Compressing video, please wait...</div>
            <div class="progress-container">
                <div class="progress-bar" id="progressBar"></div>
            </div>
        </div>

        <div class="message" id="resultMessage" style="display:none;"></div>
    </div>

    <script>
    const form = document.getElementById('compressForm');
    const progressSection = document.getElementById('progressSection');
    const progressBar = document.getElementById('progressBar');
    const resultMessage = document.getElementById('resultMessage');
    const mainContainer = document.getElementById('mainContainer');

    let jobId = null;
    let intervalId = null;

    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        // Send form data via AJAX
        const formData = new FormData(form);

        const response = await fetch('/', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (data.job_id) {
            jobId = data.job_id;
            // Hide form, show progress bar
            form.style.display = 'none';
            progressSection.style.display = 'block';

            // Start polling progress
            intervalId = setInterval(checkProgress, 1000);
        } else {
            // If no job_id returned, show error
            resultMessage.style.display = 'block';
            resultMessage.textContent = data.message || "Error starting compression.";
        }
    });

    async function checkProgress() {
        if (!jobId) return;
        const resp = await fetch('/progress/' + jobId);
        const data = await resp.json();
        if (data.status === "running") {
            progressBar.style.width = data.progress + '%';
        } else {
            clearInterval(intervalId);
            progressBar.style.width = '100%';
            if (data.status === "done") {
                resultMessage.style.display = 'block';
                resultMessage.textContent = data.message;
            } else {
                resultMessage.style.display = 'block';
                resultMessage.textContent = data.message || "An error occurred.";
            }
        }
    }
    </script>
</body>
</html>
"""

def get_duration(input_path):
    """Get video duration in seconds using ffprobe."""
    cmd = [
        "ffprobe", 
        "-v", "error", 
        "-show_entries", "format=duration", 
        "-of", "default=noprint_wrappers=1:nokey=1",
        input_path
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode == 0 and result.stdout.strip():
        return float(result.stdout.strip())
    return None

def run_ffmpeg(job_id, input_path, bitrate, output_path, total_duration):
    # Run ffmpeg with progress
    # -progress pipe:1 outputs progress info to stdout
    # -nostats avoids clutter
    command = [
        "ffmpeg",
        "-i", input_path,
        "-b:v", bitrate,
        "-progress", "pipe:1",
        "-nostats",
        output_path
    ]

    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    # Parse progress lines
    # ffmpeg -progress format gives lines like:
    # out_time_ms=...
    # When finished, we exit loop.
    try:
        for line in process.stdout:
            line = line.strip()
            if "out_time_ms=" in line:
                out_time_ms = float(line.split('=')[1])
                current_seconds = out_time_ms / 1_000_000.0
                if total_duration and total_duration > 0:
                    pct = (current_seconds / total_duration) * 100
                    pct = min(max(pct, 0), 100)
                    jobs[job_id]["progress"] = pct
        process.wait()
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = f"An error occurred: {str(e)}"
        return

    # After done, check return code
    if process.returncode == 0:
        jobs[job_id]["status"] = "done"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["message"] = "Compression completed successfully!"
    else:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = "Compression failed. Please check your settings and try again."


@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST":
        if 'input_file' not in request.files:
            return jsonify(message="No file selected.")

        file = request.files['input_file']
        if file.filename == '':
            return jsonify(message="No file selected.")

        bitrate = request.form.get("bitrate", "").strip()
        output_dir = request.form.get("output_dir", "").strip()
        output_filename = request.form.get("output_filename", "").strip()
        custom_output_file = request.form.get("output_file", "").strip()

        if not bitrate:
            return jsonify(message="Bitrate is required.")

        # Save uploaded file temporarily
        input_filename = secure_filename(file.filename)
        input_path = os.path.join(UPLOAD_FOLDER, input_filename)
        file.save(input_path)

        # Determine output path
        if custom_output_file:
            final_output_path = custom_output_file
        else:
            if not output_dir:
                output_dir = DEFAULT_OUTPUT_DIR
            if not output_filename:
                output_filename = DEFAULT_OUTPUT_FILENAME
            final_output_path = os.path.join(output_dir, output_filename)

        # Ensure the output directory exists
        os.makedirs(os.path.dirname(final_output_path), exist_ok=True)

        # Get total duration for progress calculation
        duration = get_duration(input_path)
        if duration is None:
            # If we can't get duration, we can still attempt compression, but progress might be unreliable
            duration = 0

        job_id = str(uuid.uuid4())
        jobs[job_id] = {
            "status": "running",
            "progress": 0.0,
            "message": ""
        }

        # Start ffmpeg in a separate thread
        t = threading.Thread(target=run_ffmpeg, args=(job_id, input_path, bitrate, final_output_path, duration), daemon=True)
        t.start()

        # Return job_id immediately so front-end can start polling
        return jsonify(job_id=job_id)
    else:
        return render_template_string(
            HTML_TEMPLATE,
            default_output_dir=DEFAULT_OUTPUT_DIR,
            default_output_filename=DEFAULT_OUTPUT_FILENAME
        )

@app.route("/progress/<job_id>")
def progress(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify(status="error", message="Invalid job ID.")

    if job["status"] == "running":
        return jsonify(status="running", progress=int(job["progress"]))
    else:
        # Job done or error
        msg = job.get("message", "")
        return jsonify(status=job["status"], progress=int(job["progress"]), message=msg)

def open_browser():
    webbrowser.open("http://127.0.0.1:5000")

if __name__ == "__main__":
    # Open browser after a short delay
    Timer(1.0, open_browser).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
