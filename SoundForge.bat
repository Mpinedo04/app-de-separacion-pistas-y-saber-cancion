@echo off
title SoundForge
echo.
echo  ========================================
echo    SoundForge - Herramientas de IA Audio
echo  ========================================
echo.
echo  Iniciando servidor...
echo.

cd /d "%~dp0"

python app.py

if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] No se pudo iniciar SoundForge.
    echo  Asegurate de tener Python y las dependencias instaladas.
    echo  Ejecuta: pip install -r requirements.txt
    echo.
    pause
)
