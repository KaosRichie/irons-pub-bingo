@echo off
rem Launches RuneLite in developer mode with the Irons Pub Bingo plugin loaded.
rem System default Java is too new for Gradle, so point at JDK 17 for the wrapper.
set "JAVA_HOME=C:\Program Files\Java\jdk-17.0.1"
cd /d "%~dp0"
call "%~dp0gradlew.bat" run
