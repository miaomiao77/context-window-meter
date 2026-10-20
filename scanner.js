/* Manual history scanner. Embedded ONLY in the isolated-world content entry. */
function createCWMScanner(C, env) {
  'use strict';
  env = env || {};
  const fetcher = env.fetch || ((...args) => fetch(...args));
  const digest = env.digest || (async value => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  });
  const limits = { pages: 500, messages: 100000, bytes: 64 * 1024 * 1024,
    pageBytes: 24 * 1024 * 1024, duration: 300000, requestTime: 30000, interval: 350, ...env.limits };
  const fail = code => { throw new Error(code); };
  const codes = new Set(['cancelled', 'changed', 'auth', 'forbidden', 'rate-limit', 'http', 'network',
    'timeout', 'budget', 'schema', 'cursor', 'conflict', 'scope', 'work']);
  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function scan({ conversationId, branch = null, signal, isCurrent = () => true, onUpdate = () => {} }) {
    if (!C.id(conversationId) || (branch != null && !C.id(branch))) return { status: 'stopped', reason: 'scope' };
    const controller = new AbortController(), started = Date.now();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let token = null, totalBytes = 0, pages = 0, format = null, leaf = null, mode = 'unknown';
    let entries = new Map(), order = [], firstSignature = null, exhausted = false, result = null;
    const cursors = new Set();
    function guard() {
      if (controller.signal.aborted) fail('cancelled');
      if (!isCurrent()) fail('changed');
      if (Date.now() - started > limits.duration) fail('budget');
    }
    function currentStats(verified = false) {
      let nodes = order.map(id => entries.get(id));
      if (format === 'mapping') {
        nodes = []; const seen = new Set(); let id = leaf;
        while (id && entries.has(id)) {
          if (seen.has(id)) fail('conflict'); seen.add(id);
          const e = entries.get(id); if (e.stats) nodes.push(e); id = e.parent;
        }
      }
      return { ...C.aggregate(nodes.map(e => e.stats)), activeIds: nodes.filter(e => e.stats).map(e => e.id),
        branch: leaf, mode, source: 'scan', coverage: verified ? 'branch' : 'scanned-pages',
        complete: verified, exhausted, pages };
    }
    function report(status, reason = null, verified = false) {
      const value = { status, reason, pages, exhausted, stats: currentStats(verified), mode };
      onUpdate(value); return value;
    }
    async function json(path, session = false) {
      guard();
      // Paths are built here; neither page messages nor response next URLs can choose a target.
      const url = new URL(path, 'https://chatgpt.com');
      if (url.origin !== 'https://chatgpt.com') fail('scope');
      const request = new AbortController();
      const cancel = () => request.abort(); controller.signal.addEventListener('abort', cancel, { once: true });
      let timedOut = false, reader;
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, limits.requestTime);
      try {
        const response = await fetcher(url.href, { method: 'GET', credentials: 'same-origin', mode: 'same-origin',
          redirect: 'error', cache: 'no-store', signal: request.signal,
          headers: session ? { Accept: 'application/json' } : { Accept: 'application/json', Authorization: 'Bearer ' + token } });
        guard();
        if (response.url && response.url !== url.href) fail('scope');
        if (response.status === 401) fail('auth');
        if (response.status === 403) fail('forbidden');
        if (response.status === 429) fail('rate-limit');
        if (!response.ok) fail('http');
        if (!(response.headers.get('content-type') || '').includes('application/json')) fail('schema');
        reader = response.body?.getReader(); if (!reader) fail('schema');
        let raw = '', count = 0; const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read(); guard(); if (done) break;
          count += value.byteLength; totalBytes += value.byteLength;
          if (count > (session ? 1024 * 1024 : limits.pageBytes) || totalBytes > limits.bytes) fail('budget');
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
        try { const parsed = JSON.parse(raw); raw = ''; return parsed; } catch { fail('schema'); }
      } catch (e) {
        if (timedOut) fail('timeout');
        if (controller.signal.aborted) fail('cancelled');
        if (codes.has(e.message)) throw e;
        fail('network');
      } finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', cancel);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    }
    async function parse(data, first) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('schema');
      if (data.conversation_id != null && data.conversation_id !== conversationId) fail('scope');
      const detected = C.mode(data.conversation_origin);
      if (detected === 'work') { mode = 'work'; fail('work'); }
      if (detected === 'chat') mode = detected;
      const current = C.id(data.current_node);
      if (first && !current) fail('schema');
      if (first && branch && current !== branch) fail('changed');
      if (!first && current && current !== leaf) fail('changed');
      const kind = Array.isArray(data.messages) ? 'messages' : data.mapping && typeof data.mapping === 'object' && !Array.isArray(data.mapping) ? 'mapping' : null;
      if (!kind || (format && kind !== format)) fail('schema');
      const items = [], seen = new Set();
      const add = async (id, message, parent) => {
        if (!C.id(id) || seen.has(id)) fail('schema'); seen.add(id);
        if (message && (message.id !== id || typeof message.author?.role !== 'string' ||
          !message.content || typeof message.content !== 'object' || Array.isArray(message.content))) fail('schema');
        const stats = message ? C.messageStats(message) : null;
        const signature = await digest(JSON.stringify([stats, parent, message ? C.text(message.content) : null]));
        guard(); items.push({ id, parent, stats, signature });
      };
      if (kind === 'messages') {
        if (data.messages.length > limits.messages) fail('budget');
        for (const m of data.messages) { if (!m) fail('schema'); await add(m.id, m, undefined); }
      } else {
        if (Object.keys(data.mapping).length > limits.messages) fail('budget');
        for (const [id, node] of Object.entries(data.mapping)) {
          if (!node || !Object.hasOwn(node, 'parent') || !(node.parent === null || node.parent === '' || C.id(node.parent))) fail('schema');
          await add(id, node.message || null, node.parent);
        }
      }
      let more = data.page_info?.has_previous_page, cursor = data.page_info?.start_cursor;
      if (typeof more !== 'boolean') {
        if (kind !== 'mapping') fail('schema');
        more = null; // No pagination metadata: only a closed parent chain proves an endpoint.
      }
      if (more && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 4096)) fail('cursor');
      return { kind, current, items, more, cursor: more ? cursor : null };
    }
    function signature(page) { return JSON.stringify([page.kind, page.current, page.more,
      page.kind === 'mapping' ? page.items.map(e => [e.id, e.signature]).sort((a,b) => a[0].localeCompare(b[0])) : page.items.map(e => [e.id, e.signature])]); }
    function merge(page, first) {
      if (first) { format = page.kind; leaf = page.current; }
      const next = page.items.filter(e => !entries.has(e.id));
      for (const e of page.items) if (entries.has(e.id) && entries.get(e.id).signature !== e.signature) fail('conflict');
      if (!first && !next.length && page.items.length) fail('cursor');
      if (entries.size + next.length > limits.messages) fail('budget');
      if (format === 'messages' && !first) {
        // Older page can overlap only as a suffix matching the oldest known prefix.
        const overlap = page.items.filter(e => entries.has(e.id)).map(e => e.id);
        const suffix = page.items.slice(page.items.length - overlap.length).map(e => e.id);
        if (overlap.length && (JSON.stringify(overlap) !== JSON.stringify(suffix) ||
          JSON.stringify(overlap) !== JSON.stringify(order.slice(0, overlap.length)))) fail('conflict');
      }
      for (const e of next) entries.set(e.id, e);
      order = [...next.map(e => e.id), ...order];
    }
    function verifiedBranch() {
      if (format !== 'mapping' || !leaf) return false;
      const seen = new Set(); let id = leaf;
      while (id) {
        if (seen.has(id) || !entries.has(id)) return false; seen.add(id);
        id = entries.get(id).parent;
      }
      return true;
    }
    const initial = new URL('/backend-api/conversations/' + conversationId, 'https://chatgpt.com');
    initial.searchParams.set('num_turns', '10'); initial.searchParams.set('include_has_versions', 'true');
    if (branch) initial.searchParams.set('include_message_id', branch);
    try {
      guard(); report('auth');
      let session = await json('/api/auth/session', true);
      if (typeof session?.accessToken !== 'string' || !/^[\x21-\x7E]{1,32768}$/.test(session.accessToken)) fail('auth');
      token = session.accessToken; session = null;
      let url = initial.href;
      while (true) {
        guard(); if (pages >= limits.pages) fail('budget');
        let data = await json(url), page = await parse(data, pages === 0); data = null;
        const first = pages === 0;
        merge(page, first); pages++;
        if (first) firstSignature = signature(page);
        exhausted = page.more === false || (page.more === null && verifiedBranch()); report('reading');
        if (page.more === null && !exhausted) fail('schema');
        if (exhausted) break;
        if (cursors.has(page.cursor)) fail('cursor'); cursors.add(page.cursor);
        const next = new URL('/backend-api/conversations/' + conversationId + '/messages', 'https://chatgpt.com');
        next.searchParams.set('before', page.cursor); next.searchParams.set('num_turns', '10');
        next.searchParams.set('include_has_versions', 'true'); url = next.href; page = null;
        await pause(limits.interval, controller.signal);
      }
      report('verifying'); await pause(limits.interval, controller.signal);
      let check = await json(initial.href), page = await parse(check, true); check = null;
      if (signature(page) !== firstSignature) fail('changed');
      guard();
      result = report('done', null, verifiedBranch());
    } catch (e) {
      // Never echo server errors, URLs, bodies, IDs or auth values into UI/logs.
      const reason = codes.has(e.message) ? e.message : 'network';
      if (reason === 'changed' || reason === 'conflict' || reason === 'scope') {
        entries.clear(); order = []; exhausted = false;
      }
      try { result = report('stopped', reason); }
      catch { result = { status: 'stopped', reason: 'conflict', pages, exhausted: false, stats: null }; onUpdate(result); }
    } finally {
      token = null; entries.clear(); order = []; cursors.clear(); firstSignature = null;
      signal?.removeEventListener('abort', abort); controller.abort();
    }
    return result;
  }
  return { scan };
}
// Node test export; excluded from browser bundles.
module.exports = createCWMScanner;
