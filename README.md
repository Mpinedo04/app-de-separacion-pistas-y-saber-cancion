# SoundForge: Separador de pistas e identificador de canciones

SoundForge es una aplicación web local que utiliza modelos de Inteligencia Artificial (UVR/Roformer) para separar las pistas de voz e instrumental de un archivo multimedia, además de contar con reconocimiento musical impulsado por Shazam.

## Requisitos previos

1. **Python 3.10+**: Asegúrate de tener Python instalado.
2. **FFmpeg**: Se detecta automáticamente si está en el `PATH` del sistema. Si está instalado en una ruta personalizada, puedes definir la variable de entorno `FFMPEG_PATH` apuntando a la carpeta de sus binarios.

## Instalación

Abre una terminal y ejecuta el siguiente comando para instalar las dependencias necesarias:

```bash
pip install -r requirements.txt
```

> **Aceleración por GPU (Opcional, muy recomendable):**
> Con una tarjeta NVIDIA la separación va unas 4–5 veces más rápida (p. ej. una canción de 8 min: ~33 min en CPU frente a ~7 min en una GTX 1650).
> En Windows, `pip install torch` instala por defecto la versión **solo CPU**, así que hay que instalar la versión con CUDA a mano. Ajusta las versiones a las de tu `torch` actual (las disponibles están en https://download.pytorch.org/whl/torch/):
> ```bash
> pip install "torch==2.13.0+cu126" "torchvision==0.28.0+cu126" --index-url https://download.pytorch.org/whl/cu126
> ```
> Compruébalo con `python -c "import torch; print(torch.cuda.is_available())"`, que debe decir `True`. Mientras separa, la página indica si está usando la GPU o la CPU.
> No uses `--use_autocast`: en las GTX 16xx la media precisión es unas 3 veces **más lenta**.

## Uso

Para ejecutar la aplicación localmente:

```bash
python app.py
```

La aplicación se abrirá automáticamente en tu navegador web predeterminado en `http://127.0.0.1:5000`.

## Funcionalidades

- **Separar Pistas**: Sube un archivo de video o audio. La aplicación lo procesará y te devolverá dos pistas separadas (instrumental y voces) en formato FLAC de alta calidad.
- **Identificar Canción**: Sube un archivo y la aplicación usará la base de datos de Shazam para decirte qué canción está sonando.
- **Streaming en tiempo real**: Reproduce las pistas directamente desde el navegador con soporte para desplazamiento de tiempo (*seeking*).
- **Progreso real**: La barra muestra el avance y el tiempo restante estimado de la separación.
- **No se pierden resultados**: Si recargas la página (o reinicias SoundForge) mientras separas, la página retoma la última separación y muestra el resultado al terminar. Las pistas se descargan con el nombre de la canción original, p. ej. `Mi canción (Voz).flac`.

## Archivos y limpieza

Los archivos subidos se guardan en `uploads/` y las pistas separadas en `output/`. Los archivos de más de 24 horas se borran automáticamente al arrancar y al subir un archivo nuevo.

Si se lanzan varias separaciones a la vez, se procesan de una en una (la segunda queda "en cola") para no agotar la memoria.
