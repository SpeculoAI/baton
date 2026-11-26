@echo off
if not defined BATON_TEST_NODE set "BATON_TEST_NODE=node"
"%BATON_TEST_NODE%" "%~dp0fake-rulesync.mjs" %*
exit /b %ERRORLEVEL%
