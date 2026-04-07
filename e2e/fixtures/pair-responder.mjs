/**
 * NIP-46 pair-responder fixture for integration tests.
 *
 * Consumes a `nostrconnect://` URL from process.argv[2] (client-initiated
 * NIP-46 pairing) and responds with an unsolicited `ack` so the Rust
 * NostrConnect client can complete its bootstrap.
 *
 * After the initial ack this fixture continues to serve standard NIP-46
 * requests (get_public_key, sign_event, nip44_encrypt, nip44_decrypt).
 *
 * Prints "Ready" to stdout once the ack is published so callers can
 * synchronize.
 *
 * Usage:
 *   node e2e/fixtures/pair-responder.mjs <nostrconnect_uri>
 *   BUNKER_PRIVATE_KEY=<hex> node e2e/fixtures/pair-responder.mjs <uri>
 */

import NDK, { NDKPrivateKeySigner, NDKEvent } from '@nostr-dev-kit/ndk';

// ── Key setup ────────────────────────────────────────────────────────────────

const privateKey = process.env.BUNKER_PRIVATE_KEY
  || 'a1233c40904e48ddaad99366f9cc6d64fccdda09dca44204210a5b7c2e82b2cb';

// ── Parse nostrconnect:// URI from argv ──────────────────────────────────────

const uriArg = process.argv[2];
if (!uriArg) {
  console.error('[pair-responder] Usage: node pair-responder.mjs <nostrconnect_uri>');
  process.exit(1);
}
if (!uriArg.startsWith('nostrconnect://')) {
  console.error(`[pair-responder] Expected nostrconnect:// URI, got: ${uriArg}`);
  process.exit(1);
}

// Parse: nostrconnect://<clientPubkey>?metadata=<raw_json>&relay=<relay_url>
// metadata is raw un-percent-encoded JSON — cannot use URL() safely.
// Strategy: strip scheme, split on first '?', then find last '&relay='.
const withoutScheme = uriArg.slice('nostrconnect://'.length);
const qIdx = withoutScheme.indexOf('?');
if (qIdx === -1) {
  console.error('[pair-responder] Malformed URI: no query string');
  process.exit(1);
}
const clientPubkey = withoutScheme.slice(0, qIdx);
const query = withoutScheme.slice(qIdx + 1);

const relayMarker = '&relay=';
const relayIdx = query.lastIndexOf(relayMarker);
if (relayIdx === -1) {
  console.error('[pair-responder] Malformed URI: no &relay= in query');
  process.exit(1);
}
const relayUrl = query.slice(relayIdx + relayMarker.length);

if (!clientPubkey || clientPubkey.length !== 64) {
  console.error(`[pair-responder] Invalid client pubkey: ${clientPubkey}`);
  process.exit(1);
}
if (!relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://')) {
  console.error(`[pair-responder] Invalid relay URL: ${relayUrl}`);
  process.exit(1);
}

// ── NDK setup (single pool, no separate rpc pool) ─────────────────────────────

const signer = new NDKPrivateKeySigner(privateKey);
const ndk = new NDK({ explicitRelayUrls: [relayUrl] });
await ndk.connect(3000);

const signerUser = await signer.user();
signerUser.ndk = ndk;
const signerPubkey = signerUser.pubkey;

// ── Helper: NIP-44 encrypt and publish a kind-24133 response ─────────────────

async function sendNip46Response(recipientPubkey, payload) {
  const recipient = ndk.getUser({ pubkey: recipientPubkey });
  const encrypted = await signer.encrypt(recipient, JSON.stringify(payload), 'nip44');
  const event = new NDKEvent(ndk, {
    kind: 24133,
    content: encrypted,
    tags: [['p', recipientPubkey]],
    pubkey: signerPubkey,
  });
  await event.sign(signer);
  const poolRelay = ndk.pool.getRelay(relayUrl + '/') || ndk.pool.getRelay(relayUrl);
  if (poolRelay && poolRelay.status >= 5) {
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    const relaySet = new NDKRelaySet(new Set([poolRelay]), ndk);
    await event.publish(relaySet, 5000);
  } else {
    await event.publish(undefined, 5000);
  }
}

// ── Send unsolicited connect ack to bootstrap the Rust client ────────────────
//
// nostr-connect 0.44 client (get_remote_signer_public_key) waits for a
// kind-24133 Response with result="ack" from the signer addressed to the
// client pubkey. No prior connect request is sent in client-initiated flow.
// We send this ack immediately after connecting.

const ackId = Math.random().toString(36).substring(2, 10);
await sendNip46Response(clientPubkey, { id: ackId, result: 'ack' });

console.log('Ready');

// ── Subscribe to NIP-46 requests addressed to our pubkey ─────────────────────

ndk.subscribe(
  { kinds: [24133], '#p': [signerPubkey] },
  {
    closeOnEose: false,
    onEvent: async (event) => {
      if (event.pubkey === signerPubkey) return; // ignore our own events

      // Decrypt the incoming NIP-46 request
      let decrypted;
      try {
        const sender = ndk.getUser({ pubkey: event.pubkey });
        decrypted = await signer.decrypt(sender, event.content, 'nip44');
      } catch (_) {
        try {
          const sender = ndk.getUser({ pubkey: event.pubkey });
          decrypted = await signer.decrypt(sender, event.content, 'nip04');
        } catch (e) {
          console.error('[pair-responder] Failed to decrypt:', e.message);
          return;
        }
      }

      let msg;
      try {
        msg = JSON.parse(decrypted);
      } catch (e) {
        console.error('[pair-responder] Failed to parse message:', e.message);
        return;
      }

      const { id, method, params } = msg;
      if (!method) return; // it's a response, not a request

      let result;
      switch (method) {
        case 'connect':
          // Respond with "ack" — used when establish_bunker_session sends a
          // connect request after synthesizing the bunker:// URL.
          result = 'ack';
          break;

        case 'get_public_key':
          result = signerPubkey;
          break;

        case 'sign_event': {
          // params[0] is the event JSON string to sign
          let unsignedEvent;
          try {
            unsignedEvent = JSON.parse(params[0]);
          } catch {
            await sendNip46Response(event.pubkey, { id, error: 'invalid event JSON' });
            return;
          }
          const ndkEvent = new NDKEvent(ndk, unsignedEvent);
          await ndkEvent.sign(signer);
          result = JSON.stringify(ndkEvent.rawEvent());
          break;
        }

        case 'nip44_encrypt': {
          const [theirPubkey, plaintext] = params;
          const peer = ndk.getUser({ pubkey: theirPubkey });
          result = await signer.encrypt(peer, plaintext, 'nip44');
          break;
        }

        case 'nip44_decrypt': {
          const [theirPubkey, ciphertext] = params;
          const peer = ndk.getUser({ pubkey: theirPubkey });
          result = await signer.decrypt(peer, ciphertext, 'nip44');
          break;
        }

        default:
          await sendNip46Response(event.pubkey, { id, error: `unsupported method: ${method}` });
          return;
      }

      await sendNip46Response(event.pubkey, { id, result });
    },
  },
);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
