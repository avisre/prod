@echo off
rem Runs the deploy checks on the Windows PC as a detached job (started by
rem scripts/predeploy-remote.sh on the Mac). Detached because the SSH link
rem can drop mid-run; the Mac polls .git\predeploy.rc and reads the log.
rem   predeploy-win.cmd run^|install A..B
cd /d "%~dp0.."
del .git\predeploy.rc 2>nul
type nul > .git\predeploy.log
if not "%1"=="install" goto checks
call npm ci --no-audit --no-fund --loglevel=error >> .git\predeploy.log 2>&1
if errorlevel 1 goto failed
call npm ci --prefix backend --no-audit --no-fund --loglevel=error >> .git\predeploy.log 2>&1
if errorlevel 1 goto failed
:checks
node scripts\predeploy.js --range %2 >> .git\predeploy.log 2>&1
if errorlevel 1 goto failed
echo 0 > .git\predeploy.rc
exit /b 0
:failed
echo 1 > .git\predeploy.rc
exit /b 1
