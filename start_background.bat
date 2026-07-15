@echo off
start "mkcrm" cmd /k "cd /d %~dp0 && npm start"
echo MKCRM started in a new window.
