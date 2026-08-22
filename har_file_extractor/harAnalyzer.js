/**
 * HAR Pulse — Observed Data Flow Analysis Engine
 * 
 * Analyzes the contents of a HAR file and visualizes how data observed
 * in one API response appears in subsequent API requests.
 * 
 * Core Principles:
 * 1. Evidence-backed relationships only (no invented semantic assumptions).
 * 2. Real HAR URL & Host preservation (no converting valid URLs to '(unknown host)' or 'GET /').
 * 3. Stable API/Service identity: scheme://host[:port] for services, METHOD path for endpoints.
 * 4. Value-based matching: field names can differ (e.g. response.id -> request.accountId).
 * 5. Strict chronological ordering (earlier response -> later request).
 * 6. Recursive nested JSON & array extraction.
 * 7. Explicit Presentation & Aggregation layer (API -> API, distinct information, occurrence evidence underneath).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HarAnalyzer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ========================================================================= */
  /* 1. CONSTANTS & BOILERPLATE DEFINITIONS                                    */
  /* ========================================================================= */

  // Low-information boilerplate values that must NEVER form inferred data flow edges
  const BOILERPLATE_VALUES = new Set([
    'null', 'undefined', 'true', 'false', 'none', 'nil', 'nan',
    'ok', 'success', 'error', 'fail', 'failed', 'done', 'pending',
    'application/json', 'application/xml', 'text/html', 'text/plain',
    'text/javascript', 'application/javascript', 'application/x-www-form-urlencoded',
    'multipart/form-data', 'utf-8', 'iso-8859-1', 'gzip', 'br', 'deflate', 'zstd',
    'keep-alive', 'close', 'no-cache', 'no-store', 'max-age=0', 'must-revalidate',
    'get', 'post', 'put', 'patch', 'delete', 'options', 'head',
    '200', '201', '204', '301', '302', '304', '400', '401', '403', '404', '500', '502', '503',
    '0', '1', '-1', 'default', 'anonymous', 'system', 'root', 'user', 'admin',
    '{}', '[]', '""', 'bearer', 'basic', 'localhost', '127.0.0.1', 'http', 'https',
    'void', 'none', 'n/a'
  ]);

  // Generic HTTP headers to ignore during data flow inference
  const IGNORED_HEADERS = new Set([
    'host', 'user-agent', 'accept', 'accept-encoding', 'accept-language',
    'connection', 'content-type', 'content-length', 'origin', 'referer',
    'cache-control', 'pragma', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
    'upgrade-insecure-requests', 'date', 'server', 'vary', 'access-control-allow-origin',
    'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials',
    'access-control-expose-headers', 'access-control-max-age', 'etag', 'last-modified',
    'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'x-xss-protection'
  ]);

  const STATIC_PATH_SEGMENTS = new Set([
    'api', 'v1', 'v2', 'v3', 'v4', 'rest', 'graphql', 'auth', 'login', 'logout',
    'oauth', 'token', 'me', 'self', 'profile', 'settings', 'config', 'status',
    'health', 'ping', 'query', 'mutation', 'search', 'list', 'items', 'users',
    'orders', 'products', 'accounts', 'tenants', 'resources', 'categories',
    'checkout', 'cart', 'dashboard', 'admin', 'action', 'init', 'verify', 'start'
  ]);

  const SENSITIVE_KEY_REGEX = /password|passwd|pwd|secret|token|auth|bearer|apikey|api_key|access_token|refresh_token|private_key|session_id|sessionid|cookie/i;

  /* ========================================================================= */
  /* 2. HELPERS & FORMATTERS                                                   */
  /* ========================================================================= */

  function safeUrlDecode(str) {
    if (typeof str !== 'string') return '';
    try {
      return decodeURIComponent(str.replace(/\+/g, ' '));
    } catch (e) {
      return str;
    }
  }

  function cleanStringValue(val) {
    if (val == null) return '';
    let s = String(val).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  function isSensitiveField(pathOrName) {
    if (!pathOrName) return false;
    return SENSITIVE_KEY_REGEX.test(pathOrName);
  }

  function maskSensitiveValue(value, pathOrName) {
    if (!value) return '';
    if (isSensitiveField(pathOrName)) {
      return '••••••••';
    }
    return value;
  }

  function isInformativeValue(val, keyName = '', minLength = 2) {
    if (val == null) return false;
    const str = cleanStringValue(val);
    if (str.length < minLength) return false;
    if (str.length > 2000) return false;

    const lower = str.toLowerCase();
    if (BOILERPLATE_VALUES.has(lower)) return false;

    if (/^\d{1,2}$/.test(str)) {
      const isIdKey = /(?:id|_id|key|code|num)$/i.test(keyName || '');
      if (!isIdKey) return false;
    }

    return true;
  }

  function tryParseJson(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
  }

  function formatFriendlyName(str) {
    if (!str) return 'API';
    if (str.startsWith('http://') || str.startsWith('https://')) {
      try {
        const u = new URL(str);
        const parts = u.hostname.split('.');
        const main = parts[0] === 'www' && parts.length > 1 ? parts[1] : parts[0];
        return main.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' API';
      } catch (e) {
        return str;
      }
    }
    if (str.includes('.') && !str.includes(' ') && !str.includes('/')) {
      const parts = str.split('.');
      const main = parts[0] === 'www' && parts.length > 1 ? parts[1] : parts[0];
      return main.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' API';
    }
    if (str.includes('/')) {
      const parts = str.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || parts[0];
      return last.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' API';
    }
    return str.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' API';
  }

  function formatAttributeName(attr) {
    if (!attr) return '';
    const last = attr.split('.').pop().replace(/\[\d+\]/g, '');
    
    let words = last
      .replace(/UId/g, 'Uid')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[-_]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    words = words.map(w => {
      const lw = w.toLowerCase();
      if (lw === 'id' || lw === 'ids') return 'ID';
      if (lw === 'uid' || lw === 'uids') return 'UID';
      if (lw === 'url' || lw === 'urls') return 'URL';
      if (lw === 'api' || lw === 'apis') return 'API';
      if (lw === 'guid' || lw === 'uuid') return lw.toUpperCase();
      if (lw === 'pwd') return 'Password';
      if (lw === 'acct') return 'Account';
      if (lw === 'auth') return 'Auth';
      if (lw === 'req') return 'Request';
      if (lw === 'res') return 'Response';
      return w.charAt(0).toUpperCase() + w.slice(1);
    });

    return words.join(' ');
  }

  function isTechnicalAttribute(path) {
    if (!path) return false;
    const p = path.toLowerCase();
    return (
      p.includes('traceid') ||
      p.includes('requestid') ||
      p.includes('correlationid') ||
      p.includes('spanid') ||
      p.includes('timestamp') ||
      p.includes('_ts') ||
      p.startsWith('header.sec-') ||
      p.startsWith('header.cf-') ||
      p.startsWith('header.x-amzn-') ||
      p.startsWith('header.user-agent') ||
      p.startsWith('header.content-type') ||
      p.startsWith('header.accept') ||
      p.includes('nonce') ||
      p.includes('csrf') ||
      p.includes('etag')
    );
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function generateFlowNarrative(edges) {
    if (!edges || edges.length === 0) return [];
    const stories = [];
    edges.forEach(edge => {
      const srcName = escapeHtml(formatFriendlyName(edge.sourceServiceName));
      const tgtName = escapeHtml(formatFriendlyName(edge.targetServiceName));
      const attrNames = (edge.attributeNames || []).map(a => escapeHtml(formatAttributeName(a)));
      const uniqueAttrs = [...new Set(attrNames)];

      if (uniqueAttrs.length === 1) {
        stories.push(`The **${srcName}** sends **${uniqueAttrs[0]}** to the **${tgtName}**.`);
      } else if (uniqueAttrs.length === 2) {
        stories.push(`The **${srcName}** sends **${uniqueAttrs[0]}** and **${uniqueAttrs[1]}** to the **${tgtName}**.`);
      } else if (uniqueAttrs.length > 2) {
        const firstTwo = uniqueAttrs.slice(0, 2).join(', ');
        const remainingCount = uniqueAttrs.length - 2;
        stories.push(`The **${srcName}** sends **${firstTwo}**, and ${remainingCount} other piece${remainingCount > 1 ? 's' : ''} of information to the **${tgtName}**.`);
      }
    });
    return stories;
  }

  /* ========================================================================= */
  /* 3. UNIVERSAL HAR ENTRY NORMALIZATION & URL EXTRACTION                     */
  /* ========================================================================= */

  function normalizeHarEntry(entry, index) {
    const raw = entry.raw || entry;
    const req = entry.request || raw.request || {};
    const res = entry.response || raw.response || {};

    const method = (entry.method || req.method || 'GET').toUpperCase();
    const rawUrl = entry.url || req.url || '';
    const status = typeof entry.status === 'number' ? entry.status : (res.status || 0);

    const startedDateTime = entry.startedDateTime || raw.startedDateTime || null;
    const timestamp = startedDateTime ? new Date(startedDateTime).getTime() : index;

    const requestHeaders = entry.requestHeaders || req.headers || [];
    const responseHeaders = entry.responseHeaders || res.headers || [];

    const postData = entry.postData || req.postData || null;
    const content = entry.content || res.content || null;
    const queryString = req.queryString || [];

    let host = '', scheme = 'https', path = '/', search = '', origin = '';
    let isValidUrl = false;

    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        scheme = u.protocol.replace(':', '');
        host = u.hostname;
        path = u.pathname;
        search = u.search;
        origin = u.origin;
        isValidUrl = true;
      } catch (err) {
        const hostHeader = requestHeaders.find(h => (h.name || '').toLowerCase() === 'host');
        if (hostHeader && hostHeader.value) {
          const hostVal = hostHeader.value.split(':')[0];
          host = hostVal;
          origin = `https://${hostVal}`;
          path = rawUrl.startsWith('/') ? rawUrl.split('?')[0] : `/${rawUrl.split('?')[0]}`;
          search = rawUrl.includes('?') ? `?${rawUrl.split('?')[1]}` : '';
          isValidUrl = true;
        } else {
          path = rawUrl.split('?')[0] || '/';
          search = rawUrl.includes('?') ? `?${rawUrl.split('?')[1]}` : '';
          host = entry.domain || '(unknown host)';
          origin = host !== '(unknown host)' ? `https://${host}` : '(unknown service)';
        }
      }
    } else {
      host = entry.domain || '(unknown host)';
      origin = '(unknown service)';
      path = '/';
    }

    const serviceId = origin !== '(unknown service)' ? origin : host;
    const serviceName = host !== '(unknown host)' ? host : (origin !== '(unknown service)' ? origin : 'Unknown Service');
    const endpointId = `${method} ${path}`;
    const endpointName = `${method} ${path}`;

    return {
      id: `request-${index}`,
      index,
      timestamp,
      method,
      url: rawUrl,
      isValidUrl,
      scheme,
      host,
      origin,
      path,
      search,
      status,
      serviceId,
      serviceName,
      endpointId,
      endpointName,
      requestHeaders,
      responseHeaders,
      postData,
      content,
      queryString,
      raw: entry,
    };
  }

  /* ========================================================================= */
  /* 4. FIELD EXTRACTION LAYER                                                 */
  /* ========================================================================= */

  function extractJsonPrimitives(obj, basePath = '', results = [], visited = new Set(), depth = 0) {
    if (obj == null || depth > 15) return results;

    if (typeof obj === 'object') {
      if (visited.has(obj)) return results;
      visited.add(obj);
    }

    if (Array.isArray(obj)) {
      const maxArr = Math.min(obj.length, 100);
      for (let i = 0; i < maxArr; i++) {
        const currentPath = basePath ? `${basePath}[${i}]` : `[${i}]`;
        extractJsonPrimitives(obj[i], currentPath, results, visited, depth + 1);
      }
    } else if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        const currentPath = basePath ? `${basePath}.${key}` : key;
        if (val != null && typeof val === 'object') {
          extractJsonPrimitives(val, currentPath, results, visited, depth + 1);
        } else if (val != null) {
          const strVal = cleanStringValue(val);
          if (strVal) {
            results.push({
              path: currentPath,
              keyName: key,
              value: strVal,
              normalizedValue: safeUrlDecode(strVal).toLowerCase(),
              originalType: typeof val,
            });

            if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
              const parsedNested = tryParseJson(val);
              if (parsedNested) {
                extractJsonPrimitives(parsedNested, `${currentPath}`, results, visited, depth + 1);
              }
            }
          }
        }
      }
    } else {
      const strVal = cleanStringValue(obj);
      if (strVal) {
        results.push({
          path: basePath || 'value',
          keyName: basePath.split('.').pop() || 'value',
          value: strVal,
          normalizedValue: safeUrlDecode(strVal).toLowerCase(),
          originalType: typeof obj,
        });
      }
    }
    return results;
  }

  function extractFieldsFromNormalizedEntry(normReq, serviceId, serviceName, options = {}) {
    const minLength = typeof options.minLength === 'number' ? options.minLength : 2;
    const fields = [];

    function addField(direction, location, path, keyName, value, raw = null) {
      const cleaned = cleanStringValue(value);
      if (!isInformativeValue(cleaned, keyName, minLength)) return;

      const fieldId = `field_${direction}_${normReq.index}_${fields.length + 1}`;
      const isSensitive = isSensitiveField(path) || isSensitiveField(keyName);

      fields.push({
        id: fieldId,
        requestId: normReq.id,
        entryIndex: normReq.index,
        serviceId,
        serviceName,
        endpointId: normReq.endpointId,
        endpointName: normReq.endpointName,
        direction,
        location,
        path,
        keyName,
        value: cleaned,
        normalizedValue: safeUrlDecode(cleaned).toLowerCase(),
        raw: raw != null ? String(raw) : cleaned,
        isSensitive,
        timestamp: normReq.timestamp,
        url: normReq.url,
        method: normReq.method,
        status: normReq.status,
      });
    }

    // Path Parameters
    const rawSegments = normReq.path.split('/').filter(Boolean);
    rawSegments.forEach((seg, sIdx) => {
      const prevSeg = sIdx > 0 ? rawSegments[sIdx - 1].toLowerCase() : '';
      const cleanSeg = cleanStringValue(safeUrlDecode(seg));

      if (!STATIC_PATH_SEGMENTS.has(cleanSeg.toLowerCase()) && cleanSeg.length >= 2) {
        let paramName = 'id';
        if (prevSeg.endsWith('s') && prevSeg.length > 2) {
          paramName = `${prevSeg.slice(0, -1)}Id`;
        } else if (prevSeg) {
          paramName = `${prevSeg}Id`;
        }
        addField('request', 'path', `path.${paramName}`, paramName, cleanSeg, seg);
      }
    });

    // Query Parameters
    if (normReq.queryString && Array.isArray(normReq.queryString) && normReq.queryString.length > 0) {
      normReq.queryString.forEach(q => {
        if (q.name && q.value) {
          addField('request', 'query', `query.${q.name}`, q.name, q.value, q.value);
        }
      });
    } else if (normReq.search && normReq.search.length > 1) {
      const qStr = normReq.search.startsWith('?') ? normReq.search.slice(1) : normReq.search;
      const pairs = qStr.split('&');
      pairs.forEach(p => {
        const eqIdx = p.indexOf('=');
        if (eqIdx !== -1) {
          const rawKey = p.slice(0, eqIdx);
          const rawVal = p.slice(eqIdx + 1);
          const k = safeUrlDecode(rawKey);
          const v = safeUrlDecode(rawVal);
          if (k && v) {
            addField('request', 'query', `query.${k}`, k, v, rawVal);
          }
        }
      });
    }

    // Request Headers
    normReq.requestHeaders.forEach(h => {
      const hName = (h.name || '').toLowerCase();
      const hVal = cleanStringValue(h.value);
      if (!hVal || IGNORED_HEADERS.has(hName)) return;

      if (hName === 'authorization') {
        let token = hVal;
        if (/^Bearer\s+/i.test(hVal)) {
          token = hVal.replace(/^Bearer\s+/i, '').trim();
        } else if (/^Basic\s+/i.test(hVal)) {
          token = hVal.replace(/^Basic\s+/i, '').trim();
        }
        if (token && token.length >= 4) {
          addField('request', 'header', 'header.Authorization', 'Authorization', token, hVal);
        }
      } else if (hName === 'cookie') {
        const cookieParts = hVal.split(';');
        cookieParts.forEach(cp => {
          const [ck, cv] = cp.split('=');
          if (ck && cv) {
            const cName = ck.trim();
            const cVal = safeUrlDecode(cv.trim());
            addField('request', 'cookie', `cookie.${cName}`, cName, cVal, cv);
          }
        });
      } else if (hName.startsWith('x-') || isSensitiveField(hName)) {
        addField('request', 'header', `header.${h.name}`, h.name, hVal, h.value);
      }
    });

    // Request Body
    if (normReq.postData && normReq.postData.text) {
      const parsedBody = tryParseJson(normReq.postData.text);
      if (parsedBody) {
        const primitives = extractJsonPrimitives(parsedBody, '');
        primitives.forEach(prim => {
          addField('request', 'body', prim.path, prim.keyName, prim.value, prim.value);
        });
      } else if (normReq.postData.text.includes('=') && !normReq.postData.text.startsWith('<')) {
        const pairs = normReq.postData.text.split('&');
        pairs.forEach(p => {
          const eqIdx = p.indexOf('=');
          if (eqIdx !== -1) {
            const k = safeUrlDecode(p.slice(0, eqIdx));
            const v = safeUrlDecode(p.slice(eqIdx + 1));
            if (k && v) {
              addField('request', 'body', `form.${k}`, k, v, p.slice(eqIdx + 1));
            }
          }
        });
      }
    } else if (normReq.postData && normReq.postData.params && Array.isArray(normReq.postData.params)) {
      normReq.postData.params.forEach(param => {
        const pName = param.name || '';
        const pVal = param.value || '';
        if (pName && pVal) {
          addField('request', 'body', `form.${pName}`, pName, pVal, param.value);
        }
      });
    }

    // Response Headers
    normReq.responseHeaders.forEach(h => {
      const hName = (h.name || '').toLowerCase();
      const hVal = cleanStringValue(h.value);
      if (!hVal || IGNORED_HEADERS.has(hName)) return;

      if (hName === 'set-cookie') {
        const cookiePair = hVal.split(';')[0];
        const [ck, cv] = cookiePair.split('=');
        if (ck && cv) {
          const cName = ck.trim();
          const cVal = safeUrlDecode(cv.trim());
          addField('response', 'cookie', `Set-Cookie.${cName}`, cName, cVal, hVal);
        }
      } else if (hName === 'location' || hName.startsWith('x-') || isSensitiveField(hName)) {
        addField('response', 'header', `header.${h.name}`, h.name, hVal, h.value);
      }
    });

    // Response Body
    if (normReq.content && normReq.content.text) {
      const parsedResp = tryParseJson(normReq.content.text);
      if (parsedResp) {
        const primitives = extractJsonPrimitives(parsedResp, '');
        primitives.forEach(prim => {
          addField('response', 'body', prim.path, prim.keyName, prim.value, prim.value);
        });
      }
    }

    return fields;
  }

  /* ========================================================================= */
  /* 5. INFERENCE ENGINE                                                       */
  /* ========================================================================= */

  function analyzeObservedDataFlow(rawEntries, options = {}) {
    if (!Array.isArray(rawEntries)) {
      rawEntries = [];
    }

    const groupMode = options.groupMode || 'service';
    const minLength = typeof options.minLength === 'number' ? options.minLength : 2;

    let validUrlCount = 0;
    let requestsWithJsonBody = 0;
    let responsesWithJsonBody = 0;
    let candidateMatchesCount = 0;

    const normalizedRequests = rawEntries.map((entry, idx) => {
      const norm = normalizeHarEntry(entry, idx);
      if (norm.isValidUrl) validUrlCount++;
      if (norm.postData && norm.postData.text && tryParseJson(norm.postData.text)) requestsWithJsonBody++;
      if (norm.content && norm.content.text && tryParseJson(norm.content.text)) responsesWithJsonBody++;
      return norm;
    });

    const serviceMap = new Map();
    const endpointMap = new Map();

    normalizedRequests.forEach(req => {
      if (!serviceMap.has(req.serviceId)) {
        serviceMap.set(req.serviceId, {
          id: req.serviceId,
          name: req.serviceName,
          host: req.host,
          hostname: req.host,
          scheme: req.scheme,
          entryCount: 0,
          entryIds: [],
        });
      }
      serviceMap.get(req.serviceId).entryCount++;
      serviceMap.get(req.serviceId).entryIds.push(req.index);

      if (!endpointMap.has(req.endpointId)) {
        endpointMap.set(req.endpointId, {
          id: req.endpointId,
          name: req.endpointName,
          serviceId: req.serviceId,
          method: req.method,
          path: req.path,
        });
      }
    });

    const allFields = [];
    let extractedResponseCount = 0;
    let extractedRequestCount = 0;

    normalizedRequests.forEach(req => {
      const entryFields = extractFieldsFromNormalizedEntry(req, req.serviceId, req.serviceName, { minLength });
      entryFields.forEach(f => {
        allFields.push(f);
        if (f.direction === 'response') extractedResponseCount++;
        else if (f.direction === 'request') extractedRequestCount++;
      });
    });

    const responseExactIndex = new Map();
    const responseNormalizedIndex = new Map();

    allFields.forEach(f => {
      if (f.direction === 'response') {
        if (!responseExactIndex.has(f.value)) responseExactIndex.set(f.value, []);
        responseExactIndex.get(f.value).push(f);

        if (!responseNormalizedIndex.has(f.normalizedValue)) responseNormalizedIndex.set(f.normalizedValue, []);
        responseNormalizedIndex.get(f.normalizedValue).push(f);
      }
    });

    const candidates = [];
    allFields.forEach(targetField => {
      if (targetField.direction !== 'request') return;

      const targetEntryIdx = targetField.entryIndex;
      const targetTime = targetField.timestamp;

      let exactCandidates = responseExactIndex.get(targetField.value) || [];
      let normCandidates = responseNormalizedIndex.get(targetField.normalizedValue) || [];

      candidateMatchesCount += (exactCandidates.length + normCandidates.length);

      function isEarlier(src) {
        if (src.entryIndex === targetEntryIdx) return false;
        if (src.timestamp < targetTime) return true;
        if (src.timestamp === targetTime && src.entryIndex < targetEntryIdx) return true;
        return false;
      }

      const validExact = exactCandidates.filter(isEarlier);
      const validNorm = normCandidates.filter(isEarlier).filter(src => src.value !== targetField.value);

      const seenSources = new Set();
      
      const processCandidates = (sources, matchType) => {
        sources.forEach(sourceField => {
          const dedup = `${sourceField.id}`;
          if (seenSources.has(dedup)) return;
          seenSources.add(dedup);
          
          candidates.push({ sourceField, targetField, matchType });
        });
      };
      
      processCandidates(validExact, 'exact');
      processCandidates(validNorm, 'normalized');
    });

    const confirmedLineage = [];
    let acceptedExactCount = 0;
    let acceptedNormalizedCount = 0;
    const diagnostics = { rejected: 0, possible: 0, confirmed: 0 };

    candidates.forEach(cand => {
      const { sourceField, targetField, matchType } = cand;
      let score = 0;
      let signals = [];

      if (matchType === 'exact') {
        score += 3;
        signals.push('exact value match');
      } else {
        score += 1;
        signals.push('normalized match');
      }

      const timeGap = targetField.timestamp - sourceField.timestamp;
      if (timeGap < 5000) {
        score += 2;
        signals.push('short time gap');
      } else if (timeGap > 60000) {
        score -= 2;
        signals.push('large time gap');
      }

      const isCommon = ['true', 'false', '0', '1', 'null', 'undefined'].includes(targetField.normalizedValue) || 
                       (targetField.keyName && ['status', 'code', 'year', 'date', 'country'].some(k => targetField.keyName.toLowerCase().includes(k)));
      
      if (isCommon) {
        score -= 5;
        signals.push('very common value');
      }

      const srcKey = (sourceField.keyName || '').toLowerCase();
      const tgtKey = (targetField.keyName || '').toLowerCase();
      if (srcKey && tgtKey && (srcKey.includes(tgtKey) || tgtKey.includes(srcKey))) {
        score += 2;
        signals.push('compatible field names');
      }

      let classification = 'REJECTED';
      if (score >= 4) classification = 'CONFIRMED';
      else if (score >= 1) classification = 'POSSIBLE';

      diagnostics[classification.toLowerCase()]++;

      if (classification === 'CONFIRMED') {
        if (matchType === 'exact') acceptedExactCount++;
        else acceptedNormalizedCount++;
        
        confirmedLineage.push({
          id: `rel_${confirmedLineage.length + 1}`,
          sourceFieldId: sourceField.id,
          targetFieldId: targetField.id,
          sourceRequestId: sourceField.requestId,
          targetRequestId: targetField.requestId,
          sourceEntryIndex: sourceField.entryIndex,
          targetEntryIndex: targetField.entryIndex,
          
          sourceServiceId: sourceField.serviceId,
          targetServiceId: targetField.serviceId,
          sourceServiceName: sourceField.serviceName,
          targetServiceName: targetField.serviceName,
          
          sourceEndpointId: sourceField.endpointId,
          targetEndpointId: targetField.endpointId,
          sourceEndpointName: sourceField.endpointName,
          targetEndpointName: targetField.endpointName,
          
          sourceDirection: sourceField.direction,
          targetDirection: targetField.direction,
          sourceLocation: sourceField.location,
          targetLocation: targetField.location,
          sourcePath: sourceField.path,
          targetPath: targetField.path,
          sourceMethod: sourceField.method,
          targetMethod: targetField.method,
          sourceUrl: sourceField.url,
          targetUrl: targetField.url,
          sourceTimestamp: sourceField.timestamp,
          targetTimestamp: targetField.timestamp,
          value: sourceField.value,
          isSensitive: sourceField.isSensitive || targetField.isSensitive,
          type: matchType === 'exact' ? 'exact-match' : 'normalized-match',
          confidence: score / 10,
          confidenceLabel: classification,
          evidence: signals.join(', '),
        });
      }
    });

    let outServices = [];
    let mappedRelationships = [];

    if (groupMode === 'endpoint') {
      outServices = [...endpointMap.values()].map(e => ({
        id: e.id,
        name: e.name,
        host: serviceMap.get(e.serviceId)?.host || '',
        hostname: serviceMap.get(e.serviceId)?.host || '',
        entryCount: 0 
      }));
      mappedRelationships = confirmedLineage.map(r => ({
        ...r,
        sourceServiceId: r.sourceEndpointId,
        targetServiceId: r.targetEndpointId,
        sourceServiceName: r.sourceEndpointName,
        targetServiceName: r.targetEndpointName,
      }));
    } else {
      outServices = [...serviceMap.values()];
      mappedRelationships = confirmedLineage;
    }

    const connectionMap = new Map();
    mappedRelationships.forEach(rel => {
      // 11. Remove self-connections for primary API-to-API connection graph
      if (rel.sourceServiceId === rel.targetServiceId) return;

      const connKey = `${rel.sourceServiceId}->${rel.targetServiceId}`;
      if (!connectionMap.has(connKey)) {
        connectionMap.set(connKey, {
          sourceServiceId: rel.sourceServiceId,
          targetServiceId: rel.targetServiceId,
          sourceServiceName: rel.sourceServiceName,
          targetServiceName: rel.targetServiceName,
          informationMap: new Map()
        });
      }
      const conn = connectionMap.get(connKey);
      const attrName = rel.sourcePath.split('.').pop() || rel.sourcePath;
      conn.informationMap.set(attrName, true);
    });

    const graph = {
      nodes: outServices,
      edges: [...connectionMap.values()].map(c => ({
        ...c,
        attributeNames: [...c.informationMap.keys()]
      }))
    };

    return {
      services: outServices,
      endpoints: [...endpointMap.values()],
      relationships: mappedRelationships,
      graph,
      diagnostics: {
        totalEntries: normalizedRequests.length,
        validUrlEntries: validUrlCount,
        uniqueHosts: new Set(outServices.map(s => s.host)).size,
        requestsWithJsonBody,
        responsesWithJsonBody,
        extractedResponseCount,
        extractedRequestCount,
        candidateMatchesCount,
        acceptedExactRelationships: acceptedExactCount,
        acceptedNormalizedRelationships: acceptedNormalizedCount,
        classificationCounts: diagnostics
      },
      statistics: {
        totalRelationships: mappedRelationships.length,
        distinctServices: outServices.length,
      }
    };
  }

  /**
   * Aggregates raw inference evidence into a clean, human-friendly presentation model.
   * Maintains separation of:
   * - API Connections (Source API -> Destination API)
   * - Information (Distinct data attributes)
   * - Occurrences (Raw evidence underneath)
   */
  function buildPresentationModel(dataFlowModel, options = {}) {
    if (!dataFlowModel || !dataFlowModel.relationships) {
      return {
        apiCount: 0,
        connectionCount: 0,
        distinctInformationCount: 0,
        totalRawObservations: 0,
        apiNodes: [],
        apiConnections: [],
        flowStories: [],
        diagnostics: {},
      };
    }

    const hideTechnicalData = options.hideTechnicalData !== false;
    const filterApi = options.filterApi || 'all';
    const dataTypeFilter = options.dataTypeFilter || 'all'; // 'all' | 'business' | 'technical'
    const searchQuery = (options.searchQuery || '').trim().toLowerCase();
    const showApiCalls = options.showApiCalls !== false;
    const showDataFlows = options.showDataFlows !== false;
    const statusFilter = options.statusFilter || 'all'; // 'all' | 'confirmed' | 'inferred'

    let rels = dataFlowModel.relationships || [];

    // Filter by Link Type (API Call vs Data Flow)
    if (!showApiCalls) {
      rels = rels.filter(r => r.type !== 'api_call');
    }
    if (!showDataFlows) {
      rels = rels.filter(r => r.type === 'api_call');
    }

    // Filter by Confirmation Status
    if (statusFilter === 'confirmed') {
      rels = rels.filter(r => r.status === 'user-confirmed' || r.status === 'user-created');
    } else if (statusFilter === 'inferred') {
      rels = rels.filter(r => r.status === 'inferred' || r.status === 'observed');
    }

    // Filter Technical Data
    if (hideTechnicalData || dataTypeFilter === 'business') {
      rels = rels.filter(r => !isTechnicalAttribute(r.sourcePath) && !isTechnicalAttribute(r.targetPath));
    } else if (dataTypeFilter === 'technical') {
      rels = rels.filter(r => isTechnicalAttribute(r.sourcePath) || isTechnicalAttribute(r.targetPath));
    }

    // Filter by Specific API
    if (filterApi && filterApi !== 'all') {
      rels = rels.filter(r => r.sourceServiceId === filterApi || r.targetServiceId === filterApi);
    }

    // Filter by Search Query
    if (searchQuery) {
      rels = rels.filter(r =>
        (r.sourcePath && r.sourcePath.toLowerCase().includes(searchQuery)) ||
        (r.targetPath && r.targetPath.toLowerCase().includes(searchQuery)) ||
        (r.sourcePath && formatAttributeName(r.sourcePath).toLowerCase().includes(searchQuery)) ||
        (r.value && String(r.value).toLowerCase().includes(searchQuery)) ||
        (r.sourceServiceName && r.sourceServiceName.toLowerCase().includes(searchQuery)) ||
        (r.targetServiceName && r.targetServiceName.toLowerCase().includes(searchQuery)) ||
        (r.attributeNames && r.attributeNames.some(a => a.toLowerCase().includes(searchQuery)))
      );
    }

    const connectionMap = new Map();
    const allDistinctInfoSet = new Set();
    const serviceStatsMap = new Map();

    (dataFlowModel.services || []).forEach(s => {
      serviceStatsMap.set(s.id, {
        ...s,
        friendlyName: s.friendlyName || formatFriendlyName(s.name || s.host),
        sentAttributesMap: new Map(),
        receivedAttributesMap: new Map(),
      });
    });

    rels.forEach(rel => {
      const linkType = rel.type || 'data_flow';
      const connKey = `${rel.sourceServiceId}->${rel.targetServiceId}:${linkType}`;
      if (!connectionMap.has(connKey)) {
        connectionMap.set(connKey, {
          id: rel.id || `conn_${connectionMap.size + 1}`,
          sourceServiceId: rel.sourceServiceId,
          targetServiceId: rel.targetServiceId,
          sourceServiceName: rel.sourceServiceName,
          targetServiceName: rel.targetServiceName,
          sourceFriendlyName: formatFriendlyName(rel.sourceServiceName),
          targetFriendlyName: formatFriendlyName(rel.targetServiceName),
          type: linkType,
          status: rel.status || 'inferred',
          description: rel.description || '',
          userModified: !!rel.userModified,
          isUserConfirmed: rel.status === 'user-confirmed' || rel.status === 'user-created',
          informationMap: new Map(),
        });
      }

      const conn = connectionMap.get(connKey);
      
      // If any observation is user-confirmed, upgrade conn status
      if (rel.status === 'user-confirmed' || rel.status === 'user-created') {
        conn.status = rel.status;
        conn.isUserConfirmed = true;
      }

      const attrKey = rel.sourcePath || (rel.attributeNames && rel.attributeNames[0]) || 'Data';
      const formattedName = formatAttributeName(attrKey);
      if (formattedName) allDistinctInfoSet.add(formattedName);

      if (!conn.informationMap.has(formattedName)) {
        conn.informationMap.set(formattedName, {
          attributeName: formattedName,
          rawPath: attrKey,
          targetPath: rel.targetPath || attrKey,
          isSensitive: rel.isSensitive,
          sampleValue: rel.value,
          occurrenceCount: 0,
          evidence: [],
        });
      }

      const infoItem = conn.informationMap.get(formattedName);
      infoItem.occurrenceCount += (rel.occurrenceCount || 1);
      if (rel.evidence && Array.isArray(rel.evidence)) {
        infoItem.evidence.push(...rel.evidence);
      } else {
        infoItem.evidence.push(rel);
      }

      const srcService = serviceStatsMap.get(rel.sourceServiceId);
      if (srcService && !srcService.sentAttributesMap.has(formattedName)) {
        srcService.sentAttributesMap.set(formattedName, {
          attributeName: formattedName,
          rawPath: attrKey,
        });
      }

      const tgtService = serviceStatsMap.get(rel.targetServiceId);
      const tgtFormattedName = formatAttributeName(rel.targetPath || attrKey);
      if (tgtService && !tgtService.receivedAttributesMap.has(tgtFormattedName)) {
        tgtService.receivedAttributesMap.set(tgtFormattedName, {
          attributeName: tgtFormattedName,
          rawPath: rel.targetPath || attrKey,
        });
      }
    });

    const apiConnections = [...connectionMap.values()].map(c => ({
      id: c.id,
      sourceServiceId: c.sourceServiceId,
      targetServiceId: c.targetServiceId,
      sourceServiceName: c.sourceServiceName,
      targetServiceName: c.targetServiceName,
      sourceFriendlyName: c.sourceFriendlyName,
      targetFriendlyName: c.targetFriendlyName,
      type: c.type,
      status: c.status,
      description: c.description,
      userModified: c.userModified,
      isUserConfirmed: c.isUserConfirmed,
      information: [...c.informationMap.values()],
      attributeNames: [...c.informationMap.values()].map(i => i.attributeName),
      informationCount: c.informationMap.size,
    }));

    // Show active connected nodes OR custom user nodes
    const activeNodes = [...serviceStatsMap.values()]
      .filter(s => s.sentAttributesMap.size > 0 || s.receivedAttributesMap.size > 0 || s.isCustom || (serviceStatsMap.size <= 8))
      .map(s => ({
        ...s,
        sentInformationCount: s.sentAttributesMap.size,
        receivedInformationCount: s.receivedAttributesMap.size,
        sentAttributesList: [...s.sentAttributesMap.values()],
        receivedAttributesList: [...s.receivedAttributesMap.values()],
      }));

    const flowStories = generateFlowNarrative(apiConnections);

    return {
      apiCount: activeNodes.length,
      connectionCount: apiConnections.length,
      distinctInformationCount: allDistinctInfoSet.size,
      totalRawObservations: rels.length,
      apiNodes: activeNodes,
      apiConnections,
      flowStories,
      diagnostics: dataFlowModel.diagnostics || {},
    };
  }

  /* ========================================================================= */
  /* 7. ATTRIBUTE TRACING & EXPORTS                                            */
  /* ========================================================================= */

  function traceAttribute(dataFlowModel, query) {
    if (!dataFlowModel || !query) return { matchingRelationships: [], highlightedNodes: [], highlightedEdges: [] };

    const q = String(query).toLowerCase().trim();
    const matchingRelationships = (dataFlowModel.relationships || []).filter(r =>
      r.sourcePath.toLowerCase().includes(q) ||
      r.targetPath.toLowerCase().includes(q) ||
      formatAttributeName(r.sourcePath).toLowerCase().includes(q) ||
      r.value.toLowerCase().includes(q)
    );

    const highlightedNodes = new Set();
    const highlightedEdges = new Set();

    matchingRelationships.forEach(r => {
      highlightedNodes.add(r.sourceServiceId);
      highlightedNodes.add(r.targetServiceId);
      highlightedEdges.add(`${r.sourceServiceId}->${r.targetServiceId}`);
    });

    return {
      query,
      matchingRelationships,
      highlightedNodes: [...highlightedNodes],
      highlightedEdges: [...highlightedEdges],
    };
  }

  function exportDataFlowToJson(dataFlowModel) {
    return JSON.stringify({
      version: '2.0',
      title: 'How Data Moves Between APIs',
      exportedAt: new Date().toISOString(),
      diagnostics: dataFlowModel.diagnostics,
      statistics: dataFlowModel.statistics,
      services: dataFlowModel.services,
      relationships: (dataFlowModel.relationships || []).map(r => ({
        id: r.id,
        source: {
          service: r.sourceServiceName,
          request: `${r.sourceMethod} ${r.sourceUrl}`,
          location: r.sourceFullLocation,
          path: r.sourcePath,
        },
        target: {
          service: r.targetServiceName,
          request: `${r.targetMethod} ${r.targetUrl}`,
          location: r.targetFullLocation,
          path: r.targetPath,
        },
        observedValue: r.isSensitive ? '••••••••' : r.value,
        evidence: r.evidence,
        confidence: r.confidence,
        confidenceLabel: r.confidenceLabel,
      })),
    }, null, 2);
  }

  function exportDataFlowToCsv(dataFlowModel) {
    const headers = [
      'Relationship ID',
      'Source Service',
      'Source Request',
      'Source Field Location',
      'Target Service',
      'Target Request',
      'Target Field Location',
      'Observed Value',
      'Confidence',
      'Evidence'
    ];

    // Mitigate CSV Excel Injection (DDE)
    const sanitizeCsv = (val) => {
      const str = String(val || '');
      // If starts with =, +, -, @, prepend a tab or quote to force string interpretation
      if (/^[=+\-@]/.test(str)) {
        return `"\t${str.replace(/"/g, '""')}"`;
      }
      return `"${str.replace(/"/g, '""')}"`;
    };

    const rows = (dataFlowModel.relationships || []).map(r => [
      sanitizeCsv(r.id),
      sanitizeCsv(r.sourceServiceName),
      sanitizeCsv(`${r.sourceMethod} ${r.sourceUrl}`),
      sanitizeCsv(r.sourceFullLocation),
      sanitizeCsv(r.targetServiceName),
      sanitizeCsv(`${r.targetMethod} ${r.targetUrl}`),
      sanitizeCsv(r.targetFullLocation),
      sanitizeCsv(r.isSensitive ? '••••••••' : r.value),
      sanitizeCsv(`${r.confidenceLabel} (${r.confidence})`),
      sanitizeCsv(r.evidence)
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  /* ========================================================================= */
  /* 8. APPLICATION KNOWLEDGE & ARCHITECTURE PERSISTENCE ENGINE                */
  /* ========================================================================= */

  function createAppKnowledge(appId = 'default_app', appName = 'Default Application', baseModel = null) {
    const now = new Date().toISOString();
    const knowledge = {
      version: '2.0',
      appId: appId || 'default_app',
      appName: appName || 'Default Application',
      createdAt: now,
      updatedAt: now,
      services: [],
      endpoints: [],
      relationships: [],
      unlinkedPairs: [],
      layout: {},
      metadata: {
        description: 'Persistent application architecture and confirmed data flows',
        tags: []
      }
    };

    if (baseModel) {
      if (Array.isArray(baseModel.services)) {
        knowledge.services = baseModel.services.map(s => ({
          id: s.id,
          name: s.name,
          host: s.host || s.hostname || '',
          friendlyName: formatFriendlyName(s.name || s.host),
          group: s.group || 'Default',
          description: s.description || '',
          isCustom: !!s.isCustom,
          isDeleted: false,
        }));
      }
      if (Array.isArray(baseModel.endpoints)) {
        knowledge.endpoints = baseModel.endpoints.map(e => ({
          id: e.id,
          serviceId: e.serviceId,
          name: e.name,
          method: e.method,
          path: e.path,
          group: e.group || 'Default',
          isCustom: !!e.isCustom,
          isDeleted: false
        }));
      }
      if (Array.isArray(baseModel.relationships)) {
        const seen = new Set();
        (baseModel.relationships || []).forEach(r => {
          const pairKey = `${r.sourceServiceId}->${r.targetServiceId}:${r.type || 'data_flow'}`;
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            knowledge.relationships.push({
              id: `know_rel_${knowledge.relationships.length + 1}`,
              sourceServiceId: r.sourceServiceId,
              targetServiceId: r.targetServiceId,
              sourceServiceName: r.sourceServiceName,
              targetServiceName: r.targetServiceName,
              type: r.linkType || (r.type === 'api_call' ? 'api_call' : 'data_flow'),
              status: r.status || (r.confidenceLabel === 'CONFIRMED' ? 'inferred' : 'observed'),
              attributeNames: [formatAttributeName(r.sourcePath || '')].filter(Boolean),
              information: [{
                attributeName: formatAttributeName(r.sourcePath || ''),
                rawPath: r.sourcePath || '',
                targetPath: r.targetPath || '',
                sampleValue: r.value,
                isSensitive: r.isSensitive,
                evidence: [r]
              }],
              description: r.description || '',
              userModified: false,
              isDeleted: false
            });
          }
        });
      }
    }

    return knowledge;
  }

  function detectKnowledgeConflicts(harModel, appKnowledge) {
    if (!harModel || !appKnowledge) return [];
    const conflicts = [];
    const confirmedRelMap = new Map();
    const unlinkedSet = new Set((appKnowledge.unlinkedPairs || []).map(p => `${p.sourceServiceId}->${p.targetServiceId}`));

    (appKnowledge.relationships || []).filter(r => !r.isDeleted && (r.status === 'user-confirmed' || r.status === 'user-created')).forEach(r => {
      confirmedRelMap.set(`${r.sourceServiceId}->${r.targetServiceId}`, r);
    });

    (harModel.relationships || []).forEach(harRel => {
      const pairKey = `${harRel.sourceServiceId}->${harRel.targetServiceId}`;
      if (unlinkedSet.has(pairKey)) {
        conflicts.push({
          id: `conflict_unlinked_${pairKey}`,
          type: 'unlinked_detected',
          severity: 'warning',
          title: `Unlinked connection detected in new HAR`,
          description: `HAR observed data movement from ${harRel.sourceServiceName} to ${harRel.targetServiceName}, but you previously unlinked this connection.`,
          sourceServiceId: harRel.sourceServiceId,
          targetServiceId: harRel.targetServiceId,
          sourceServiceName: harRel.sourceServiceName,
          targetServiceName: harRel.targetServiceName,
          harEvidence: harRel,
          resolutionOptions: ['Keep Unlinked', 'Accept HAR Connection']
        });
      }

      if (confirmedRelMap.has(pairKey)) {
        const confirmed = confirmedRelMap.get(pairKey);
        const harAttr = formatAttributeName(harRel.sourcePath || '');
        if (harAttr && !confirmed.attributeNames.includes(harAttr)) {
          conflicts.push({
            id: `conflict_new_attr_${pairKey}_${harAttr}`,
            type: 'new_attribute_detected',
            severity: 'info',
            title: `New data field discovered`,
            description: `HAR observed new field "${harAttr}" on confirmed connection ${confirmed.sourceServiceName} -> ${confirmed.targetServiceName}.`,
            sourceServiceId: harRel.sourceServiceId,
            targetServiceId: harRel.targetServiceId,
            attributeName: harAttr,
            harEvidence: harRel,
            existingRelationship: confirmed,
            resolutionOptions: ['Add to Relationship', 'Ignore Field']
          });
        }
      }
    });

    return conflicts;
  }

  function mergeHarWithAppKnowledge(harModel, appKnowledge, options = {}) {
    if (!harModel && !appKnowledge) return null;
    if (!appKnowledge) return harModel;
    if (!harModel) {
      const activeServices = (appKnowledge.services || []).filter(s => !s.isDeleted);
      const activeRels = (appKnowledge.relationships || []).filter(r => !r.isDeleted);
      return {
        services: activeServices,
        endpoints: (appKnowledge.endpoints || []).filter(e => !e.isDeleted),
        relationships: activeRels,
        appKnowledge,
        conflicts: [],
        statistics: {
          totalRelationships: activeRels.length,
          distinctServices: activeServices.length
        }
      };
    }

    const serviceMap = new Map();
    const unlinkedSet = new Set((appKnowledge.unlinkedPairs || []).map(p => `${p.sourceServiceId}->${p.targetServiceId}`));

    // 1. Add services from App Knowledge (preserving user friendly names, groups, layout)
    (appKnowledge.services || []).forEach(s => {
      if (!s.isDeleted) {
        serviceMap.set(s.id, {
          ...s,
          entryCount: 0,
          entryIds: [],
          friendlyName: s.friendlyName || formatFriendlyName(s.name || s.host),
          layout: (appKnowledge.layout && appKnowledge.layout[s.id]) || s.layout || null
        });
      }
    });

    // 2. Augment / Add services from HAR
    (harModel.services || []).forEach(harS => {
      if (serviceMap.has(harS.id)) {
        const existing = serviceMap.get(harS.id);
        existing.entryCount = harS.entryCount || 0;
        existing.entryIds = harS.entryIds || [];
        existing.host = existing.host || harS.host;
      } else {
        const isDeleted = (appKnowledge.services || []).some(s => s.id === harS.id && s.isDeleted);
        if (!isDeleted) {
          serviceMap.set(harS.id, {
            ...harS,
            friendlyName: formatFriendlyName(harS.name || harS.host),
            group: 'Default',
            isCustom: false,
            layout: (appKnowledge.layout && appKnowledge.layout[harS.id]) || null
          });
        }
      }
    });

    // 3. Merge relationships
    const mergedRelMap = new Map();

    // Priority A: User confirmed & User created relationships from Knowledge
    (appKnowledge.relationships || []).forEach(userRel => {
      if (!userRel.isDeleted) {
        const key = `${userRel.sourceServiceId}->${userRel.targetServiceId}:${userRel.type || 'data_flow'}`;
        mergedRelMap.set(key, {
          ...userRel,
          id: userRel.id || `rel_${mergedRelMap.size + 1}`,
          sourceServiceName: serviceMap.get(userRel.sourceServiceId)?.friendlyName || userRel.sourceServiceName,
          targetServiceName: serviceMap.get(userRel.targetServiceId)?.friendlyName || userRel.targetServiceName,
          status: userRel.status || 'user-confirmed',
          type: userRel.type || 'data_flow',
          attributeNames: userRel.attributeNames || [],
          information: userRel.information || (userRel.attributeNames || []).map(a => ({ attributeName: a, rawPath: a, occurrenceCount: 1, evidence: [] })),
          isUserConfirmed: true
        });
      }
    });

    // Priority B: Newly inferred relationships from HAR that are not unlinked and not conflicting
    (harModel.relationships || []).forEach(harRel => {
      const pairKey = `${harRel.sourceServiceId}->${harRel.targetServiceId}`;
      if (unlinkedSet.has(pairKey)) return;

      const type = harRel.type === 'api_call' ? 'api_call' : 'data_flow';
      const key = `${pairKey}:${type}`;

      if (mergedRelMap.has(key)) {
        const existing = mergedRelMap.get(key);
        const attrName = formatAttributeName(harRel.sourcePath || '');
        if (attrName && !existing.attributeNames.includes(attrName)) {
          existing.attributeNames.push(attrName);
          existing.information.push({
            attributeName: attrName,
            rawPath: harRel.sourcePath,
            targetPath: harRel.targetPath,
            sampleValue: harRel.value,
            isSensitive: harRel.isSensitive,
            occurrenceCount: 1,
            evidence: [harRel]
          });
        }
      } else {
        mergedRelMap.set(key, {
          id: `inferred_rel_${mergedRelMap.size + 1}`,
          sourceServiceId: harRel.sourceServiceId,
          targetServiceId: harRel.targetServiceId,
          sourceServiceName: serviceMap.get(harRel.sourceServiceId)?.friendlyName || harRel.sourceServiceName,
          targetServiceName: serviceMap.get(harRel.targetServiceId)?.friendlyName || harRel.targetServiceName,
          sourcePath: harRel.sourcePath,
          targetPath: harRel.targetPath,
          type: 'data_flow',
          status: 'inferred',
          confidence: harRel.confidence || 0.8,
          confidenceLabel: harRel.confidenceLabel || 'Inferred',
          attributeNames: [formatAttributeName(harRel.sourcePath || '')].filter(Boolean),
          information: [{
            attributeName: formatAttributeName(harRel.sourcePath || ''),
            rawPath: harRel.sourcePath,
            targetPath: harRel.targetPath,
            sampleValue: harRel.value,
            isSensitive: harRel.isSensitive,
            occurrenceCount: 1,
            evidence: [harRel]
          }],
          evidence: harRel.evidence || 'Inferred from HAR response -> request matching',
          isUserConfirmed: false
        });
      }
    });

    const conflicts = detectKnowledgeConflicts(harModel, appKnowledge);
    const servicesList = [...serviceMap.values()];
    const relsList = [...mergedRelMap.values()];

    return {
      ...harModel,
      services: servicesList,
      relationships: relsList,
      appKnowledge,
      conflicts,
      statistics: {
        totalRelationships: relsList.length,
        distinctServices: servicesList.length,
        confirmedRelationships: relsList.filter(r => r.status === 'user-confirmed' || r.status === 'user-created').length,
        inferredRelationships: relsList.filter(r => r.status === 'inferred').length,
        conflictsCount: conflicts.length
      }
    };
  }

  function exportAppKnowledgeToJson(appKnowledge) {
    return JSON.stringify(appKnowledge || {}, null, 2);
  }

  function importAppKnowledgeFromJson(jsonStr) {
    if (!jsonStr || typeof jsonStr !== 'string') return null;
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed.services && !parsed.relationships) {
        throw new Error('Invalid App Knowledge format');
      }

      // Mitigate Prototype Pollution risks when parsing external JSON
      const sanitizeObj = (obj) => {
        if (!obj || typeof obj !== 'object') return {};
        const safe = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          safe[k] = v;
        }
        return safe;
      };

      return {
        version: parsed.version || '2.0',
        appId: parsed.appId || 'imported_app',
        appName: parsed.appName || 'Imported Application',
        createdAt: parsed.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        services: Array.isArray(parsed.services) ? parsed.services : [],
        endpoints: Array.isArray(parsed.endpoints) ? parsed.endpoints : [],
        relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
        unlinkedPairs: Array.isArray(parsed.unlinkedPairs) ? parsed.unlinkedPairs : [],
        layout: sanitizeObj(parsed.layout),
        metadata: sanitizeObj(parsed.metadata)
      };
    } catch (e) {
      console.error('Failed to parse App Knowledge JSON:', e);
      return null;
    }
  }

  return {
    extractJsonPrimitives,
    normalizeHarEntry,
    analyzeObservedDataFlow,
    buildPresentationModel,
    formatFriendlyName,
    formatAttributeName,
    isTechnicalAttribute,
    generateFlowNarrative,
    traceAttribute,
    maskSensitiveValue,
    isSensitiveField,
    exportDataFlowToJson,
    exportDataFlowToCsv,
    createAppKnowledge,
    detectKnowledgeConflicts,
    mergeHarWithAppKnowledge,
    exportAppKnowledgeToJson,
    importAppKnowledgeFromJson,
  };
}));
