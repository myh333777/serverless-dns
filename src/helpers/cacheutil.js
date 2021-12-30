/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as util from "./util.js";
import * as dnsutil from "./dnsutil.js";
const ttlGraceSec = 30; // 30s cache extra time
export function generateQuestionFilter(cf, blf, dnsPacket) {
  const q = dnsPacket.questions[0].name;
  cf[q] = util.objOf(blf.getDomainInfo(q).searchResult);
}

export function generateAnswerFilter(cf, blf, dnsPacket) {
  let li;
  if (dnsutil.isCname(dnsPacket)) {
    li = dnsutil.getCname(dnsPacket.answers);
    addCacheFilter(cf, blf, li);
    return;
  }
  if (dnsutil.isHttps(dnsPacket)) {
    li = dnsutil.getTargetName(dnsPacket);
    addCacheFilter(cf, blf, li);
  }
}

export function addCacheFilter(cf, blf, li) {
  for (let name of li) {
    cf[name] = util.objOf(blf.getDomainInfo(name).searchResult);
  }
}

export function isCacheable(dnsPacket) {
  // only noerror ans are cached, that means nxdomain
  // and ans with other rcodes are not cached at all.
  // btw, nxdomain ttls are in the authority section
  if (!dnsutil.rcodeNoError(dnsPacket)) return false;

  // if there are zero answers, there's nothing to cache
  if (!dnsutil.hasAnswers(dnsPacket)) return false;
  return true;
}

export function determineCacheExpiry(dnsPacket) {
  const expiresImmediately = 0;
  if (!dnsutil.hasAnswers(dnsPacket)) return expiresImmediately;
  // set min(ttl) among all answers, but at least ttlGraceSec
  let minttl = 1 << 30; // some abnormally high ttl
  for (let a of dnsPacket.answers) {
    minttl = Math.min(a.ttl || minttl, minttl);
  }

  if (minttl === 1 << 30) return expiresImmediately;

  minttl = Math.max(minttl + ttlGraceSec, ttlGraceSec);
  const expiry = Date.now() + (minttl * 1000);

  return expiry;
}

export function cacheMetadata(dnsPacket, ttlEndTime, blf, bodyUsed) {
  let cf = {};
  generateAnswerFilter(cf, blf, dnsPacket);
  generateQuestionFilter(cf, blf, dnsPacket);
  return {
    ttlEndTime: ttlEndTime,
    bodyUsed: bodyUsed,
    cacheFilter: cf,
  };
}

export function createCacheInput(dnsPacket, blf, bodyUsed) {
  const ttlEndTime = determineCacheExpiry(dnsPacket);
  let cacheInput = {};
  cacheInput.metaData = cacheMetadata(
    dnsPacket,
    ttlEndTime,
    blf,
    bodyUsed,
  );
  cacheInput.dnsPacket = dnsPacket;
  return cacheInput;
}
