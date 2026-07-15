@echo off
npm install --no-audit --no-fund
if errorlevel 1 exit /b %errorlevel%
echo MKCRM installed.
echo Next: smoke_test.bat
