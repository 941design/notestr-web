# Load environment variables from .env if it exists (for FTP credentials)
-include .env
export

.PHONY: help build test dev relay-up relay-down clean deploy deploy-check deploy-dryrun

# Default target
.DEFAULT_GOAL := help

# FTP Deployment Configuration
FTP_HOST := $(HOSTEUROPE_FTP_HOST)
FTP_USER := $(HOSTEUROPE_FTP_USER)
FTP_PASS := $(HOSTEUROPE_FTP_PASS)

# Remote path (hosteurope)
REMOTE_ROOT := /notestr

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
	npx next build
	@echo "Static files available in $(LOCAL_DIST)/"

test: node_modules ## Run tests (Vitest)
	npx vitest run

dev: node_modules ## Start development server
	npx next dev --port 3000 --hostname 0.0.0.0

relay-up: ## Start local strfry relay (Docker)
	docker compose up -d

relay-down: ## Stop local strfry relay
	docker compose down

clean: ## Remove build artifacts
	rm -rf out .next

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

deploy: deploy-check ## Deploy to production (FTP)
	@echo "Deploying to $(FTP_HOST)$(REMOTE_ROOT)..."
	@lftp -u "$(FTP_USER),$(FTP_PASS)" "$(FTP_HOST)" -e "\
		set ssl:verify-certificate no; \
		mkdir -p $(REMOTE_ROOT); \
		mirror -R --verbose --only-newer --parallel=4 \
			$(LOCAL_DIST)/ $(REMOTE_ROOT)/; \
		bye"
	@echo ""
	@echo "Deployment complete!"

deploy-dryrun: ## Show what would be deployed (no upload)
	@echo "=== Deployment Dry Run ==="
	@echo ""
	@echo "Target: $(FTP_HOST)$(REMOTE_ROOT)"
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
