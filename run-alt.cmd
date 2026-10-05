@echo off
rem Launches a SECOND RuneLite dev client with its own private .runelite home (alt-home\.runelite),
rem so a second Jagex account can run alongside the run.cmd client for bingo team testing.
rem
rem First time: put the alt account's credentials.properties in alt-home\.runelite\ (see "Developing" in docs\full-readme.md).
rem The jar is copied before launching: rebuilding irons-pub-bingo-all.jar while this client runs
rem would otherwise break its lazy class loading and crash it (NoClassDefFoundError).
rem It builds the jar first, so it always runs the current code.
set "JAVA_HOME=C:\Program Files\Java\jdk-17.0.1"
cd /d "%~dp0"
call "%~dp0gradlew.bat" shadowJar -q || exit /b 1
if not exist "alt-home\.runelite" mkdir "alt-home\.runelite"
copy /y "build\libs\irons-pub-bingo-all.jar" "alt-home\irons-pub-bingo-running.jar" >nul
"%JAVA_HOME%\bin\java.exe" -ea "-Duser.home=%~dp0alt-home" -jar "alt-home\irons-pub-bingo-running.jar" --developer-mode