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

> **Aceleración por GPU (Opcional):**
> Si cuentas con una tarjeta gráfica NVIDIA y soporte CUDA, puedes obtener un rendimiento significativamente mayor instalando:
> ```bash
> pip install audio-separator[gpu]
> ```

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
