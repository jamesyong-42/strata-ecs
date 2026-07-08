/**
 * Dev-certificate provisioning for the WebTransport relay (src/wt-relay.js).
 *
 * WebTransport over HTTP/3 needs TLS, and a browser client dials it with `serverCertificateHashes`
 * (pinning the leaf cert by its SHA-256) instead of a CA chain — the demo escape hatch from a real PKI,
 * allowed by the spec ONLY for short-lived certs (≤14 days) over ECDSA. So we mint an ephemeral 13-day
 * ECDSA P-256 cert with the vendored upstream generator (src/certificate.js — openssl's ECDSA PEM does
 * NOT parse in quiche), cache it to a gitignored JSON, and hand the relay the PEM + the client the hash.
 *
 * The cache ({@link DEFAULT_CACHE_FILE}) is regenerated when it is missing, unreadable, or within
 * {@link RENEW_WITHIN_MS} of expiry (so a long-lived `pnpm start:wt` never serves an expired cert, which
 * a browser rejects at handshake). The hash the client pins is the fingerprint with the colons stripped.
 *
 * CLI (`node src/certs.js` / `pnpm cert`): ensure the cache exists, then print the fingerprint and a
 * ready-to-paste client param so a demo page can be pointed at the relay without copying bytes by hand.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { generateWebTransportCertificate } from "./certificate.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The gitignored cache file (a fresh, secret-free dev cert — never commit it). */
export const DEFAULT_CACHE_FILE = resolve(here, "..", ".wt-cert.json");

/** Per WebTransport spec a serverCertificateHashes cert may live at most 14 days; we mint 13. */
export const CERT_DAYS = 13;
/** Regenerate once the cert has under a day of validity left, so a running relay never serves it expired. */
export const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

/** The subject/issuer for the self-signed dev cert — CN=localhost, the host the demo dials. */
const ATTRS = [
  { shortName: "C", value: "US" },
  { shortName: "CN", value: "localhost" },
];

/**
 * @typedef {object} DevCert
 * @property {string} cert        PEM leaf certificate (→ Http3Server `cert`).
 * @property {string} privateKey  PEM PKCS#8 private key (→ Http3Server `privKey`).
 * @property {string} fingerprint Colon-separated SHA-256 of the leaf (human-readable).
 * @property {string} hashHex     The same SHA-256 as lowercase hex, no colons (→ the client's pinned hash).
 * @property {number} expiresAt   Epoch ms when the cert stops being valid.
 */

/** @param {DevCert} c → the `?wt` client param a demo page pastes: the relay pins this exact leaf. */
export const clientParamFor = (c) => `certHash=${c.hashHex}`;

/** Mint a fresh dev cert (validity starts now). Throws if the generator fails (never returns a null cert). */
async function generate() {
  const pem = await generateWebTransportCertificate(ATTRS, { days: CERT_DAYS });
  if (pem === null)
    throw new Error("certificate generation failed (generateWebTransportCertificate → null)");
  return {
    cert: pem.cert,
    privateKey: pem.private,
    fingerprint: pem.fingerprint,
    hashHex: pem.fingerprint.replaceAll(":", "").toLowerCase(),
    expiresAt: Date.now() + CERT_DAYS * 24 * 60 * 60 * 1000,
  };
}

/** A cached blob is usable iff it has the fields we serialize AND is not within a day of expiry. */
function stillGood(blob) {
  return (
    blob !== null &&
    typeof blob === "object" &&
    typeof blob.cert === "string" &&
    typeof blob.privateKey === "string" &&
    typeof blob.hashHex === "string" &&
    typeof blob.expiresAt === "number" &&
    blob.expiresAt - Date.now() > RENEW_WITHIN_MS
  );
}

/**
 * Load the cached dev cert, or mint + cache a fresh one when the cache is missing, unreadable, or near
 * expiry. Returns the {@link DevCert} the relay serves and the client pins. `cacheFile` is overridable so
 * a test can point at a throwaway path.
 */
export async function loadOrCreateCert(cacheFile = DEFAULT_CACHE_FILE) {
  try {
    const blob = JSON.parse(await readFile(cacheFile, "utf8"));
    if (stillGood(blob)) return blob;
  } catch {
    // Missing / unreadable / malformed cache — fall through and mint a fresh one.
  }
  const fresh = await generate();
  try {
    await writeFile(cacheFile, JSON.stringify(fresh), "utf8");
  } catch (err) {
    // A read-only FS is not fatal — we can still serve this process's in-memory cert this run.
    console.warn(`[wt-certs] could not cache cert to ${cacheFile}: ${err.message}`);
  }
  return fresh;
}

// CLI: ensure a cert exists, then print its fingerprint + the ready-to-paste client param.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const c = await loadOrCreateCert();
  const expiresIn = Math.round((c.expiresAt - Date.now()) / (60 * 60 * 1000));
  console.log(`[wt-certs] cache:       ${DEFAULT_CACHE_FILE}`);
  console.log(`[wt-certs] fingerprint: ${c.fingerprint}`);
  console.log(`[wt-certs] hash (hex):  ${c.hashHex}`);
  console.log(`[wt-certs] expires in:  ~${expiresIn}h`);
  console.log(`[wt-certs] client param: ${clientParamFor(c)}`);
}
