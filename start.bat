@echo off
setlocal
cd /d "%~dp0"

REM Create venv if missing
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
)

call ".venv\Scripts\activate"

REM Install/upgrade deps (use requirements.txt if you have one)
if exist requirements.txt (
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  python -m pip install --upgrade pip
  pip install flask
)

REM (Optional) If you bundled ffmpeg in a subfolder, expose it:
REM set "PATH=%~dp0ffmpeg\bin;%PATH%"

python compressor.py
pause
