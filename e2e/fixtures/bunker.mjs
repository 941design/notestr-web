/**
 * NIP-46 bunker fixture for E2E tests.
 *
 * Uses a hardcoded deterministic test private key so the bunker:// URL is
 * stable across runs. The relay must be running on ws://localhost:7777 before
 * this script is started.
 *
 * Supports multiple instances via BUNKER_PRIVATE_KEY and BUNKER_LABEL env vars.
 *
 * Runnable standalone:
 *   node e2e/fixtures/bunker.mjs
 *   BUNKER_PRIVATE_KEY=<hex> BUNKER_LABEL=B node e2e/fixtures/bunker.mjs
 */

import NDK, { NDKPrivateKeySigner, NDKNip46Backend } from '@nostr-dev-kit/ndk';

// Default: User A's deterministic test keypair (hex-encoded private key).
// Override with BUNKER_PRIVATE_KEY env var for additional bunker instances.
const privateKey = process.env.BUNKER_PRIVATE_KEY
  || 'a1233c40904e48ddaad99366f9cc6d64fccdda09dca44204210a5b7c2e82b2cb';
const label = process.env.BUNKER_LABEL || 'bunker';

// Relay the bunker connects to (same relay the app uses during E2E tests)
const RELAY_URL = 'ws://localhost:7777';

const signer = new NDKPrivateKeySigner(privateKey);
const user = await signer.user();
const pubkeyHex = user.pubkey;

// bunker:// URL that the test will paste into the sign-in form
export const E2E_BUNKER_URL = `bunker://${pubkeyHex}?relay=${encodeURIComponent(RELAY_URL)}`;

const ndk = new NDK({ explicitRelayUrls: [RELAY_URL] });
await ndk.connect(3000);

// Permit all requests automatically for testing purposes
const permitCallback = async () => true;

const backend = new NDKNip46Backend(ndk, signer, permitCallback);
await backend.start();

console.log(`[${label}] Ready. URL: ${E2E_BUNKER_URL}`);

// Keep the process alive
process.on('SIGINT', () => {
  console.log(`[${label}] Shutting down.`);
  process.exit(0);
});
