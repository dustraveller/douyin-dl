@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Douyin Downloader - CLI
node dl.js %*
echo.
pause
