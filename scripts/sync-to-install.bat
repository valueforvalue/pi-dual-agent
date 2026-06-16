@echo off
REM ============================================================
REM sync-to-install.bat
REM
REM Windows equivalent of sync-to-install.sh. Pulls the latest
REM committed state from this dev repo into the live pi install
REM location. See sync-to-install.sh for the full rationale.
REM
REM Usage:
REM   scripts\sync-to-install.bat
REM
REM Override the install path with PI_INSTALL_DIR if your install
REM is not at the default location:
REM   set PI_INSTALL_DIR=C:\path\to\install
REM   scripts\sync-to-install.bat
REM ============================================================

setlocal EnableExtensions EnableDelayedExpansion

REM Resolve dev repo root from the script's own location so cwd
REM doesn't matter.
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.." >nul
set "DEV_DIR=%CD%"
popd >nul

REM Default install location. Override with PI_INSTALL_DIR.
if "%PI_INSTALL_DIR%"=="" (
    set "INSTALL_DIR=%USERPROFILE%\.pi\agent\extensions\pi-dual-agent"
) else (
    set "INSTALL_DIR=%PI_INSTALL_DIR%"
)

echo.
echo === pi-dual-agent sync ===
echo Dev:    %DEV_DIR%
echo Install: %INSTALL_DIR%
echo.

REM --- Step 1: dev repo must be clean ---
pushd "%DEV_DIR%" >nul
git diff --quiet HEAD
if errorlevel 1 (
    echo [ERROR] Dev repo has uncommitted changes. Commit them first:
    echo         cd /d "%DEV_DIR%"
    echo         git add -A ^&^& git commit -m "..."
    echo         Then re-run this script.
    popd >nul
    exit /b 1
)
git diff --cached --quiet HEAD
if errorlevel 1 (
    echo [ERROR] Dev repo has staged-but-uncommitted changes. Commit them first.
    popd >nul
    exit /b 1
)
popd >nul

REM --- Step 2: dev repo should be in sync with origin/master ---
REM Allow this to fail (no network, no creds) with a warning so
REM the script still works offline as long as dev's HEAD is what
REM the install needs.
pushd "%DEV_DIR%" >nul
git remote get-url origin >nul 2>&1
if not errorlevel 1 (
    git fetch origin master >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%A in ('git rev-parse HEAD') do set "DEV_HEAD=%%A"
        for /f "delims=" %%A in ('git rev-parse origin/master') do set "REMOTE_HEAD=%%A"
        if not "!DEV_HEAD!"=="!REMOTE_HEAD!" (
            git push origin master >nul 2>&1
            if not errorlevel 1 (
                echo Pushed dev -^> origin/master
            ) else (
                echo [WARNING] Could not push to origin. Install will pull once origin is updated.
            )
        )
    ) else (
        echo [WARNING] Could not fetch origin. Proceeding with local dev HEAD.
    )
) else (
    echo [WARNING] No 'origin' remote configured. Skipping push check.
)
popd >nul

REM --- Step 3: install dir must exist and be a git repo ---
if not exist "%INSTALL_DIR%" (
    echo [ERROR] Install directory does not exist: %INSTALL_DIR%
    echo         Create it ^(e.g. by running 'pi install .' in the dev repo^)
    echo         or set PI_INSTALL_DIR to the correct path.
    exit /b 1
)

pushd "%INSTALL_DIR%" >nul
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Install directory is not a git repo: %INSTALL_DIR%
    echo         If you copied files manually ^(not via git^), initialise
    echo         a repo there or re-install via 'pi install .'.
    popd >nul
    exit /b 1
)

REM Refuse if install has uncommitted changes.
git diff --quiet HEAD
if errorlevel 1 (
    echo [ERROR] Install repo has uncommitted changes:
    echo         cd /d "%INSTALL_DIR%"
    echo         git status   # see what's there
    echo         git stash    # save them
    echo         # or: git checkout -- .   # discard them ^(CAREFUL^)
    echo         Then re-run this script.
    popd >nul
    exit /b 1
)
git diff --cached --quiet HEAD
if errorlevel 1 (
    echo [ERROR] Install repo has staged-but-uncommitted changes. Commit or unstage them.
    popd >nul
    exit /b 1
)

REM --- Step 4: fast-forward pull ---
git pull --ff-only origin master
if errorlevel 1 (
    echo.
    echo [ERROR] Install repo has diverged from origin/master. Resolve manually:
    echo         cd /d "%INSTALL_DIR%"
    echo         git status
    echo         # either: rebase onto origin/master ^^(preserves your commits
    echo         #         on top of the new history^), or
    echo         #       reset --hard origin/master ^^(discards local commits^).
    echo         Then re-run this script.
    popd >nul
    exit /b 1
)

for /f "delims=" %%A in ('git rev-parse --short HEAD') do set "SHORT_HEAD=%%A"
echo.
echo Synced. Install at %INSTALL_DIR% is now at !SHORT_HEAD!.
popd >nul
endlocal
