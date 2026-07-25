@echo off
title Royal Guard Bot
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
if not exist .env (
  echo ERROR: Copy .env.example to .env and fill in your credentials first.
  pause
  exit /b 1
)
node index.js
pause
