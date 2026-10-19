/* Runs in MAIN solely to observe existing same-origin fetch responses. */
(function () {
  'use strict';
  if (window.__CWM_OBSERVER) return;
  window.__CWM_OBSERVER = true;
  const C = globalThis.__CWM_CORE;
  const originalFetch = window.fetch;
  let path = location.pathname, epoch = 0, generation = 0;
  let cached = null;
  const cancellations = new Set();
  function checkRoute() {
    if (path !== location.pathname) {
      path = location.pathname; epoch++; generation++; cached = null;
      for (const cancel of cancellations) cancel();
      cancellations.clear();
    }
  }
  function publish(packet) {
    // Only computed counts, IDs for in-memory scoping, and fixed enums cross worlds.
    cached = packet;
    window.postMessage({ type: 'CWM_OBSERVATION_V2', packet }, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'CWM_READY_V2') return;
    checkRoute();
    if (cached) publish(cached);
  });
  async function readLimited(response, maximum, onChunk) {
    const reader = response.body?.getReader();
    if (!reader) return;
    let stopped = false, size = 0;
    const cancel = () => { stopped = true; reader.cancel().catch(() => {}); };
    cancellations.add(cancel);
    const timeout = setTimeout(cancel, 180000);
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) { cancel(); throw new Error('observation-budget'); }
        onChunk(value);
      }
      if (stopped) throw new Error('observation-incomplete');
    } finally {
      clearTimeout(timeout); cancellations.delete(cancel);
      // Release a partially consumed clone on parsing/budget errors as well.
      cancel(); reader.releaseLock();
    }
  }
  async function observe(response, info, context) {
    let boundId = info.type === 'history' ? info.id : C.id(context.body?.conversation_id);
    const requestMode = C.mode(context.body?.conversation_origin);
    function valid(candidate) {
      checkRoute();
      const current = C.route(location.pathname);
      // New chats may acquire their first URL during a response. Never adopt another existing chat.
      if (epoch !== context.epoch) {
        if (!(context.newChat && candidate && current === candidate && epoch === context.epoch + 1)) return false;
      }
      if (boundId && candidate && boundId !== candidate) return false;
      if (!boundId && candidate) boundId = candidate;
      return boundId ? current === boundId || (context.newChat && !current && epoch === context.epoch)
        : context.hasBody && context.newChat && !current && epoch === context.epoch;
    }
    function inspect(obj) {
      if (!obj || typeof obj !== 'object') return;
      const candidate = C.id(obj.conversation_id) || C.id(obj.v?.conversation_id);
      if (!valid(candidate)) return;
      const detected = C.mode(obj.conversation_origin);
      const packet = { conversationId: boundId, pathname: location.pathname,
        mode: detected === 'unknown' ? requestMode : detected, observedAt: Date.now() };
      if (info.type === 'history' && obj.mapping) {
        if (generation !== context.generation) return; // A send superseded this history request.
        const stats = C.snapshot(obj);
        publish({ ...packet, type: 'snapshot', stats, signal: C.signal(obj) });
        return;
      }
      // Known protocol envelopes only. Do not recurse into arbitrary chat text/objects.
      const metadata = obj.type === 'conversation_detail_metadata' ? obj :
        obj.v?.type === 'conversation_detail_metadata' ? obj.v : null;
      const signal = C.signal(obj) || (metadata && (C.signal(metadata) || C.signal(metadata.metadata)));
      if (signal || packet.mode !== 'unknown') publish({ ...packet, type: 'signal', signal });
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      let raw = ''; const decoder = new TextDecoder();
      await readLimited(response.clone(), 24 * 1024 * 1024, bytes => { raw += decoder.decode(bytes, { stream: true }); });
      raw += decoder.decode(); inspect(JSON.parse(raw));
      raw = '';
    } else if (contentType.includes('text/event-stream')) {
      const decoder = new TextDecoder();
      const parser = C.sseParser(inspect, () => { throw new Error('oversized-event'); });
      await readLimited(response.clone(), 32 * 1024 * 1024, bytes => parser.push(decoder.decode(bytes, { stream: true })));
      parser.push(decoder.decode()); parser.end();
    }
  }
  window.fetch = function (...args) {
    checkRoute();
    let info = null, body = null;
    try {
      const input = args[0];
      info = C.endpoint(typeof input === 'string' || input instanceof URL ? String(input) : input?.url, location.origin);
      const raw = args[1]?.body;
      if (info && typeof raw === 'string' && raw.length <= 4 * 1024 * 1024) {
        const parsed = JSON.parse(raw);
        body = { conversation_id: C.id(parsed?.conversation_id),
          conversation_origin: typeof parsed?.conversation_origin === 'string' ? parsed.conversation_origin : null };
      }
    } catch { /* Observing must never block the host request. */ }
    const context = { body, hasBody: !!body, epoch, generation,
      newChat: !C.route(location.pathname) };
    if (info?.type === 'send') {
      generation++; context.generation = generation;
      const cid = C.id(body?.conversation_id);
      if ((cid && cid === C.route(location.pathname)) || (!cid && context.newChat && body)) {
        publish({ type: 'stale', conversationId: cid, pathname: location.pathname,
          mode: C.mode(body?.conversation_origin), observedAt: Date.now() });
      }
    }
    // Preserve the original Promise/result/rejection and the page's body stream exactly.
    const result = Reflect.apply(originalFetch, this, args);
    if (info) result.then(response => {
      // Redirects must stay on the same allowed origin and endpoint family.
      if (response.url && !C.endpoint(response.url, location.origin)) return;
      observe(response, info, context).catch(() => {});
    }, () => {}).catch(() => {});
    return result;
  };
})();
