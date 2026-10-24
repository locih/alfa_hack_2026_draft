# Окружение для обучения/проверки ML-слоя (Linux, libgomp для LightGBM).
#   docker build -f ml/Dockerfile -t credit-ml .
#   docker run --rm -v "$PWD":/work -w /work credit-ml python -m ml.synth --n 30000 --out data/smoke.csv
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY requirements.txt requirements-ml.txt requirements-dev.txt ./
RUN pip install -r requirements-ml.txt -r requirements-dev.txt
