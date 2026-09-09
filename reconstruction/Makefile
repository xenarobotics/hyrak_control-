VENV ?= .venv
PY   := $(VENV)/bin/python

.PHONY: help install test test-fast selftest bench info lint clean

help:
	@echo "make install     create the venv and install everything"
	@echo "make info        report GPU, codecs and backend availability"
	@echo "make test        full test suite (includes the slow end-to-end test)"
	@echo "make test-fast   unit tests only"
	@echo "make selftest    end-to-end run against synthetic ground truth"
	@echo "make bench       per-stage latency and VRAM benchmark"
	@echo "make clean       remove build artefacts and session output"

install:
	bash scripts/install.sh

info:
	$(PY) -m dronemap.cli info

test-fast:
	$(PY) -m pytest tests -q --ignore=tests/integration

test:
	$(PY) -m pytest tests -q

selftest:
	$(PY) -m dronemap.cli selftest --frames 150 --gt-depth --no-viz

bench:
	$(PY) scripts/bench.py

clean:
	rm -rf build dist *.egg-info .pytest_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
