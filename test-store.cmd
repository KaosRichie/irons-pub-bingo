@echo off
rem Runs the team store backend tests: the REAL docs/apps-script-store.gs executed
rem under Node with in-memory Google shims. No game client, no Google account.
node "%~dp0store-tests\run-tests.js"
