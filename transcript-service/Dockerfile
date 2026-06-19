# MeetScribe transcript-service — CPU image (Faster-Whisper / CTranslate2)
FROM python:3.11-slim

# ffmpeg lets faster-whisper decode common audio formats (wav/mp3/m4a/flac/ogg).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Defaults (override via docker-compose / `docker run -e`).
ENV MODEL_PATH=/app/models/biodatlab-th-small-ct2 \
    DEVICE=cpu \
    COMPUTE_TYPE=int8 \
    PORT=9099

EXPOSE 9099

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9099"]
