@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Install the LTS version from https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

node scripts\launch.mjs

if errorlevel 1 (
  echo.
  pause
)
