@echo off
title TERMINAL-092026 SERVER MANAGER
color 0A
echo ===================================================
echo   TERMINAL-092026 // RETRO GRADUATION PARTY SERVER
echo ===================================================
echo.
echo [1/2] Checking python requirements...
python -m pip install -r requirements.txt
if %ERRORLEVEL% neq 0 (
    echo [WARNING] Failed to verify/install dependencies. Proceeding to startup...
)
echo.
echo [2/2] Starting FastAPI backend...
python main.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server failed to start.
    echo Please make sure Python is installed and added to your PATH environment variables.
)
echo.
pause
