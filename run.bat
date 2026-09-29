@echo off
rem ClaudyBot - Lichess dashboard. Extra arguments are passed through (e.g. --headless).
cd /d "%~dp0"
python -m claudybot %*
