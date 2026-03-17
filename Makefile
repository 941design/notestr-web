.PHONY: build test dev relay-up relay-down clean node_modules

node_modules: package.json package-lock.json
	npm install
	@touch node_modules

build: node_modules
	npx tsc --noEmit
	npx vite build

test: node_modules
	npx vitest run

dev: node_modules
	npx vite --host 0.0.0.0

relay-up:
	docker compose up -d

relay-down:
	docker compose down

clean:
	rm -rf dist
