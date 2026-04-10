@echo off
setlocal enabledelayedexpansion
REM Relaunch hidden so no terminal windows show
if "%~1"=="hidden" goto :hidden
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '%~f0' -ArgumentList 'hidden'"
exit /b

:hidden
if "%DEBUG%"=="1" pause
REM ============================================
REM  CrowdControl: TikTok Live Key Mapper
REM  Opens two terminal windows:
REM    • FRONTEND  (Vite)          — http://localhost:5173
REM    • BACKEND   (WebSocket API) — ws://localhost:5178
REM ============================================

echo Starting CrowdControl application...
echo Current directory: %CD%
echo Script path: %~dp0
echo.

REM Add error handling to prevent script from closing unexpectedly
set "ERROR_COUNT=0"
set "FIRST_RUN=0"

REM Test basic functionality
echo Testing basic script functionality...
echo This is a test message to verify the script is running.
echo.

REM ---- Quick dependency presence check ----
IF NOT EXIST node_modules goto :missing_deps
IF NOT EXIST frontend\node_modules goto :missing_deps
IF NOT EXIST backend\node_modules goto :missing_deps
IF NOT EXIST frontend\electron\node_modules goto :missing_deps
IF NOT EXIST backend\.env (
  echo WARNING: backend\.env is missing. Please run run_first.bat.
  goto :missing_deps
)
echo Dependencies detected. Starting services...
echo.

REM ---- Start frontend (hidden) ----
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev' -WorkingDirectory '%~dp0frontend'"
if %ERRORLEVEL% NEQ 0 (
  echo WARNING: Failed to start frontend server
  echo Continuing anyway...
  set /a ERROR_COUNT+=1
)

REM ---- Backend is started by Electron main process; do not start it here ----
if %ERRORLEVEL% NEQ 0 (
  echo WARNING: Failed to start backend server
  echo Continuing anyway...
  set /a ERROR_COUNT+=1
)

REM Skipping wait; launch Electron immediately

REM ---- Launch Electron (console hidden) ----
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c','npm start' -WorkingDirectory '%~dp0frontend\electron'"
if %ERRORLEVEL% NEQ 0 (
  echo WARNING: Failed to launch Electron app
  echo Continuing anyway...
  set /a ERROR_COUNT+=1
)

REM ---- Check if Electron launched successfully ----
echo Checking if Electron app launched...
timeout /t 2 /nobreak >nul
tasklist /FI "WINDOWTITLE eq CrowdControl*" 2>nul | find /I "electron.exe" >nul
if %ERRORLEVEL% EQU 0 (
    echo SUCCESS: Electron app launched successfully!
) else (
    echo WARNING: Electron app may not have launched properly.
    echo Check the Electron window for any error messages.
    echo The app might still be starting up...
)

REM Exit immediately; windows are hidden
goto :eof

REM ---- Missing dependency handler ----
:missing_deps
REM Show minimal message box without a console window
powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Dependencies missing. Run run_first.bat first.','CrowdControl') | Out-Null"
exit /b 1

REM ---- Helpers ----
:wait_for_port
REM Wait for a TCP port to be in LISTENING state
REM Usage: call :wait_for_port PORT MAX_WAIT_SECONDS
setlocal
set "TARGET_PORT=%~1"
set "MAX_SECS=%~2"
if "%MAX_SECS%"=="" set "MAX_SECS=15"
set /a "ELAPSED=0"
: _wait_loop
rem We search for a line that includes :PORT and LISTENING
netstat -ano | findstr /R /C:":%TARGET_PORT% .*LISTENING" >nul
if %ERRORLEVEL% EQU 0 (
  endlocal & goto :eof
)
timeout /t 1 /nobreak >nul
set /a ELAPSED+=1
if %ELAPSED% GEQ %MAX_SECS% (
  echo WARNING: Port %TARGET_PORT% did not start listening within %MAX_SECS% seconds.
  endlocal & goto :eof
)
goto :_wait_loop
