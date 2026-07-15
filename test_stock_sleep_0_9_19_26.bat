@echo off
set BASE=http://127.0.0.1:1385
curl.exe -c cookies.txt -X POST %BASE%/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin\"}"
echo.
echo INIT:
curl.exe -b cookies.txt -X POST %BASE%/api/stock-sleep/init
echo.
echo START SMALL SNAPSHOT:
curl.exe -b cookies.txt -X POST %BASE%/api/stock-sleep/start -H "Content-Type: application/json" -d "{\"fiscalYearStart\":\"14050101\",\"maxItems\":10,\"kardexMaxRows\":50,\"kickoffLimit\":2}"
echo.
echo STATUS:
curl.exe -b cookies.txt %BASE%/api/stock-sleep/status
echo.
echo PROCESS 3:
curl.exe -b cookies.txt -X POST %BASE%/api/stock-sleep/process -H "Content-Type: application/json" -d "{\"limit\":3}"
echo.
echo SUPPLIERS:
curl.exe -b cookies.txt %BASE%/api/stock-sleep/suppliers?limit=20
echo.
pause
