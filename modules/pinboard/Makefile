.DEFAULT_GOAL := build
NODE ?= node
NPM ?= npm
PORT ?= 5174
PREVIEW_PORT ?= 4174

.PHONY: help node-check setup build run dev preview test test-postgres typecheck check

help:
	@printf '%s\n' \
	  'Browser only: Make, Node.js 24+ and npm; online Supabase required for shared boards.' \
	  'make setup      Install or refresh missing npm dependencies' \
	  'make build      Build static files into dist/ (default; no publishing)' \
	  'make run        Start the loopback development server (PORT=5174)' \
	  'make dev        Alias for run' \
	  'make preview    Build and serve dist/ on loopback (PREVIEW_PORT=4174)' \
	  'make test       Run UI/client/config behavior and embedded Postgres tests' \
	  'make test-postgres  Optional concurrency checks; requires running Docker and a local PostgreSQL 17 image' \
	  '                   POSTGRES_IMAGE environment override; default postgres:17-alpine, no image download' \
	  'make typecheck  Check TypeScript' \
	  'make check      Run all applicable checks' \
	  'Supabase defaults: ../../publishing/.env.local; app settings override defaults, exported environment overrides both.'

node-check:
	@command -v "$(NODE)" >/dev/null 2>&1 || { printf '%s\n' 'Install Node.js 24 or newer; see README.md.' >&2; exit 1; }
	@"$(NODE)" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Pinboard requires Node.js 24 or newer; see README.md."); process.exit(1); }'
	@command -v "$(NPM)" >/dev/null 2>&1 || { printf '%s\n' 'Install npm with Node.js; see README.md.' >&2; exit 1; }

setup: node-check
	@if [ ! -f node_modules/.package-lock.json ] || \
	    [ package.json -nt node_modules/.package-lock.json ] || \
	    [ package-lock.json -nt node_modules/.package-lock.json ] || \
	    [ ! -x node_modules/.bin/tsc ] || \
	    [ ! -x node_modules/.bin/vite ] || \
	    [ ! -x node_modules/.bin/vitest ]; then \
	  "$(NPM)" ci --include=dev; \
	fi

build: setup
	"$(NPM)" run build

run: setup
	"$(NPM)" run dev -- --host 127.0.0.1 --port "$(PORT)"

dev: run

preview: build
	"$(NPM)" run preview -- --host 127.0.0.1 --port "$(PREVIEW_PORT)"

test: setup
	"$(NPM)" test

test-postgres: setup
	"$(NODE)" supabase/postgres-check.mjs

typecheck: setup
	"$(NPM)" exec tsc -- -b

check: typecheck test

.PHONY: prepare-shared
prepare-shared: node-check
	"$(NODE)" scripts/prepare-shared.mjs "$(SITE_CHECKOUT)"
