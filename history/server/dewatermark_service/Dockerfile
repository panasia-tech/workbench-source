# 京东云去水印补图服务。构建上下文 = server/:
#   docker build -f dewatermark_service/Dockerfile -t erp-dewatermark:<tag> .
# 京东云拉不动 Docker Hub,基础镜像走 DaoCloud;pip 走阿里云源。模型不进镜像,挂到 /models。
FROM docker.m.daocloud.io/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    DEWATERMARK_MODEL_PATH=/models/lama_fp32.onnx

WORKDIR /app
COPY dewatermark_service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -c "import cv2, numpy, onnxruntime"
COPY app/services/dewatermark.py ./dewatermark.py
COPY dewatermark_service/main.py ./main.py

RUN useradd --system --uid 10091 --home /app dewm
USER dewm

EXPOSE 8091
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8091"]
