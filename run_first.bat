@echo off
setlocal enabledelayedexpansion

REM ============================================
REM  CrowdControl First-Time Setup (run_first.bat)
REM  - Verifies Node/npm
REM  - Installs deps in root, frontend, backend, electron
REM  - Creates backend\.env if missing
REM ============================================

cd /d "%~dp0"
echo CrowdControl first-time setup starting...
echo Working directory: %CD%
echo.

set "ERROR_COUNT=0"

REM ---- Check Node.js and npm ----
echo Checking for Node.js...
where node >nul 2>nul
if not %ERRORLEVEL%==0 (
  echo ERROR: Node.js is not in PATH. Install Node.js 18+ from https://nodejs.org
  set /a ERROR_COUNT+=1
  goto :done
)
echo Checking for npm...
where npm >nul 2>nul
if not %ERRORLEVEL%==0 (
  echo ERROR: npm is not in PATH. Reinstall Node.js and re-run this script.
  set /a ERROR_COUNT+=1
  goto :done
)
echo Node.js and npm detected.
echo.

REM ---- Install dependencies in each folder ----
call :install_deps "%CD%" root
call :install_deps "%CD%\frontend" frontend
call :install_deps "%CD%\backend" backend
call :install_deps "%CD%\frontend\electron" electron
echo.

REM ---- Ensure backend.env exists ----
if not exist backend\.env (
  echo Creating backend\.env with defaults...
  (
    echo TIKTOK_USERNAME=
    echo WS_PORT=5178
    echo TARGET_WINDOW_KEYWORD=rocket league
    echo INJECTION_MODE=autohotkey
    echo AHK_PATH="C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe"
  ) > backend\.env
  if not %ERRORLEVEL%==0 (
    echo WARNING: Failed to create backend\.env
    set /a ERROR_COUNT+=1
  ) else (
    echo backend\.env created.
  )
) else (
  echo backend\.env already exists.
)
echo.

:done
if %ERROR_COUNT% GTR 0 (
  echo Setup finished with %ERROR_COUNT% warning(s)/error(s).
) else (
  echo Setup completed successfully.
)
echo.
echo Press any key to close this window...
pause >nul
exit /b

REM --------------------------------------------
REM Helpers
REM --------------------------------------------
:install_deps
REM %1 = absolute path, %2 = label
set "TARGET_DIR=%~1"
set "LABEL=%~2"
if not exist "%TARGET_DIR%" (
  echo %LABEL%: folder not found at "%TARGET_DIR%". Skipping.
  goto :eof
)
if not exist "%TARGET_DIR%\package.json" (
  echo %LABEL%: package.json not found. Skipping.
  goto :eof
)
echo Installing %LABEL% dependencies in "%TARGET_DIR%" ...
pushd "%TARGET_DIR%" >nul
if exist node_modules (
  echo %LABEL%: node_modules already exists. Skipping install.
) else (
  if exist package-lock.json (
    echo %LABEL%: running npm ci ...
    call npm ci --silent
  ) else (
    echo %LABEL%: running npm install ...
    call npm install --silent
  )
  if not %ERRORLEVEL%==0 (
    echo WARNING: %LABEL% dependency install failed.
    set /a ERROR_COUNT+=1
  ) else (
    echo %LABEL%: dependencies installed.
  )
)
popd >nul
echo.
goto :eof
