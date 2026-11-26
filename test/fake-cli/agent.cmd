@echo off
if defined BATON_TEST_NODE ("%BATON_TEST_NODE%" "%~dp0fake.mjs" %*) else (node "%~dp0fake.mjs" %*)
exit /b %ERRORLEVEL%
