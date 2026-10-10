.DEFAULT_GOAL := build

NODE ?= node
NPM ?= npm
PORT ?= 5173
PREVIEW_PORT ?= 4173
PUBLISH_SCRIPT ?= scripts/prepare-shared.mjs
DEST ?=

.PHONY: all help node-check setup build run dev test typecheck check preview prepare-shared

all: build

help:
	@printf '%s\n' \
	  'make build       Build the static PWA in dist/ (default)' \
	  'make run         Start the local development server' \
	  'make dev         Alias for make run' \
	  'make preview     Build and serve the production PWA locally' \
	  'make setup       Install missing npm dependencies (Node.js 24+)' \
	  'make test        Run automated behavior tests' \
	  'make typecheck   Check TypeScript without building assets' \
	  'make check       Run TypeScript checks and automated tests' \
	  'Publishing: run make -C webapps/everydayapps/publishing publish from the development repository root' \
	  'Supabase defaults: ../../publishing/.env.local; app settings override defaults, exported environment overrides both.'

node-check:
	@command -v "$(NODE)" >/dev/null 2>&1 || { printf '%s\n' 'Install Node.js 24 or newer; see README.md.' >&2; exit 1; }
	@"$(NODE)" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("iou requires Node.js 24 or newer; see README.md."); process.exit(1); }'
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

test: setup
	"$(NPM)" test
	"$(NODE)" --test scripts/publishing.test.mjs

typecheck: setup
	"$(NPM)" exec tsc -- -b

check: typecheck test

preview: build
	"$(NPM)" run preview -- --host 127.0.0.1 --port "$(PREVIEW_PORT)"

# Standalone preparation entry point for public source snapshots.
prepare-shared: node-check
	@test -n "$(DEST)" || { printf '%s\n' 'Set DEST to an existing shared Sites repository.' >&2; exit 1; }
	"$(NODE)" "$(PUBLISH_SCRIPT)" "$(DEST)" "$(CURDIR)"
