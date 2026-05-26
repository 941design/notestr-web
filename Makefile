# Load environment variables from .env if it exists (for FTP credentials)
-include .env
export

.PHONY: help build test test-property dev relay-up relay-down clean deploy deploy-check deploy-dryrun e2e-up e2e-down e2e-install e2e ssl-cert mutation-fast mutation-cohesive mutation-deep mutation-baseline ensure-platform

# Default target
.DEFAULT_GOAL := help

# FTP Deployment Configuration
FTP_HOST := $(HOSTEUROPE_FTP_HOST)
FTP_USER := $(HOSTEUROPE_FTP_USER)
FTP_PASS := $(HOSTEUROPE_FTP_PASS)
FTP_PATH := $(or $(HOSTEUROPE_FTP_PATH),/)

# Local paths
LOCAL_DIST := out

help: ## Show this help message
	@echo "notestr — Encrypted Task Manager on Nostr"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

# Re-install when the platform changes (native bindings like rolldown and
# @next/swc are platform-specific). Unlike other targets, this rule has no
# build step — it MUST be listed AFTER every target that depends on it, or
# make will optimistically believe the already-built node_modules is fresh
# (and never re-run the rule when the stamp is stale).
PLATFORM_STAMP := node_modules/.platform
CURRENT_PLATFORM := $(shell uname -sm)

node_modules: package.json package-lock.json
	@# marmot-ts is a git dep; its prepare script calls pnpm, which fails because
	@# pnpm can't find the monorepo root. Workaround: build dist locally, then
	@# switch marmot-ts to a file: dep so npm skips the git prepare step entirely.
	@# IMPORTANT: must clone the branch/commit that package.json pins to.
	@if [ ! -d /tmp/marmot-ts/dist ]; then \
		rm -rf /tmp/marmot-ts; \
		git clone --depth 1 --branch addressable-key-packages \
			https://github.com/941design/marmot-ts.git /tmp/marmot-ts 2>/dev/null || true; \
		cd /tmp/marmot-ts && pnpm install --ignore-scripts 2>/dev/null && pnpm run build 2>/dev/null; \
	fi
	@node -e " \
		const fs=require('fs'); \
		const p=JSON.parse(fs.readFileSync('package.json','utf8')); \
		p.dependencies['@internet-privacy/marmot-ts']='file:/tmp/marmot-ts/dist'; \
		fs.writeFileSync('package.json',JSON.stringify(p,null,2)); \
	"
	@npm install --ignore-scripts
	@# ts-mls is a transitive dep of marmot-ts but hoisted incorrectly by npm;
	@# install it directly so Next.js can resolve it during the build step.
	@# applesauce-core/accounts are also transitive deps needed by marmot-ts.
	@npm install ts-mls@2.0.0-rc.10 applesauce-core applesauce-accounts --ignore-scripts 2>/dev/null || true
	@echo "$(CURRENT_PLATFORM)" > $(PLATFORM_STAMP)
	@touch node_modules

# Ensure correct platform before running any build step. The phony declaration
# forces make to always run the rule, which propagates into global-setup.ts
# (which calls `npx next build` directly — outside make — for e2e).
# All targets that invoke a build or test step must depend on this.
.PHONY: ensure-platform
ensure-platform:
	@if [ "$(CURRENT_PLATFORM)" != "$$(cat $(PLATFORM_STAMP) 2>/dev/null)" ]; then \
		echo "[make] Platform mismatch: $(CURRENT_PLATFORM) vs $$(cat $(PLATFORM_STAMP) 2>/dev/null || echo unknown). Reinstalling node_modules..."; \
		rm -rf node_modules; \
		$(MAKE) node_modules; \
	fi

build: ensure-platform ## Build for production
	npm run build
	@echo "Static files available in $(LOCAL_DIST)/"

test: ensure-platform ## Run unit and export verification tests
	npm test

test-property: ensure-platform ## Run property-based tests with high numRuns (FAST_CHECK_NUM_RUNS=10000)
	FAST_CHECK_NUM_RUNS=10000 npx vitest run --passWithNoTests src/store/task-reducer.property.test.ts src/store/multi-client.property.test.ts

# =============================================================================
# Mutation testing (Stryker + Vitest runner)
# =============================================================================
# Audits whether unit tests actually assert against behavior or merely
# touch the code. Reports land under reports/mutation/<profile>/.
#
# Profiles:
#   fast       — pure config/lib helpers; setup-validation + quick re-runs
#   cohesive   — store + reducer + helpers; module-by-module dives
#   deep       — Marmot/MLS lifecycle; the heavy protocol-layer audit
#   baseline   — every tested non-React TS module; one-shot project baseline

mutation-fast: ensure-platform ## Mutation pass on config/lib helpers (~15s on dev hardware)
	@npm run mutation:fast

mutation-cohesive: ensure-platform ## Mutation pass on store + reducer + helpers (~1 min)
	@npm run mutation:cohesive

mutation-deep: ensure-platform ## Mutation pass on Marmot/MLS modules (~2 min)
	@npm run mutation:deep

mutation-baseline: ensure-platform ## Mutation pass on every tested non-React TS module (~2 min)
	@npm run mutation:baseline

dev: ensure-platform relay-up clean ## Start development server
	@npx next dev --port 3000 --hostname 0.0.0.0

relay-up: ## Start local strfry relay (Docker)
	docker compose up -d

relay-down: ## Stop local strfry relay
	docker compose down

e2e-up: ## Start ephemeral E2E relay (Docker)
	docker compose -f docker-compose.e2e.yml up -d

e2e-down: ## Stop ephemeral E2E relay and wipe state
	docker compose -f docker-compose.e2e.yml down -v

e2e-install: ensure-platform ## Install Playwright and browser binaries
	@npm install
	@npx playwright install --with-deps chromium webkit

e2e: ensure-platform ## Run end-to-end tests (always restarts the ephemeral test relay; leaves any other strfry on :7777 untouched)
	@if docker ps --format '{{.Names}}' | grep -q '^notestr-web-relay-1$$'; then \
		echo "[e2e] Restarting ephemeral test relay (tmpfs wipes its DB)."; \
		docker restart notestr-web-relay-1 > /dev/null; \
		sleep 2; \
	elif [ -n "$$(lsof -ti:7777 2>/dev/null)" ]; then \
		echo "[e2e] Port 7777 held by something other than the ephemeral test relay; reusing as-is."; \
	else \
		$(MAKE) e2e-up; \
	fi
	npx playwright test

clean: ## Remove build artifacts
	rm -rf out .next
	rm -f public/sw.js public/workbox-*.js

# =============================================================================
# Production Deployment (FTP to hosteurope)
# =============================================================================

deploy-check: ## Verify deployment prerequisites
	@echo "Checking deployment prerequisites..."
	@if [ -z "$(FTP_HOST)" ]; then echo "ERROR: HOSTEUROPE_FTP_HOST not set"; exit 1; fi
	@if [ -z "$(FTP_USER)" ]; then echo "ERROR: HOSTEUROPE_FTP_USER not set"; exit 1; fi
	@if [ -z "$(FTP_PASS)" ]; then echo "ERROR: HOSTEUROPE_FTP_PASS not set"; exit 1; fi
	@if [ ! -d $(LOCAL_DIST) ]; then echo "ERROR: Build output not found at $(LOCAL_DIST)/"; echo "Run 'make build' first"; exit 1; fi
	@if [ ! -f $(LOCAL_DIST)/index.html ]; then echo "ERROR: index.html not found in $(LOCAL_DIST)/"; exit 1; fi
	@if ! command -v lftp >/dev/null 2>&1; then echo "ERROR: lftp not installed. Run: brew install lftp"; exit 1; fi
	@echo "All prerequisites satisfied."

deploy: build deploy-check ## Deploy to production (FTP)
	@echo "Deploying to $(FTP_HOST)$(FTP_PATH)..."
	@lftp -u "$(FTP_USER),$(FTP_PASS)" "$(FTP_HOST)" -e "\
		set ssl:verify-certificate no; \
		mkdir -p $(FTP_PATH); \
		mirror -R --verbose --only-newer --parallel=4 \
			$(LOCAL_DIST)/ $(FTP_PATH)/; \
		bye"
	@echo ""
	@echo "Deployment complete!"

deploy-dryrun: ## Show what would be deployed (no upload)
	@echo "=== Deployment Dry Run ==="
	@echo ""
	@echo "Target: $(FTP_HOST)$(FTP_PATH)"
	@echo ""
	@echo "Local build output: $(LOCAL_DIST)/"
	@if [ -d $(LOCAL_DIST) ]; then \
		echo ""; \
		ls -la $(LOCAL_DIST)/ 2>/dev/null; \
		echo ""; \
		echo "Total size:"; \
		du -sh $(LOCAL_DIST)/; \
	else \
		echo "  [NOT BUILT - run 'make build']"; \
	fi
	@echo ""
	@echo "Environment variables (from .env):"
	@echo "  HOSTEUROPE_FTP_HOST=$(FTP_HOST)"
	@echo "  HOSTEUROPE_FTP_USER=$(FTP_USER)"
	@if [ -n "$(FTP_PASS)" ]; then echo "  HOSTEUROPE_FTP_PASS=****"; else echo "  HOSTEUROPE_FTP_PASS=[NOT SET]"; fi
	@echo "  HOSTEUROPE_FTP_PATH=$(FTP_PATH)"

# =============================================================================
# SSL Certificate (Let's Encrypt for HostEurope)
# =============================================================================
# Generates a Let's Encrypt certificate using Certbot DNS manual challenge.
# Output goes to .ssl/ — upload to HostEurope KIS:
#   Webhosting → Sicherheit & SSL → SSL Administrieren → Ersetzen
#
#   ┌──────────────┬─────────────────────────┬───────────────────────────────┐
#   │ KIS Field    │ File                    │ Contents                      │
#   ├──────────────┼─────────────────────────┼───────────────────────────────┤
#   │ Zertifikat   │ .ssl/fullchain.pem      │ Certificate + intermediates   │
#   │ Key          │ .ssl/privkey.pem        │ Private key (keep secret!)    │
#   │ Passwort     │ (leave empty)           │ Not encrypted                 │
#   │ CA           │ (leave empty)           │ Already in fullchain.pem      │
#   └──────────────┴─────────────────────────┴───────────────────────────────┘
#
# Renewal: re-run every ~60-90 days, then re-upload in KIS.
# Requires: certbot (brew install certbot / apt install certbot)

SSL_DOMAIN := notestr.941design.de
SSL_DIR := .ssl

ssl-cert: ## Generate Let's Encrypt certificate for HostEurope
	@if ! command -v certbot >/dev/null 2>&1; then \
		echo "ERROR: certbot not installed."; \
		echo "  macOS:  brew install certbot"; \
		echo "  Linux:  sudo apt install certbot"; \
		exit 1; \
	fi
	@echo "Generating Let's Encrypt certificate for $(SSL_DOMAIN)..."
	@echo ""
	@echo "This will use a manual DNS challenge — you'll need to create a"
	@echo "TXT record in your DNS settings when prompted."
	@echo ""
	certbot certonly \
		--manual \
		--preferred-challenges dns \
		--key-type rsa \
		--config-dir $(SSL_DIR)/config \
		--work-dir $(SSL_DIR)/work \
		--logs-dir $(SSL_DIR)/logs \
		-d $(SSL_DOMAIN)
	@echo ""
	@echo "=== Certificate generated ==="
	@echo ""
	@echo "Files for HostEurope KIS upload:"
	@echo "  Zertifikat:  $$(find $(SSL_DIR)/config/live/$(SSL_DOMAIN) -name fullchain.pem)"
	@echo "  Key:         $$(find $(SSL_DIR)/config/live/$(SSL_DOMAIN) -name privkey.pem)"
	@echo "  Passwort:    (leave empty)"
	@echo "  CA:          (leave empty)"
	@echo ""
	@echo "Upload at: Webhosting → Sicherheit & SSL → SSL Administrieren → Ersetzen"
	@echo "Renew in ~60-90 days by running: make ssl-cert"
