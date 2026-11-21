# Image for the run_code tool. Containers are started with --rm, --cap-drop ALL,
# no-new-privileges, CPU/memory/pid limits and only the per-chat work dir mounted.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl ffmpeg fonts-noto-cjk git jq nodejs npm unzip xz-utils zip \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      beautifulsoup4 lxml matplotlib numpy openpyxl pandas pillow python-docx \
      qrcode requests scipy seaborn sympy tabulate

# CJK labels in matplotlib out of the box.
RUN mkdir -p /etc/matplotlib && printf 'font.family: sans-serif\nfont.sans-serif: Noto Sans CJK JP, DejaVu Sans\naxes.unicode_minus: False\nbackend: Agg\n' > /etc/matplotlib/matplotlibrc
ENV MATPLOTLIBRC=/etc/matplotlib/matplotlibrc \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp

WORKDIR /work
