/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { X509Certificate } from "node:crypto";
import { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import * as bufutil from "../../commons/bufutil.js";
import {
  decryptAesGcm,
  hkdfaes,
  hkdfalgkeysz,
  sha512,
} from "../../commons/crypto.js";
import * as envutil from "../../commons/envutil.js";
import * as util from "../../commons/util.js";

const ctx = bufutil.fromStr("encryptcrossservice");

/**
 * @param {String} TLS_CRT_KEY - Contains base64 (no wrap) encoded key and
 * certificate files seprated by a newline (\n) and described by `KEY=` and
 * `CRT=` respectively. Ex: `TLS_="KEY=encoded_string\nCRT=encoded_string"`
 * @return {[BufferSource, BufferSource]} [TLS_KEY, TLS_CRT]
 */
export function getCertKeyFromEnv(TLS_CRT_KEY) {
  if (TLS_CRT_KEY == null) throw new Error("TLS cert / key not found");

  TLS_CRT_KEY = TLS_CRT_KEY.replace(/\\n/g, "\n");

  if (TLS_CRT_KEY.split("=", 1)[0].indexOf("KEY") >= 0) {
    return TLS_CRT_KEY.split("\n").map((v) =>
      Buffer.from(v.substring(v.indexOf("=") + 1), "base64")
    );
  } else if (TLS_CRT_KEY.split("\n")[1].split("=", 1)[0].indexOf("KEY") >= 0) {
    return TLS_CRT_KEY.split("\n")
      .reverse()
      .map((v) => Buffer.from(v.substring(v.indexOf("=") + 1), "base64"));
  } else {
    throw new Error("TLS cert / key malformed");
  }
}

/**
 * @param {X509Certificate} replacing - The X509Certificate to replace the existing one
 * @returns {Promise<[BufferSource, BufferSource]>} - The key and certificate as ArrayBuffers
 */
export async function replaceKeyCert(replacing) {
  if (replacing == null) return [null, null];
  if (
    replacing.subject.indexOf("rethinkdns.com") < 0 ||
    replacing.subjectAltName.indexOf("rethinkdns.com") < 0
  ) {
    return [null, null];
  }

  try {
    const req = new Request("https://redir.nile.workers.dev/x/crt", {
      method: "GET",
    });
    const r = await fetch(req);
    const crthex = await r.text();
    if (util.emptyString(crthex)) {
      log.e("certfile: empty response");
      return [null, null];
    }

    const crtkey = await decryptText(req, crthex);
    if (util.emptyString(crtkey)) {
      log.e("certfile: empty enc(crtkey)");
      return [null, null];
    }
    const [key, cert] = getCertKeyFromEnv(crtkey);
    if (bufutil.emptyBuf(key) || bufutil.emptyBuf(cert)) {
      log.e("certfile: key/cert empty");
      return [null, null];
    }

    const latest = new X509Certificate(cert);
    if (
      latest.subject.indexOf("rethinkdns.com") < 0 ||
      latest.subjectAltName.indexOf("rethinkdns.com") < 0
    ) {
      log.e("certfile: latest cert subject mismatch", latest.subject);
      return [null, null];
    }

    if (latest.serialNumber === replacing.serialNumber) {
      log.d("certfile: latest cert same as replacing", latest.serialNumber);
      return [null, null];
    }

    const latestUntil = new Date(latest.validTo);
    const replacingUntil = new Date(replacing.validTo);
    if (
      latestUntil.getTime() < Date.now() ||
      latestUntil.getTime() <= replacingUntil.getTime()
    ) {
      log.d(
        "certfile: err latestUntil < replacingUntil",
        latestUntil,
        replacingUntil,
        "now",
        Date.now()
      );
      return [null, null];
    }

    log.i("certfile: latest cert", latest.serialNumber, "until", latestUntil);

    return [key, cert];
  } catch (err) {
    log.e("certfile: failed to get cert", err);
  }
  return [null, null];
}

/**
 * @param {Request} req - The request that got us ivciphertaghex
 * @param {string} ivciphertaghex - The cipher text as hex to decrypt as utf8
 * @returns {Promise<Uint8Array|null>} - Encrypted hex string with iv (96 bits) prepended and tag appended; or null on failure
 */
export async function decryptText(req, ivciphertaghex) {
  const now = new Date();
  const u = new URL(req.url);
  const ivciphertag = bufutil.hex2buf(ivciphertaghex);
  if (bufutil.emptyBuf(ivciphertag)) {
    log.e("decrypt: ivciphertag empty");
    return null;
  }

  try {
    const iv = ivciphertag.slice(0, 12); // first 12 bytes are iv
    const ciphertag = ivciphertag.slice(12); // rest is cipher text + tag
    // 1 Aug 2025 => "5/7/2025" => Friday, 7th month (0-indexed), 2025
    const aadstr =
      now.getUTCDay() +
      "/" +
      now.getUTCMonth() +
      "/" +
      now.getUTCFullYear() +
      "/" +
      u.hostname +
      "/" +
      u.pathname +
      "/" +
      req.method;
    const aad = bufutil.fromStr(aadstr);

    log.d(
      "decrypt: ivciphertag",
      ivciphertaghex.length,
      "iv",
      iv.length,
      "ciphertag",
      ciphertag.length,
      "aad",
      aadstr,
      aad.length
    );

    const aeskey = await key();
    if (!aeskey) {
      log.e("decrypt: key missing");
      return null;
    }

    const plain = await decryptAesGcm(aeskey, iv, ciphertag, aad);
    if (bufutil.emptyBuf(plain)) {
      log.e("decrypt: failed to decrypt", ivciphertaghex.length);
      return null;
    }
    return bufutil.toStr(plain);
  } catch (err) {
    log.e("decrypt: failed", err);
    return null;
  }
}

/**
 * @returns {Promise<CryptoKey|null>} - Returns a CryptoKey or null if the key is missing or invalid
 */
async function key() {
  if (bufutil.emptyBuf(ctx)) {
    log.e("key: ctx missing");
    return null;
  }

  const skhex = envutil.kdfSvcSecretHex();
  if (util.emptyString(skhex)) {
    log.e("key: KDF_SVC missing");
    return null;
  }

  const sk = bufutil.hex2buf(skhex);
  if (bufutil.emptyBuf(sk)) {
    log.e("key: kdf seed conv empty");
    return null;
  }

  if (sk.length < hkdfalgkeysz) {
    log.e("keygen: seed too short", sk.length, hkdfalgkeysz);
    return null;
  }

  try {
    const sk256 = sk.slice(0, hkdfalgkeysz);
    // info must always of a fixed size for ALL KDF calls
    const info512 = await sha512(ctx);
    // exportable: crypto.subtle.exportKey("raw", key);
    // log.d("key fingerprint", bufutil.hex(await sha512(bufutil.concat(sk, info512)));

    return hkdfaes(sk256, info512);
  } catch (ignore) {
    log.d("keygen: err", ignore);
  }
  return null;
}

/**
 * @param {Object} headers
 * @return {Object}
 */
export function copyNonPseudoHeaders(headers) {
  // nodejs req headers may be of form
  // ':authority': 'localhost:8080'
  // ':method': 'GET'
  // ':path': '/1:AAIAgA==?dns=AAABAAABAAAAAAAACnJldGhpbmtkbnMDY29tAAABAAE'
  // ':scheme': 'https'
  // accept: 'application/dns-message'
  // 'user-agent': 'Go-http-client/2.0'
  // [Symbol(nodejs.http2.sensitiveHeaders)]: []

  const out = {};

  if (!headers) return out;

  // drop http/2 pseudo-headers
  for (const name in headers) {
    if (name.startsWith(":")) continue;
    out[name] = headers[name];
  }

  return out;
}

/**
 * @param {Object} headers
 * @return {Object}
 */
export function transformPseudoHeaders(headers) {
  const out = {};

  if (!headers) return out;

  // transform http/2 pseudo-headers
  for (const name in headers) {
    if (name.startsWith(":")) {
      out[name.slice(1)] = headers[name];
    } else {
      out[name] = headers[name];
    }
  }

  return out;
}

/**
 * @param {Http2ServerRequest} req
 * @return {String}
 */
export function req2str(req) {
  if (!req) return "request[null]";
  return (
    `request[${req.method}] ${req.headers["content-type"]} ` +
    `${req.url} from ${req.headers["user-agent"]} ` +
    `${req.headers["content-length"]}/${req.readableLength} `
  );
}

/**
 * @param {Http2ServerResponse} res
 * @returns {String}
 */
export function res2str(res) {
  if (!res) return "response[null]";
  return (
    `response[${res.statusCode}] ${res.getHeader("content-type")} ` +
    `headers-sent? ${res.headersSent} write-ended? ${res.writableEnded} ` +
    `${res.getHeader("content-length")}/${res.writableLength}`
  );
}
