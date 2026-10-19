const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const C = require('../core');
const message = (role, value, id) => ({ id, author: { role }, content: { parts: [value] } });
const fixture = () => ({ current_node: 'a', mapping: {
  root: { parent: null }, u: { parent: 'root', message: message('user', '你好世界', 'u') },
  a: { parent: 'u', message: message('assistant', 'hello', 'a') },
  off: { parent: 'root', message: message('user', '不应算进去'.repeat(100), 'off') }
} });
function harness(fetchImpl, path = '/c/abc') {
  const packets = [], listeners = {};
  const location = { pathname: path, origin: 'https://chatgpt.com' };
  const window = { fetch: fetchImpl, postMessage: p => packets.push(p.packet),
    addEventListener: (name, fn) => { listeners[name] = fn; } };
  const globals = { window, location, URL, TextDecoder, setTimeout, clearTimeout, console };
  globals.globalThis = globals;
  vm.runInNewContext(fs.readFileSync(require.resolve('../page_script'), 'utf8'), globals);
  return { window, location, packets, listeners };
}
const settle = () => new Promise(r => setTimeout(r, 35));
function jsonResponse(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
test('active branch excludes alternate nodes, counts Unicode codepoints and separates developer', () => {
  const obj = fixture(); obj.mapping.dev = { parent: 'a', message: message('developer', 'rules', 'dev') }; obj.current_node = 'dev';
  const s = C.snapshot(obj);
  assert.equal(s.turns, 1); assert.equal(s.chars, 14); assert.ok(s.breakdown.developer > 0);
  assert.equal(s.activeIds.includes('off'), false);
  assert.equal(C.messageStats(message('user', '😀')).chars, 1);
});
test('missing leaf, broken parent and cycle never fall back to counting all branches', () => {
  const a = fixture(); delete a.current_node; assert.equal(C.snapshot(a), null);
  const b = fixture(); b.mapping.a.parent = 'missing'; assert.equal(C.snapshot(b), null);
  const c = fixture(); c.mapping.u.parent = 'a'; assert.equal(C.snapshot(c), null);
});
test('CJK, English, whitespace and emoji estimate stays explicit and finite', () => {
  assert.equal(C.estimateTokens(''), 0); assert.equal(C.estimateTokens('你好世界'), 6);
  assert.equal(C.estimateTokens('abcdefgh'), 2); assert.equal(C.estimateTokens('😀'), 2);
  assert.ok(C.estimateTokens('中'.repeat(1000)) >= 1000);
  const result = C.snapshot(fixture()); assert.equal('limit' in result, false); assert.equal('percentage' in result, false);
});
test('attachments are omitted instead of JSON stringified; instructions are not chat turns', () => {
  const s = C.messageStats({ author: { role: 'user' }, content: { parts: ['hi', { content_type: 'image_asset_pointer', asset_pointer: 'secret' }] } });
  assert.equal(s.chars, 2); assert.equal(s.omitted, true);
  const profile = C.messageStats({ author: { role: 'user' }, content: { content_type: 'user_editable_context', user_profile: 'private' } });
  assert.equal(profile.turn, 0); assert.equal(profile.role, 'system');
});
test('endpoint allowlist excludes other origins and unrelated resources', () => {
  assert.equal(C.endpoint('https://evil.test/backend-api/conversation/a'), null);
  assert.equal(C.endpoint('https://chatgpt.com.evil.test/backend-api/conversation/a'), null);
  assert.equal(C.endpoint('/backend-api/conversation_limit'), null);
  assert.equal(C.endpoint('/backend-api/conversation/a/files'), null);
  assert.equal(C.endpoint('/backend-api/f/conversation/resume').type, 'send');
  assert.equal(C.endpoint('/backend-api/conversation/init').type, 'init');
});
test('hard stop, quotas, input failures and read-only have distinct semantics', () => {
  assert.equal(C.signal({ detail: { code: 'conversation_too_large' } }).kind, 'hard');
  assert.equal(C.signal({ error_code: 'work_usage_limit_exceeded' }).kind, 'quota');
  assert.equal(C.signal({ error: { code: 'model_cap_exceeded' } }).kind, 'quota');
  assert.equal(C.signal({ code: 'input_too_large' }).kind, 'input');
  assert.equal(C.signal({ banner_info: { name: 'context-truncation-block' } }).kind, 'context');
  assert.equal(C.signal({ is_read_only: true }).kind, 'readonly');
  assert.equal(C.signal({ content: 'conversation_too_large' }), null);
  assert.equal(C.signal({ remaining: 0, can_continue: false, limits_progress: [] }), null);
});
test('two stages are user thresholds; Work and unknown auto mode never use them', () => {
  const s = C.settings({ mode: 'chat' });
  assert.equal(C.level({ turns: 49, chars: 39999 }, s, 'unknown'), 0);
  assert.equal(C.level({ turns: 50, chars: 0 }, s, 'unknown'), 1);
  assert.equal(C.level({ turns: 2, chars: 80000 }, s, 'unknown'), 2);
  assert.equal(C.level({ turns: 10000, chars: 800000 }, s, 'work'), 0);
  assert.equal(C.level({ turns: 10000, chars: 800000 }, C.settings(), 'unknown'), 0);
  assert.equal(C.level({ turns: 10000, chars: 800000 }, C.settings({ enabled: false }), 'chat'), 0);
});
test('settings discard sensitive/unknown fields and sanitize invalid thresholds', () => {
  const s = C.settings({ firstTurns: -5, mode: 'evil', conversation: 'private', token: 'secret' });
  assert.deepEqual(s, C.DEFAULTS); assert.equal('conversation' in s, false);
});
test('SSE handles split chunks, CRLF, multiline data, DONE and bounded frames', () => {
  const out = []; let overflow = false; const p = C.sseParser(x => out.push(x), () => { overflow = true; });
  p.push(': ping\r\ndata:{"error_code":'); p.push('"conversation_too_large"}\r\n\r'); p.push('\n');
  p.push('data: {\ndata: "a": 1}\n\ndata: [DONE]\n\n'); p.end();
  assert.equal(out.length, 2); assert.equal(out[0].error_code, 'conversation_too_large');
  p.push('x'.repeat(1048577)); assert.equal(overflow, true);
});
test('history observation never modifies response body or sends an extra request', async () => {
  let calls = 0; const response = jsonResponse(fixture()); const original = Promise.resolve(response);
  const h = harness(() => { calls++; return original; });
  const returned = h.window.fetch('/backend-api/conversation/abc');
  assert.equal(returned, original); assert.equal(await returned, response);
  assert.deepEqual(await response.json(), fixture()); await settle();
  assert.equal(calls, 1); assert.equal(h.packets.at(-1).stats.turns, 1);
  const serialized = JSON.stringify(h.packets); assert.equal(serialized.includes('你好世界'), false);
  assert.equal(serialized.includes('hello'), false);
});
test('off-origin requests and old conversation responses cannot affect current stats', async () => {
  let resolve; const h = harness(() => new Promise(r => { resolve = r; }));
  h.window.fetch('/backend-api/conversation/abc'); h.location.pathname = '/c/def'; resolve(jsonResponse(fixture()));
  await settle(); assert.equal(h.packets.length, 0);
  const other = harness(() => Promise.resolve(jsonResponse(fixture())));
  await other.window.fetch('https://evil.test/backend-api/conversation/abc'); await settle(); assert.equal(other.packets.length, 0);
});
test('late history cannot overwrite measurements after a send', async () => {
  let resolve; const h = harness(url => url.endsWith('/abc') ? new Promise(r => { resolve = r; }) : Promise.resolve(jsonResponse({})));
  h.window.fetch('/backend-api/conversation/abc');
  await h.window.fetch('/backend-api/f/conversation', { body: JSON.stringify({ conversation_id: 'abc', messages: [] }) });
  resolve(jsonResponse(fixture())); await settle();
  assert.equal(h.packets.some(p => p.type === 'snapshot'), false);
  assert.equal(h.packets[0].type, 'stale');
});
test('JSON errors and init banners bind to the request conversation, never arbitrary visible chat', async () => {
  const h = harness(() => Promise.resolve(jsonResponse({ detail: { code: 'conversation_too_large' } }, 400)));
  await h.window.fetch('/backend-api/f/conversation', { body: JSON.stringify({ conversation_id: 'abc' }) }); await settle();
  assert.equal(h.packets.at(-1).signal.kind, 'hard');
  const wrong = harness(() => Promise.resolve(jsonResponse({ banner_info: { name: 'context-truncation-block' } })));
  await wrong.window.fetch('/backend-api/conversation/init', { body: JSON.stringify({ conversation_id: 'different' }) }); await settle();
  assert.equal(wrong.packets.length, 0);
  await wrong.window.fetch('/backend-api/conversation/init', { body: JSON.stringify({ conversation_id: 'abc' }) }); await settle();
  assert.equal(wrong.packets.at(-1).signal.kind, 'context');
});
test('stream errors and detail metadata are observed while the original SSE is readable', async () => {
  const payload = 'data: {"type":"conversation_detail_metadata","banner_info":{"name":"context-truncation-block"}}\n\n' +
    'data: {"error":"x","error_code":"conversation_too_large"}\n\ndata: [DONE]\n\n';
  const h = harness(() => Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } })));
  const res = await h.window.fetch('/backend-api/f/conversation', { body: JSON.stringify({ conversation_id: 'abc' }) });
  assert.equal(await res.text(), payload); await settle();
  assert.deepEqual(h.packets.filter(p => p.signal).map(p => p.signal.kind), ['context', 'hard']);
});
test('original fetch rejection passes through unchanged', async () => {
  const err = new Error('network'); const h = harness(() => Promise.reject(err));
  await assert.rejects(h.window.fetch('/backend-api/conversation/abc'), e => e === err);
});
test('real sanitized fixture parses without invented model limit', () => {
  const obj = JSON.parse(fs.readFileSync(__dirname + '/fixtures/conversation-sample.json', 'utf8'));
  const s = C.snapshot(obj); assert.ok(s.messages > 0); assert.ok(s.tokens > 0);
  assert.ok(s.breakdown.tool > 0); assert.ok(s.breakdown.reasoning > 0);
  assert.equal('limit' in s, false);
});
test('manifest permission scope and packaged scripts have no runtime dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json')));
  assert.deepEqual(manifest.permissions, ['storage']); assert.equal(manifest.host_permissions, undefined);
  for (const entry of manifest.content_scripts) assert.deepEqual(entry.matches, ['https://chatgpt.com/*']);
  const pkg = JSON.parse(fs.readFileSync(require.resolve('../package.json')));
  assert.equal(pkg.dependencies, undefined);
});

test('each manifest entry starts independently without a global core or module handshake', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json')));
  for (const script of manifest.content_scripts) {
    assert.equal(script.js.length, 1, 'entry must be self contained');
    const globals = { window: { fetch: async () => new Response('{}'), addEventListener() {} },
      document: { readyState: 'loading', addEventListener() {} },
      location: { pathname: '/', origin: 'https://chatgpt.com' },
      module: { exports: {} }, URL, TextDecoder, setTimeout, clearTimeout };
    Object.defineProperty(globals, '__CWM_CORE', { get() { throw new Error('global core must not be read'); } });
    vm.runInNewContext(fs.readFileSync(require.resolve('../' + script.js[0]), 'utf8'), globals);
    assert.deepEqual(globals.module.exports, {}, 'host module export must not be changed');
  }
});
