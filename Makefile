# Load environment variables from .env if it exists (for FTP credentials)
-include .env
export

.PHONY: help build test dev relay-up relay-down clean deploy deploy-check deploy-dryrun e2e-up e2e-down e2e-install e2e ssl-cert

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

# Re-install when dependencies change OR when the platform changes
# (native bindings like rolldown and @next/swc are platform-specific)
PLATFORM_STAMP := node_modules/.platform
CURRENT_PLATFORM := $(shell uname -sm)

node_modules: package.json package-lock.json
	npm install
	@echo "$(CURRENT_PLATFORM)" > $(PLATFORM_STAMP)
	@touch node_modules

ifneq ($(shell cat $(PLATFORM_STAMP) 2>/dev/null),$(CURRENT_PLATFORM))
.PHONY: node_modules
endif

build: node_modules ## Build for production
	npm run build
	@echo "Static files available in $(LOCAL_DIST)/"

test: node_modules ## Run unit and export verification tests
	npm test

dev: node_modules relay-up clean ## Start development server
	npx next dev --port 3000 --hostname 0.0.0.0

relay-up: ## Start local strfry relay (Docker)
	docker compose up -d

relay-down: ## Stop local strfry relay
	docker compose down

e2e-up: ## Start ephemeral E2E relay (Docker)
	docker compose -f docker-compose.e2e.yml up -d

e2e-down: ## Stop ephemeral E2E relay and wipe state
	docker compose -f docker-compose.e2e.yml down -v

e2e-install: node_modules ## Install Playwright and browser binaries
	npm install
	npx playwright install --with-deps chromium webkit

e2e: node_modules ## Run end-to-end tests (relay up → playwright → relay down)
	@$(MAKE) e2e-up; \
	exit_code=0; \
	npx playwright test || exit_code=$$?; \
	$(MAKE) e2e-down; \
	exit $$exit_code

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
