# memoryd in a container.
#
# The service is pure Python stdlib, so the image is just "Python + one file".
# The base is pulled from ghcr because some networks cannot reach Docker Hub.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app
COPY memoryd.py /app/memoryd.py

# Overridden per-deployment; these are the container defaults.
# MEMORYD_CONFIG points at the mounted (read-only) config, so the token is never
# baked into the image.
ENV PYTHONUNBUFFERED=1 \
    MEMORYD_CONFIG=/config/config.json \
    MEMORYD_HOST=0.0.0.0 \
    MEMORYD_DB=/data/memory.db

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8788/health',timeout=2).status==200 else 1)"

ENTRYPOINT ["python3", "/app/memoryd.py"]
