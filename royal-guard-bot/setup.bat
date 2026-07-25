@echo off
title Royal Guard Bot Setup
node --version
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22.12 or newer.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 pause & exit /b 1
if not exist .env copy .env.example .env
 echo Setup complete. Open .env, enter your credentials, then run start.bat.
pause
