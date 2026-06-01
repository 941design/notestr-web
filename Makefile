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
	@# Reclone when EITHER dist OR package.json is missing. Checking dist alone is
	@# not enough: a partial/interrupted previous run can leave the source tree with
	@# a stale dist/ but no package.json, and then `pnpm pack` below dies with
	@# ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND while the if-check happily declares "dist
	@# exists, skip clone."
	@if [ ! -d /tmp/marmot-ts/dist ] || [ ! -f /tmp/marmot-ts/package.json ]; then \
		echo "[make] /tmp/marmot-ts is missing or incomplete — cloning + building the fork..."; \
		rm -rf /tmp/marmot-ts; \
		git clone --depth 1 --branch addressable-key-packages \
			https://github.com/941design/marmot-ts.git /tmp/marmot-ts && \
		cd /tmp/marmot-ts && pnpm install --ignore-scripts && pnpm run build; \
	fi
	@# Fail loud if the tree still isn't usable. Previously the clone/build swallowed
	@# stderr and used `|| true`, so a transient `git clone` network failure (or a
	@# missing pnpm) would cascade silently into a cryptic `Error 1` from the pack
	@# step below with no diagnostic output at all.
	@if [ ! -d /tmp/marmot-ts/dist ] || [ ! -f /tmp/marmot-ts/package.json ]; then \
		echo "[make] /tmp/marmot-ts still incomplete after clone+build (dist or package.json missing). Check network access to github.com/941design/marmot-ts and that pnpm is installed. To force a fresh clone: rm -rf /tmp/marmot-ts && make node_modules"; \
		exit 1; \
	fi
	@# Pack the built fork into a stable-named tarball and depend on THAT — never a
	@# file: symlink to /tmp/marmot-ts/dist. marmot-ts declares ts-mls as a
	@# peerDependency; a symlink to the dev tree resolves ts-mls to the fork's own
	@# devDep copy — a second ts-mls instance whose branded (unique-symbol) types
	@# don't unify with ours, breaking `tsc` / `next build`. The packed tarball
	@# excludes devDependencies, so it carries no ts-mls and our single copy is used.
	@# (See CLAUDE.md → "marmot-ts (we control the fork)".)
	@# npm_config_ignore_scripts skips the fork's `prepare` (pnpm build) — dist is
	@# already built above; running prepare here trips pnpm's build-script gate.
	@# `pnpm pack` is deterministic w.r.t. /tmp/marmot-ts/dist: an unchanged fork
	@# build always yields the same tarball, and across parallel macOS/Linux dev the
	@# dist is identical (transpiled TS), so the hash matches on both platforms.
	@# Do NOT redirect pnpm pack output. pnpm writes errors (e.g.
	@# ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND when /tmp/marmot-ts is incomplete) to
	@# stdout, so silencing stdout turned pack failures into a cryptic `Error 1`.
	@# A few lines of "Tarball Contents:" on the happy path is the right tradeoff.
	@cd /tmp/marmot-ts && npm_config_ignore_scripts=true pnpm pack && \
		cp -f /tmp/marmot-ts/internet-privacy-marmot-ts-*.tgz /tmp/marmot-ts/marmot-ts.tgz
	@node -e " \
		const fs=require('fs'); \
		const p=JSON.parse(fs.readFileSync('package.json','utf8')); \
		p.dependencies['@internet-privacy/marmot-ts']='file:/tmp/marmot-ts/marmot-ts.tgz'; \
		fs.writeFileSync('package.json',JSON.stringify(p,null,2)); \
	"
	@# This tarball is a locally-rebuilt artifact, not a fixed published package, so
	@# verifying it against a hash baked into the committed lock is fragile: on a
	@# platform switch we repack from a machine-local /tmp/marmot-ts, and if that fork
	@# build ever diverged from the build the lock was generated against, `npm install`
	@# would abort with EINTEGRITY ("tarball ... seems to be corrupted") and take the
	@# whole reinstall down with it. Instead, recompute THIS entry's integrity from the
	@# actual tarball before installing, so the lock always matches what's on disk.
	@# Unchanged dist -> identical hash -> entry left untouched -> no package-lock.json
	@# diff; a genuinely diverged fork build installs cleanly and surfaces as a lockfile
	@# change (the honest signal that the two machines' marmot-ts builds differ).
	@node -e " \
		const fs=require('fs'),crypto=require('crypto'); \
		const lf='package-lock.json',k='node_modules/@internet-privacy/marmot-ts'; \
		const sri='sha512-'+crypto.createHash('sha512').update(fs.readFileSync('/tmp/marmot-ts/marmot-ts.tgz')).digest('base64'); \
		const l=JSON.parse(fs.readFileSync(lf,'utf8')); \
		if(l.packages&&l.packages[k]&&l.packages[k].integrity!==sri){ \
			l.packages[k].integrity=sri; \
			fs.writeFileSync(lf,JSON.stringify(l,null,2)+'\n'); \
		} \
	"
	@npm install --ignore-scripts
	@# ts-mls is marmot-ts's peerDependency (we supply the single shared copy) and
	@# the applesauce packages are types it re-exposes; install them directly so
	@# Next.js resolves them during the build step. (common provides the Rumor type
	@# imported by device-sync/task-store.)
	@npm install ts-mls@2.0.0-rc.10 applesauce-core applesauce-accounts applesauce-common --ignore-scripts 2>/dev/null || true
	@echo "$(CURRENT_PLATFORM)" > $(PLATFORM_STAMP)
	@touch node_modules

# Ensure correct platform before running any build step. The phony declaration
# forces make to always run the rule, which propagates into global-setup.ts
# (which calls `npx next build` directly — outside make — for e2e).
# All targets that invoke a build or test step must depend on this.
.PHONY: ensure-platform
ensure-platform:
	@# Two independent triggers force a clean reinstall:
	@#  1. Stamp mismatch — the recorded platform differs from the host (the normal
	@#     macOS<->Linux switch).
	@#  2. Native-binding probe failure — the stamp can LIE. npm's optional-dependency
	@#     reconciliation across a shared tree can leave a wrong-platform native binary
	@#     in place (e.g. the macOS lightningcss under @tailwindcss/node) while the
	@#     stamp still reads the current platform. `next build` then dies mid-run with
	@#     "Cannot find module '../lightningcss.<platform>.node'" — and because the e2e
	@#     harness runs `next build` directly (outside make), it takes the whole run
	@#     down. Probing the actual CSS binding here turns that into a self-healing
	@#     reinstall. (@next/swc and lightningcss can diverge — npm fixed swc but not
	@#     the nested lightningcss — so a stamp/swc-only check is not enough.)
	@if [ "$(CURRENT_PLATFORM)" != "$$(cat $(PLATFORM_STAMP) 2>/dev/null)" ]; then \
		echo "[make] Platform mismatch: $(CURRENT_PLATFORM) vs $$(cat $(PLATFORM_STAMP) 2>/dev/null || echo unknown). Reinstalling node_modules..."; \
		rm -rf node_modules; \
		$(MAKE) node_modules; \
	elif ! node -e "require('@tailwindcss/postcss')" >/dev/null 2>&1; then \
		echo "[make] Native bindings missing or wrong-platform for $(CURRENT_PLATFORM) (stamp is current but the CSS binding won't load). Reinstalling node_modules..."; \
		rm -rf node_modules; \
		$(MAKE) node_modules; \
	fi
	@# Check that the Playwright chromium binary used by this node_modules matches
	@# what is actually installed under PLAYWRIGHT_BROWSERS_PATH
	@# (/opt/playwright-browsers on this host). A mismatch (e.g. node_modules expects
	@# revision 1208 but /opt has 1223) causes harness crashes at test-run time.
	@if ! node -e "require('playwright-core').chromium.executablePath()" >/dev/null 2>&1; then \
		echo "[make] Playwright chromium binary missing — run 'make e2e-install' to install browser binaries"; \
	elif ! test -x "$$(node -e "require('playwright-core').chromium.executablePath()" 2>/dev/null)"; then \
		echo "[make] Playwright chromium binary not found at expected revision — run 'make e2e-install'"; \
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

e2e-up: ## Start ephemeral E2E relay (Docker) — no-op if :7777 already held
	@# Honour the reuse policy (see CLAUDE.md → "E2E relay (port 7777)"): if
	@# something already holds 7777 (our own dev relay, the ephemeral container,
	@# or even an unrelated strfry from another project), skip the start. Tests
	@# assume relay-state-independence, so reuse is safe; trying to bind 7777
	@# anyway just errors with `Bind for 0.0.0.0:7777 failed: port is already
	@# allocated` and aborts the whole run.
	@if [ -n "$$(lsof -ti:7777 2>/dev/null)" ]; then \
		echo "[e2e-up] Port 7777 already in use; reusing the existing listener."; \
	else \
		docker compose -f docker-compose.e2e.yml up -d; \
	fi

e2e-down: ## Stop ephemeral E2E relay and wipe state
	docker compose -f docker-compose.e2e.yml down -v

e2e-install: ensure-platform ## Install Playwright and browser binaries
	@npm install
	@npx playwright install --with-deps chromium webkit

# Reuse-the-existing-relay policy (see CLAUDE.md → "E2E relay (port 7777)"):
#  1. our `notestr-web-relay-1` running → restart it (tmpfs wipe = clean)
#  2. else 7777 held by anything else → reuse as-is, do NOT try to bind 7777
#  3. else → start the ephemeral container
# This avoids the `Bind for 0.0.0.0:7777 failed: port is already allocated`
# abort when the dev relay (or an unrelated strfry on the host) is already up.
e2e: ensure-platform ## Run end-to-end tests (reuses any existing :7777 relay; see CLAUDE.md)
	@if docker ps --format '{{.Names}}' | grep -q '^notestr-web-relay-1$$'; then \
		echo "[e2e] Restarting ephemeral test relay (tmpfs wipes its DB)."; \
		docker restart notestr-web-relay-1 > /dev/null; \
		sleep 2; \
	elif [ -n "$$(lsof -ti:7777 2>/dev/null)" ]; then \
		echo "[e2e] Port 7777 held by another listener; reusing as-is (per reuse policy)."; \
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
