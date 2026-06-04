@echo off
REM Run the AegisTrack system: backend, frontend, and optional Java dashboard.

REM Change to repository root (same folder as this batch file).
cd /d "%~dp0"
setlocal enabledelayedexpansion

REM --- Parse args or show menu ---
if "%~1"=="" goto :menu
set "action=%~1"
goto :dispatch

:menu
echo.
echo ================= AegisTrack RUN SYSTEM MENU =================
echo 1) Start system (backend, frontend, dashboard)
echo 2) Terminate system processes
echo 0) Exit
echo ==================================================
choice /C 120 /N /M "Enter choice: 1=start, 2=terminate, 0=exit"
if errorlevel 3 set "action=exit" & goto :dispatch
if errorlevel 2 set "action=terminate" & goto :dispatch
if errorlevel 1 set "action=start" & goto :dispatch
goto :eof

:dispatch
if /i "%action%"=="start" goto :do_start
if /i "%action%"=="terminate" goto :do_terminate
if /i "%action%"=="exit" goto :eof
echo Unknown action: %action%
goto :eof

:: -------------------- START --------------------
:do_start
REM Ensure backend environment is present.
if not exist backend\.env (
    if exist backend\.env.example (
        echo Creating backend\.env from .env.example
        copy backend\.env.example backend\.env > nul
        echo Please edit backend\.env and set MONGODB_URI and JWT_SECRET_KEY before running.
    ) else (
        echo ERROR: backend\.env.example not found. Please create backend\.env manually.
        pause
        exit /b 1
    )
)

REM Initialize defaults before reading .env
set "SYSTEM_IPV4="
set "PORT="
for /f "usebackq tokens=1* delims==" %%A in ("backend\.env") do (
    set "key=%%A"
    set "value=%%B"
    if /i "!key!"=="SYSTEM_IPV4" set "SYSTEM_IPV4=!value!"
    if /i "!key!"=="PORT" set "PORT=!value!"
)

REM Fallback defaults if not found in .env
if "%SYSTEM_IPV4%"=="" set "SYSTEM_IPV4=localhost"
if "%PORT%"=="" set "PORT=8000"

REM Start backend server in a new command window.
start "AegisTrack Backend" cmd /k "cd /d "%~dp0backend" && python app.py"

echo Waiting 10 seconds for backend initialization...
timeout /t 10 /nobreak > nul

REM Start frontend static server in a new command window.
start "Frontend Server" cmd /k "cd /d "%~dp0frontend" && python serve.py %PORT%"

echo Waiting 10 seconds for frontend initialization...
timeout /t 10 /nobreak > nul

REM Open browser to the new operator portal.
start "" "http://%SYSTEM_IPV4%:%PORT%/pages/tracking-request.html"

echo Waiting 10 seconds before launching Java Dashboard...
timeout /t 10 /nobreak > nul

REM Launch Java dashboard automatically.
start "AegisTrack Dashboard" cmd /k "cd /d "%~dp0java-dashboard" && mvn clean compile && mvn javafx:run"

echo.
echo =======================================================
echo  AegisTrack SYSTEM STARTED SUCCESSFULLY
echo =======================================================
echo  FRONTEND ACCESS: http://%SYSTEM_IPV4%:%PORT%/pages/tracking-request.html
echo.
echo  Note: Ensure your phone is on the same hotspot network if you want remote access.
echo =======================================================
echo.
echo Backend, frontend, and dashboard launch commands have been issued.
goto :eof

:: -------------------- TERMINATE --------------------
:do_terminate
echo Terminating backend, frontend, and dashboard processes...

REM Kill Python backend processes where command line contains app.py
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'app.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" > nul 2>&1

REM Kill Python http.server instances
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'http.server' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" > nul 2>&1

REM Kill Maven/Java dashboard processes (mvn or javafx)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'mvn' -or $_.CommandLine -match 'javafx') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" > nul 2>&1

REM Additionally, attempt to close windows by title if present
taskkill /FI "WINDOWTITLE eq AegisTrack Backend" /T /F > nul 2>&1
taskkill /FI "WINDOWTITLE eq Frontend Server" /T /F > nul 2>&1
taskkill /FI "WINDOWTITLE eq AegisTrack Dashboard" /T /F > nul 2>&1

echo Termination commands issued.
goto :eof