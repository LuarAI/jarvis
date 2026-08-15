@echo off
setlocal
rem -- Jarvis browser bridge: register the native messaging host for Chrome/Edge --
rem Run this ONCE after loading the extension unpacked (you need its ID).
rem Usage:  install.cmd <extension-id>
rem The ID is shown on chrome://extensions with Developer mode on.

if "%~1"=="" (
  echo.
  echo   Usage: install.cmd ^<extension-id^>
  echo.
  echo   1. Open chrome://extensions, turn on Developer mode
  echo   2. "Load unpacked" -^> pick the  extension  folder next to this one
  echo   3. Copy the ID it shows and run:  install.cmd abcdefghijklmnopabcdefghijklmnop
  echo.
  exit /b 1
)
rem Run from cmd.exe. In PowerShell use:  cmd /c install.cmd ^<extension-id^>

set "HOSTDIR=%~dp0"
set "MANIFEST=%HOSTDIR%com.jarvis.host.json"

rem Write the host manifest with the caller's extension id. "path" may be relative
rem to this manifest on Windows.
> "%MANIFEST%" (
  echo {
  echo   "name": "com.jarvis.host",
  echo   "description": "Jarvis browser bridge",
  echo   "path": "jarvis_host.bat",
  echo   "type": "stdio",
  echo   "allowed_origins": [ "chrome-extension://%~1/" ]
  echo }
)

rem HKCU needs no admin rights. Edge falls back to Chrome's key, so one entry
rem usually serves both; we register Edge's too for good measure.
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.jarvis.host" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.jarvis.host" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo.
echo   Registered com.jarvis.host
echo     manifest : %MANIFEST%
echo     extension: %~1
echo.
echo   Now: restart Chrome, make sure Jarvis is running, open a job page and press
echo   Alt+Shift+J to arm that tab. Then ask Jarvis to read the page.
echo.
endlocal
