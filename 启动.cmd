@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Douyin Downloader - Server

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] First run: installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo Starting server, the browser will open automatically...
echo Close this window to stop the server.
echo.
node server.js %*
echo.
echo Server exited.
pause
