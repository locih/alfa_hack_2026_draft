FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv

# WITH_ML=1 добавляет LightGBM для инференса обученной PD-модели (опционально; без неё PD считается по скоркарте)
ARG WITH_ML=0
COPY requirements.txt requirements.lock requirements-ml.txt ./
RUN pip install -r requirements.txt -c requirements.lock \
 && if [ "$WITH_ML" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
      && pip install -r requirements-ml.txt; \
    fi

COPY app app
COPY ml ml
COPY config config
COPY static static
COPY models /models

RUN useradd --system --uid 10001 app && mkdir -p /data /models && chown app /data
USER app
ENV DB_PATH=/data/app.db MODEL_DIR=/models/pd_current

EXPOSE 8000
# Порт берётся из PORT (Render и другие PaaS задают его сами), по умолчанию 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD python -c "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/api/health/ready' % os.environ.get('PORT','8000')).status==200 else 1)"

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
