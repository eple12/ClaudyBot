@echo off
rem Offline demo: a fake Lichess server with simulated opponents + the dashboard connected to it.
rem Opponents use ..\claudy.exe when it exists (else they move at random); the bot uses engine.path from config.yml.
cd /d "%~dp0"
if exist ..\claudy.exe (
    start "ClaudyBot mock server" /min python -m claudybot.mockserver --engine ..\claudy.exe --every 15
) else (
    start "ClaudyBot mock server" /min python -m claudybot.mockserver --every 15
)
timeout /t 2 /nobreak >nul
python -m claudybot --url http://127.0.0.1:8765
