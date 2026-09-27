@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==============================================
echo   SpectorClient - Push + Release to GitHub
echo ==============================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push-and-release.ps1"
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo Push/release did not complete. See the error above.
) else (
  echo Finished successfully.
)
echo.
pause
exit /b %EXITCODE%
