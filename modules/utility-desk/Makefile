.DEFAULT_GOAL := build

NPM ?= npm
NODE ?= node
PORT ?= 5173
PREVIEW_PORT ?= 4173
PUBLISH_SCRIPT ?= scripts/prepare-shared.mjs
DEST ?=

.PHONY: all help runtime setup build run dev preview typecheck lint test test-js check prepare-shared

all: build

help:
	@printf '%s\n' \
	  'make build           Build the static app in dist/ (default)' \
	  'make run             Start the local development server' \
	  'make dev             Alias for make run' \
	  'make preview         Build and serve the production app' \
	  'make setup           Install missing npm dependencies (Node.js 24+)' \
	  'make check           Run TypeScript checks, lint, and tests' \
	  'make typecheck       Check TypeScript without building assets' \
	  'make lint            Run lint only' \
	  'make test            Run tests only' \
	  'Publishing: run make -C webapps/everydayapps/publishing publish from the development repository root'

runtime:
	@$(NODE) -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Utility Desk Lite requires Node.js 24 or newer; see README.md."); process.exit(1); }'

setup: runtime
	@if [ ! -f node_modules/.package-lock.json ] || \
	    [ ! -x node_modules/.bin/vite ] || \
	    [ ! -x node_modules/.bin/tsc ] || \
	    [ ! -x node_modules/.bin/eslint ] || \
	    [ ! -x node_modules/.bin/vitest ] || \
	    [ package.json -nt node_modules/.package-lock.json ] || \
	    [ package-lock.json -nt node_modules/.package-lock.json ]; then \
	  $(NPM) ci --include=dev; \
	fi

build: setup
	$(NPM) run build

run: setup
	$(NPM) run dev -- --host 127.0.0.1 --port $(PORT)

dev: run

preview: build
	$(NPM) run preview -- --host 127.0.0.1 --port $(PREVIEW_PORT)

typecheck: setup
	$(NPM) exec tsc -- --noEmit

lint: setup
	$(NPM) run lint

test: setup
	$(NPM) test

test-js: test

check: typecheck lint test

# Compatibility entry point for prepared public source snapshots.
prepare-shared: setup
	@test -n "$(DEST)" || { printf '%s\n' 'Set DEST to an existing shared Sites repository.' >&2; exit 1; }
	$(NODE) "$(PUBLISH_SCRIPT)" "$(DEST)" "$(CURDIR)"
