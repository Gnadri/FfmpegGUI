"use strict";

const $ = (selector) => document.querySelector(selector);

const refs = {
  compressTab: $("#compressTab"),
  convertTab: $("#convertTab"),
  compressPanel: $("#compressPanel"),
  convertPanel: $("#convertPanel"),
  compressFile: $("#compressFile"),
  convertFile: $("#convertFile"),
  compressFileMeta: $("#compressFileMeta"),
  convertFileMeta: $("#convertFileMeta"),
  bitrate: $("#bitrate"),
  targetSize: $("#targetSize"),
  targetSizeUnit: $("#targetSizeUnit"),
  targetSizeOutput: $("#targetSizeOutput"),
  compressOutputName: $("#compressOutputName"),
  convertOutputName: $("#convertOutputName"),
  convertFormat: $("#convertFormat"),
  estimateBtn: $("#estimateBtn"),
  estimateOutput: $("#estimateOutput"),
  cancelBtn: $("#cancelBtn"),
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  engineStat: $("#engineStat"),
  engineHelpBtn: $("#engineHelpBtn"),
  jobTitle: $("#jobTitle"),
  jobDetail: $("#jobDetail"),
  progressBar: $("#progressBar"),
  progressLabel: $("#progressLabel"),
  elapsedLabel: $("#elapsedLabel"),
  inputStat: $("#inputStat"),
  outputStat: $("#outputStat"),
  logOutput: $("#logOutput")
};

const MIME_BY_EXT = {
  avi: "video/x-msvideo",
  gif: "image/gif",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm"
};

const TARGET_AUDIO_BPS = 128_000;
const MIN_TARGET_VIDEO_BPS = 100_000;

let ffmpeg = null;
let busy = false;
let cancelRequested = false;
let startedAt = 0;
let elapsedTimer = null;
let maxProgress = 0;
let logLines = [];
let activeTaskLabel = "";
let targetSizeTimer = null;
let targetSizeRunId = 0;

function runtimeUrl(path) {
  return globalThis.chrome?.runtime?.getURL ? globalThis.chrome.runtime.getURL(path) : path;
}

function setTaskStatus(text, state = "") {
  refs.statusText.textContent = text;
  refs.statusDot.className = `status-dot ${state}`.trim();
}

function setEngineStatus(text, state = "", showHelp = false) {
  refs.engineStat.textContent = text;
  refs.engineStat.className = state ? `engine-${state}` : "";
  refs.engineHelpBtn.hidden = !showHelp;
}

function setEngineReady() {
  setEngineStatus("Ready", "ready", false);
}

function setEngineSetupRequired() {
  setEngineStatus("Setup required", "error", true);
}

function setJob(title, detail = "") {
  refs.jobTitle.textContent = title;
  refs.jobDetail.textContent = detail;
}

function setProgress(value) {
  const pct = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  refs.progressBar.style.width = `${pct}%`;
  refs.progressLabel.textContent = `${Math.round(pct)}%`;
  if (busy && activeTaskLabel) {
    setTaskStatus(`${activeTaskLabel} ${Math.round(pct)}%`, "busy");
  }
}

function setBusy(isBusy, allowCancel = true) {
  busy = isBusy;
  const controls = document.querySelectorAll("input, select, .primary, .secondary, .tab");
  controls.forEach((control) => {
    control.disabled = isBusy;
  });
  refs.cancelBtn.disabled = !isBusy || !allowCancel;
}

function resetProgress() {
  maxProgress = 0;
  setProgress(0);
  refs.elapsedLabel.textContent = "00:00";
}

function startElapsedTimer() {
  startedAt = Date.now();
  refs.elapsedLabel.textContent = "00:00";
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    refs.elapsedLabel.textContent = formatDuration((Date.now() - startedAt) / 1000);
  }, 500);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function addLog(line) {
  if (!line) return;
  logLines.push(line);
  if (logLines.length > 120) {
    logLines = logLines.slice(-120);
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
  const kbps = Math.max(1, Math.round(bps / 1000));
  return `${kbps}k`;
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

function forceExtension(filename, ext, fallbackBase) {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const safe = sanitizeFilename(filename, `${fallbackBase}.${cleanExt}`);
  const base = basenameWithoutExtension(safe) || fallbackBase;
  return `${base}.${cleanExt}`;
}

function virtualInputName(file) {
  const ext = extensionOf(file.name) || "bin";
  return `input_${Date.now()}.${ext}`;
}

function virtualOutputName(filename) {
  const ext = extensionOf(filename) || "mp4";
  return `output_${Date.now()}.${ext}`;
}

function parseBitrateToBps(value) {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec((value || "").trim());
  if (!match) {
    throw new Error("Use a bitrate like 1000k, 2M, or 1500000.");
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Bitrate must be greater than zero.");
  }
  if (unit === "m") return amount * 1_000_000;
  if (unit === "k") return amount * 1_000;
  return amount;
}

function parseTargetSizeBytes() {
  const raw = refs.targetSize.value.trim();
  if (!raw) return null;

  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a target size greater than 0.");
  }

  const multiplier = refs.targetSizeUnit.value === "gb" ? 1024 ** 3 : 1024 ** 2;
  return amount * multiplier;
}

function selectedFile(input) {
  return input.files && input.files[0] ? input.files[0] : null;
}

function updateFileMeta(input, meta) {
  const file = selectedFile(input);
  meta.textContent = file ? `${file.name} - ${formatBytes(file.size)}` : "No file selected";
}

function switchPanel(mode) {
  const isCompression = mode === "compression";
  refs.compressTab.classList.toggle("active", isCompression);
  refs.compressTab.setAttribute("aria-selected", String(isCompression));
  refs.convertTab.classList.toggle("active", !isCompression);
  refs.convertTab.setAttribute("aria-selected", String(!isCompression));
  refs.compressPanel.hidden = !isCompression;
  refs.convertPanel.hidden = isCompression;
  refs.compressPanel.classList.toggle("active", isCompression);
  refs.convertPanel.classList.toggle("active", !isCompression);
}

async function ensureFFmpeg() {
  if (!window.FFmpegWASM?.FFmpeg) {
    setEngineSetupRequired();
    throw new Error("FFmpeg was not found. Open setup help for repair steps.");
  }

  if (!ffmpeg) {
    ffmpeg = new window.FFmpegWASM.FFmpeg();
    ffmpeg.on("log", ({ type, message }) => {
      addLog(`[${type}] ${message}`);
    });
    ffmpeg.on("progress", ({ progress }) => {
      if (!busy || !Number.isFinite(progress)) return;
      maxProgress = Math.max(maxProgress, Math.min(99, progress * 100));
      setProgress(maxProgress);
    });
  }

  if (!ffmpeg.loaded) {
    setEngineReady();
    addLog("Loading FFmpeg WebAssembly runtime...");
    try {
      await ffmpeg.load({
        coreURL: runtimeUrl("vendor/ffmpeg/ffmpeg-core.js"),
        wasmURL: runtimeUrl("vendor/ffmpeg/ffmpeg-core.wasm")
      });
      setEngineReady();
    } catch (error) {
      setEngineSetupRequired();
      throw error;
    }
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

function scheduleTargetBitrateUpdate() {
  clearTimeout(targetSizeTimer);
  targetSizeTimer = setTimeout(() => {
    updateTargetBitrate().catch((error) => {
      refs.targetSizeOutput.textContent = error.message || String(error);
      refs.targetSizeOutput.className = "target-output error";
    });
  }, 350);
}

async function updateTargetBitrate() {
  const runId = ++targetSizeRunId;
  refs.targetSizeOutput.className = "target-output";

  const targetBytes = parseTargetSizeBytes();
  if (!targetBytes) {
    refs.targetSizeOutput.textContent = "";
    return;
  }

  const file = selectedFile(refs.compressFile);
  if (!file) {
    refs.targetSizeOutput.textContent = "Select an input file first.";
    refs.targetSizeOutput.className = "target-output error";
    return;
  }

  refs.targetSizeOutput.textContent = "Calculating bitrate...";
  let duration = await getMediaElementDuration(file);
  if (!duration) {
    duration = await getFFprobeDuration(file);
  }

  if (runId !== targetSizeRunId) return;
  if (!duration) {
    throw new Error("Could not read media duration.");
  }

  const totalBps = (targetBytes * 8) / duration;
  const videoBps = Math.max(MIN_TARGET_VIDEO_BPS, totalBps - TARGET_AUDIO_BPS);
  const bitrate = formatBitrate(videoBps);
  refs.bitrate.value = bitrate;

  if (videoBps === MIN_TARGET_VIDEO_BPS) {
    refs.targetSizeOutput.textContent = `Target is very small; bitrate set to the minimum ${bitrate}.`;
    refs.targetSizeOutput.className = "target-output warn";
    return;
  }

  refs.targetSizeOutput.textContent = `Bitrate set to ${bitrate} for about ${formatBytes(targetBytes)} over ${formatDuration(duration)}.`;
}

async function estimateCompressionSize() {
  const file = selectedFile(refs.compressFile);
  if (!file) {
    throw new Error("Select an input file first.");
  }

  const bps = parseBitrateToBps(refs.bitrate.value);
  refs.estimateOutput.textContent = "";
  setJob("Estimating", file.name);
  activeTaskLabel = "";
  setTaskStatus("Estimating size", "busy");
  setBusy(true, false);
  clearLog();
  resetProgress();

  try {
    let duration = await getMediaElementDuration(file);
    if (!duration) {
      duration = await getFFprobeDuration(file);
    }
    if (!duration) {
      throw new Error("Could not read media duration.");
    }
    const estimatedBytes = ((bps + TARGET_AUDIO_BPS) * duration) / 8;
    refs.estimateOutput.textContent = `Estimated output: ${formatBytes(estimatedBytes)} with 128k audio`;
    setJob("Estimate complete", `${formatDuration(duration)} duration`);
    setTaskStatus("Estimate done", "ready");
  } finally {
    setBusy(false);
    if (ffmpeg?.loaded) {
      setEngineReady();
    }
  }
}

async function cleanupFiles(engine, paths) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await engine.deleteFile(path);
    } catch {
      // Best-effort cleanup for MEMFS paths that may not exist after a failed run.
    }
  }
}

function mimeFor(filename) {
  return MIME_BY_EXT[extensionOf(filename)] || "application/octet-stream";
}

async function saveOutput(data, filename) {
  const blob = new Blob([data], { type: mimeFor(filename) });
  const url = URL.createObjectURL(blob);

  try {
    if (globalThis.chrome?.downloads?.download) {
      await new Promise((resolve, reject) => {
        globalThis.chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
          const error = globalThis.chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(downloadId);
        });
      });
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function buildConvertArgs(inputName, format, outputName) {
  if (format === "gif") {
    return [
      "-i", inputName,
      "-vf", "fps=12,scale=720:-1:flags=lanczos",
      outputName
    ];
  }

  return [
    "-i", inputName,
    "-b:v", "2000k",
    outputName
  ];
}

async function runFFmpegJob({ file, outputFilename, args }) {
  const engine = await ensureFFmpeg();
  const inputName = args.inputName;
  const outputName = args.outputName;
  const command = args.command;
  const inputData = new Uint8Array(await file.arrayBuffer());

  refs.inputStat.textContent = formatBytes(file.size);
  refs.outputStat.textContent = outputFilename;
  addLog(`Command: ffmpeg ${command.join(" ")}`);

  try {
    await engine.writeFile(inputName, inputData);
    const code = await engine.exec(command);
    if (code !== 0) {
      throw new Error(`FFmpeg exited with code ${code}.`);
    }
    const outputData = await engine.readFile(outputName);
    setProgress(100);
    setTaskStatus("Saving download", "busy");
    await saveOutput(outputData, outputFilename);
    refs.outputStat.textContent = `${outputFilename} - ${formatBytes(outputData.byteLength)}`;
  } finally {
    await cleanupFiles(engine, [inputName, outputName]);
  }
}

async function runCompression(event) {
  event.preventDefault();
  const file = selectedFile(refs.compressFile);
  if (!file) throw new Error("Select an input file first.");

  parseBitrateToBps(refs.bitrate.value);
  const outputFilename = ensureExtension(refs.compressOutputName.value, "mp4");
  const inputName = virtualInputName(file);
  const outputName = virtualOutputName(outputFilename);
  const command = [
    "-i", inputName,
    "-b:v", refs.bitrate.value.trim(),
    "-b:a", "128k",
    outputName
  ];

  await runOperation("Compressing", file, () => runFFmpegJob({
    file,
    outputFilename,
    args: { inputName, outputName, command }
  }));
}

async function runConversion(event) {
  event.preventDefault();
  const file = selectedFile(refs.convertFile);
  if (!file) throw new Error("Select an input file first.");

  const format = refs.convertFormat.value;
  const fallbackBase = basenameWithoutExtension(file.name) || "output";
  const outputFilename = forceExtension(refs.convertOutputName.value || fallbackBase, format, fallbackBase);
  const inputName = virtualInputName(file);
  const outputName = virtualOutputName(outputFilename);
  const command = buildConvertArgs(inputName, format, outputName);

  await runOperation("Converting", file, () => runFFmpegJob({
    file,
    outputFilename,
    args: { inputName, outputName, command }
  }));
}

async function runOperation(title, file, task) {
  if (busy) return;
  cancelRequested = false;
  activeTaskLabel = title;
  clearLog();
  resetProgress();
  setBusy(true);
  startElapsedTimer();
  setJob(title, file.name);
  setTaskStatus(`${title} 0%`, "busy");

  try {
    await task();
    if (!cancelRequested) {
      setJob("Complete", "Output sent to Chrome downloads.");
      setTaskStatus("Finished", "ready");
    }
  } catch (error) {
    if (cancelRequested) {
      setJob("Stopped", "The active FFmpeg job was terminated.");
      setTaskStatus("Stopped", "");
    } else {
      setJob("Failed", error.message || String(error));
      setTaskStatus("Needs attention", "error");
      addLog(`Error: ${error.message || error}`);
    }
  } finally {
    activeTaskLabel = "";
    stopElapsedTimer();
    setBusy(false);
  }
}

refs.compressTab.addEventListener("click", () => switchPanel("compression"));
refs.convertTab.addEventListener("click", () => switchPanel("convert"));

refs.compressFile.addEventListener("change", () => {
  updateFileMeta(refs.compressFile, refs.compressFileMeta);
  scheduleTargetBitrateUpdate();
});
refs.convertFile.addEventListener("change", () => updateFileMeta(refs.convertFile, refs.convertFileMeta));
refs.targetSize.addEventListener("input", scheduleTargetBitrateUpdate);
refs.targetSizeUnit.addEventListener("change", scheduleTargetBitrateUpdate);

refs.estimateBtn.addEventListener("click", async () => {
  if (busy) return;
  try {
    await estimateCompressionSize();
  } catch (error) {
    refs.estimateOutput.textContent = error.message || String(error);
    setJob("Estimate Failed", error.message || String(error));
    setTaskStatus("Needs attention", "error");
    if (ffmpeg?.loaded) {
      setEngineReady();
    }
    setBusy(false);
  }
});

refs.compressPanel.addEventListener("submit", (event) => {
  runCompression(event).catch((error) => {
    setJob("Failed", error.message || String(error));
    setTaskStatus("Needs attention", "error");
    setBusy(false);
  });
});

refs.convertPanel.addEventListener("submit", (event) => {
  runConversion(event).catch((error) => {
    setJob("Failed", error.message || String(error));
    setTaskStatus("Needs attention", "error");
    setBusy(false);
  });
});

refs.cancelBtn.addEventListener("click", () => {
  cancelRequested = true;
  if (ffmpeg) {
    ffmpeg.terminate();
  }
  setJob("Stopping", "Terminating FFmpeg runtime.");
  setTaskStatus("Stopping", "busy");
  setEngineReady();
});

refs.engineHelpBtn.addEventListener("click", () => {
  window.location.href = runtimeUrl("install-guide.html");
});

if (window.FFmpegWASM?.FFmpeg) {
  setEngineReady();
  setTaskStatus("No job running", "");
} else {
  setEngineSetupRequired();
  setTaskStatus("Engine issue", "error");
}

updateFileMeta(refs.compressFile, refs.compressFileMeta);
updateFileMeta(refs.convertFile, refs.convertFileMeta);
