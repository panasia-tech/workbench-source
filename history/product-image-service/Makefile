.PHONY: install run test lint smoke docker-up

install:
	python3.12 -m venv .venv
	. .venv/bin/activate && pip install -U pip && pip install -e '.[dev]'

run:
	. .venv/bin/activate && uvicorn app.main:app --host $${HOST:-127.0.0.1} --port $${PORT:-8090}

test:
	. .venv/bin/activate && pytest -q

lint:
	. .venv/bin/activate && ruff check app tests scripts

smoke:
	. .venv/bin/activate && python scripts/smoke_test.py

docker-up:
	docker compose up -d --build
