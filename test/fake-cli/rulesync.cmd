@echo off
if defined BATON_TEST_NODE ("%BATON_TEST_NODE%" "%~dp0fake-rulesync.mjs" %*) else (node "%~dp0fake-rulesync.mjs" %*)
exit /b %ERRORLEVEL%
