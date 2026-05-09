"use strict";

const $ = (selector) => document.querySelector(selector);

const refs = {
  engineText: $("#engineText"),
  dropZone: $("#dropZone"),
  fileInput: $("#fileInput"),
  fileName: $("#fileName"),
  fileMeta: $("#fileMeta"),
  targetSize: $("#targetSize"),
  targetUnit: $("#targetUnit"),
  targetOutput: $("#targetOutput"),
  bitrate: $("#bitrate"),
  outputName: $("#outputName"),
  statusText: $("#statusText"),
  progressLabel: $("#progressLabel"),
  progressBar: $("#progressBar"),
  compressBtn: $("#compressBtn"),
  stopBtn: $("#stopBtn"),
  logOutput: $("#logOutput")
};

const TARGET_AUDIO_BPS = 128_000;
const MIN_TARGET_VIDEO_BPS = 100_000;

const MIME_BY_EXT = {
  avi: "video/x-msvideo",
  gif: "image/gif",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm"
};

let ffmpeg = null;
let selectedMedia = null;
let busy = false;
let cancelRequested = false;
let maxProgress = 0;
let targetTimer = null;
let targetRunId = 0;
let logLines = [];

function runtimeUrl(path) {
  return globalThis.chrome?.runtime?.getURL ? globalThis.chrome.runtime.getURL(path) : path;
}

function setEngine(text, state = "") {
  refs.engineText.textContent = text;
  refs.engineText.className = `engine ${state}`.trim();
}

function setStatus(text) {
  refs.statusText.textContent = text;
}

function setBusy(isBusy) {
  busy = isBusy;
  refs.compressBtn.disabled = isBusy;
  refs.stopBtn.disabled = !isBusy;
  refs.fileInput.disabled = isBusy;
  refs.targetSize.disabled = isBusy;
  refs.targetUnit.disabled = isBusy;
  refs.bitrate.disabled = isBusy;
  refs.outputName.disabled = isBusy;
}

function setProgress(value) {
  const pct = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  refs.progressBar.style.width = `${pct}%`;
  refs.progressLabel.textContent = `${Math.round(pct)}%`;
  if (busy) setStatus(`Compressing ${Math.round(pct)}%`);
}

function addLog(line) {
  if (!line) return;
  logLines.push(line);
  if (logLines.length > 60) {
    logLines = logLines.slice(-60);
  }
  refs.logOutput.textContent = logLines.join("\n");
  refs.logOutput.scrollTop = refs.logOutput.scrollHeight;
}

function clearLog() {
  logLines = [];
  refs.logOutput.textContent = "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatBitrate(bps) {
  return `${Math.max(1, Math.round(bps / 1000))}k`;
}

function extensionOf(filename) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename || "");
  return match ? match[1].toLowerCase() : "";
}

function basenameWithoutExtension(filename) {
  return (filename || "output").replace(/\.[^/.\\]+$/, "");
}

function sanitizeFilename(filename, fallback) {
  const leaf = (filename || fallback || "output").split(/[\\/]/).pop();
  return leaf
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || fallback || "output";
}

function ensureExtension(filename, ext) {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const safe = sanitizeFilename(filename, `output.${cleanExt}`);
  return extensionOf(safe) ? safe : `${safe}.${cleanExt}`;
}

function parseBitrateToBps(value) {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec((value || "").trim());
  if (!match) throw new Error("Use a bitrate like 1000k, 2M, or 1500000.");
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bitrate must be greater than zero.");
  const unit = match[2].toLowerCase();
  if (unit === "m") return amount * 1_000_000;
  if (unit === "k") return amount * 1_000;
  return amount;
}

function parseTargetBytes() {
  const raw = refs.targetSize.value.trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a target size greater than 0.");
  return amount * (refs.targetUnit.value === "gb" ? 1024 ** 3 : 1024 ** 2);
}

function virtualInputName(file) {
  return `input_${Date.now()}.${extensionOf(file.name) || "bin"}`;
}

function virtualOutputName(filename) {
  return `output_${Date.now()}.${extensionOf(filename) || "mp4"}`;
}

function mimeFor(filename) {
  return MIME_BY_EXT[extensionOf(filename)] || "application/octet-stream";
}

function setSelectedFile(file) {
  if (!file) return;
  selectedMedia = file;
  refs.fileName.textContent = file.name;
  refs.fileMeta.textContent = formatBytes(file.size);
  if (!refs.outputName.value.trim()) {
    refs.outputName.value = `${basenameWithoutExtension(file.name) || "output"}-compressed.mp4`;
  }
  scheduleTargetUpdate();
}

async function ensureFFmpeg() {
  if (!window.FFmpegWASM?.FFmpeg) {
    setEngine("Setup required", "error");
    throw new Error("FFmpeg was not found. Open the full app setup guide.");
  }

  if (!ffmpeg) {
    ffmpeg = new window.FFmpegWASM.FFmpeg();
    ffmpeg.on("log", ({ type, message }) => addLog(`[${type}] ${message}`));
    ffmpeg.on("progress", ({ progress }) => {
      if (!busy || !Number.isFinite(progress)) return;
      maxProgress = Math.max(maxProgress, Math.min(99, progress * 100));
      setProgress(maxProgress);
    });
  }

  if (!ffmpeg.loaded) {
    setEngine("Loading", "busy");
    addLog("Loading FFmpeg...");
    await ffmpeg.load({
      coreURL: runtimeUrl("vendor/ffmpeg/ffmpeg-core.js"),
      wasmURL: runtimeUrl("vendor/ffmpeg/ffmpeg-core.wasm")
    });
    setEngine("Ready", "ready");
  }

  return ffmpeg;
}

async function getMediaElementDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number(video.duration);
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 2500);
    video.src = url;
  });
}

async function cleanupFiles(engine, paths) {
  for (const path of paths) {
    try {
      await engine.deleteFile(path);
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function getFFprobeDuration(file) {
  const engine = await ensureFFmpeg();
  const inputName = virtualInputName(file);
  const durationFile = `duration_${Date.now()}.txt`;
  const data = new Uint8Array(await file.arrayBuffer());

  try {
    await engine.writeFile(inputName, data);
    const code = await engine.ffprobe([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputName,
      "-o", durationFile
    ]);
    if (code !== 0) return null;
    const durationText = await engine.readFile(durationFile, "utf8");
    const duration = Number.parseFloat(String(durationText).trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } finally {
    await cleanupFiles(engine, [inputName, durationFile]);
  }
}

function scheduleTargetUpdate() {
  clearTimeout(targetTimer);
  targetTimer = setTimeout(() => {
    updateTargetBitrate().catch((error) => {
      refs.targetOutput.textContent = error.message || String(error);
      refs.targetOutput.className = "hint error";
    });
  }, 350);
}

async function updateTargetBitrate() {
  const runId = ++targetRunId;
  refs.targetOutput.className = "hint";
  const targetBytes = parseTargetBytes();
  if (!targetBytes) {
    refs.targetOutput.textContent = "";
    return;
  }
  if (!selectedMedia) {
    refs.targetOutput.textContent = "Choose a file first.";
    refs.targetOutput.className = "hint error";
    return;
  }

  refs.targetOutput.textContent = "Calculating bitrate...";
  let duration = await getMediaElementDuration(selectedMedia);
  if (!duration) duration = await getFFprobeDuration(selectedMedia);
  if (runId !== targetRunId) return;
  if (!duration) throw new Error("Could not read media duration.");

  const totalBps = (targetBytes * 8) / duration;
  const videoBps = Math.max(MIN_TARGET_VIDEO_BPS, totalBps - TARGET_AUDIO_BPS);
  const bitrate = formatBitrate(videoBps);
  refs.bitrate.value = bitrate;

  refs.targetOutput.textContent = `Set ${bitrate} for about ${formatBytes(targetBytes)} over ${formatDuration(duration)}.`;
  if (videoBps === MIN_TARGET_VIDEO_BPS) {
    refs.targetOutput.textContent = `Target is very small; set minimum ${bitrate}.`;
    refs.targetOutput.className = "hint warn";
  }
}

async function saveOutput(data, filename) {
  const blob = new Blob([data], { type: mimeFor(filename) });
  const url = URL.createObjectURL(blob);

  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(downloadId);
      });
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function compressSelectedFile() {
  if (busy) return;
  if (!selectedMedia) {
    setStatus("Choose a file first");
    return;
  }

  parseBitrateToBps(refs.bitrate.value);
  cancelRequested = false;
  clearLog();
  maxProgress = 0;
  setProgress(0);
  setBusy(true);
  setStatus("Starting");

  const engine = await ensureFFmpeg();
  const inputName = virtualInputName(selectedMedia);
  const outputFilename = ensureExtension(refs.outputName.value, "mp4");
  const outputName = virtualOutputName(outputFilename);
  const inputData = new Uint8Array(await selectedMedia.arrayBuffer());
  const command = ["-i", inputName, "-b:v", refs.bitrate.value.trim(), "-b:a", "128k", outputName];

  addLog(`Command: ffmpeg ${command.join(" ")}`);

  try {
    await engine.writeFile(inputName, inputData);
    const code = await engine.exec(command);
    if (code !== 0) throw new Error(`FFmpeg exited with code ${code}.`);
    const outputData = await engine.readFile(outputName);
    setProgress(100);
    setStatus("Saving download");
    await saveOutput(outputData, outputFilename);
    setStatus(`Done - ${formatBytes(outputData.byteLength)}`);
  } catch (error) {
    setStatus(cancelRequested ? "Stopped" : "Failed");
    addLog(`Error: ${error.message || error}`);
  } finally {
    await cleanupFiles(engine, [inputName, outputName]);
    setBusy(false);
  }
}

refs.dropZone.addEventListener("click", () => {
  if (!busy) refs.fileInput.click();
});

refs.dropZone.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !busy) {
    event.preventDefault();
    refs.fileInput.click();
  }
});

refs.fileInput.addEventListener("change", () => {
  setSelectedFile(refs.fileInput.files?.[0]);
});

for (const eventName of ["dragenter", "dragover"]) {
  refs.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!busy) refs.dropZone.classList.add("drag-over");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  refs.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    refs.dropZone.classList.remove("drag-over");
  });
}

refs.dropZone.addEventListener("drop", (event) => {
  if (busy) return;
  setSelectedFile(event.dataTransfer.files?.[0]);
});

refs.targetSize.addEventListener("input", scheduleTargetUpdate);
refs.targetUnit.addEventListener("change", scheduleTargetUpdate);
refs.compressBtn.addEventListener("click", () => {
  compressSelectedFile().catch((error) => {
    setStatus("Failed");
    addLog(`Error: ${error.message || error}`);
    setBusy(false);
  });
});

refs.stopBtn.addEventListener("click", () => {
  cancelRequested = true;
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
  }
  setEngine("Ready", "ready");
  setStatus("Stopped");
  setBusy(false);
});

setEngine(window.FFmpegWASM?.FFmpeg ? "Ready" : "Setup required", window.FFmpegWASM?.FFmpeg ? "ready" : "error");
