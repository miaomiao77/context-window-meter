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
  await settle(); assert.equal(h.packets.filter(p => p.type !== 'history-status').length, 0);
  assert.equal(h.packets[0].history.status, 'pending');
  const other = harness(() => Promise.resolve(jsonResponse(fixture())));
  await other.window.fetch('https://evil.test/backend-api/conversation/abc'); await settle(); assert.equal(other.packets.length, 0);
});
test('late history cannot overwrite measurements after a send', async () => {
  let resolve; const h = harness(url => url.endsWith('/abc') ? new Promise(r => { resolve = r; }) : Promise.resolve(jsonResponse({})));
  h.window.fetch('/backend-api/conversation/abc');
  await h.window.fetch('/backend-api/f/conversation', { body: JSON.stringify({ conversation_id: 'abc', messages: [] }) });
  resolve(jsonResponse(fixture())); await settle();
  assert.equal(h.packets.some(p => p.type === 'snapshot'), false);
  assert.equal(h.packets.at(-1).type, 'stale');
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

const pluralUrl = '/backend-api/conversations/abc?num_turns=10&include_has_versions=true';
const pageFixture = () => JSON.parse(fs.readFileSync(__dirname + '/fixtures/conversation-page-synthetic.json', 'utf8'));
test('observed plural URL, pagination page and legacy variants match without broadening origin/path scope', () => {
  const info = C.endpoint(pluralUrl);
  assert.equal(info.type, 'history'); assert.equal(info.family, 'plural');
  assert.equal(info.id, 'abc'); assert.equal(info.partial, true); assert.equal(info.requestedTurns, 10);
  assert.equal(C.endpoint('/backend-api/conversations/abc').partial, true);
  assert.equal(C.endpoint('/backend-api/conversations/abc/messages?before=cursor&num_turns=10').page, true);
  assert.equal(C.endpoint('/backend-api/conversation/abc?num_turns=10').partial, true);
  assert.equal(C.endpoint('/backend-api/conversation/abc').partial, false);
  for (const url of ['https://evil.test'+pluralUrl, '/backend-api/conversations', '/backend-api/conversations/abc/versions',
    '/backend-api/conversations/abc/message_supplements', '/backend-api/conversation/abc/messages']) assert.equal(C.endpoint(url), null);
});
test('messages/page_info response is counted as a page, excluding versions and hidden branch assumptions', () => {
  const obj = pageFixture(), info = C.endpoint(pluralUrl), stats = C.snapshot(obj, info);
  assert.equal(stats.turns, 2); assert.equal(stats.messages, 4); assert.equal(stats.chars, 20);
  assert.equal(stats.complete, false); assert.equal(stats.coverage, 'message-page');
  assert.equal(stats.hasPrevious, true); assert.equal(stats.requestedTurns, 10);
  obj.current_node = 'outside-this-page'; obj.page_info.has_previous_page = false;
  assert.equal(C.snapshot(obj, info).complete, false, 'no previous page is not proof the entire active branch is covered');
  delete obj.current_node; assert.equal(C.snapshot(obj, info).turns, 2, 'a page does not require a full-tree leaf');
});
test('partial tree stops at the page boundary but never uses all nodes or accepts a cycle', () => {
  const obj = fixture(); obj.mapping.u.parent = 'not-returned';
  const info = C.endpoint(pluralUrl), stats = C.snapshot(obj, info);
  assert.equal(stats.complete, false); assert.equal(stats.turns, 1); assert.equal(stats.coverage, 'branch-slice');
  assert.equal(stats.activeIds.includes('off'), false);
  assert.equal(C.snapshot(fixture(), info).complete, false, 'even an apparent root cannot undo a limited request');
  obj.mapping.u.parent = 'a'; assert.equal(C.snapshot(obj, info), null);
  obj.current_node = 'not-returned'; assert.equal(C.snapshot(obj, info), null);
});
test('unknown page schemas, duplicate IDs and malformed messages are not silently counted', () => {
  const info = C.endpoint(pluralUrl), obj = pageFixture();
  assert.equal(C.snapshot({ items: obj.messages }, info), null);
  obj.messages.push(obj.messages[0]); assert.equal(C.snapshot(obj, info), null);
  obj.messages = [{ id: 'untyped' }]; assert.equal(C.snapshot(obj, info), null);
  const empty = C.snapshot({ messages: [], page_info: { has_previous_page: true } }, info);
  assert.equal(empty.messages, 0); assert.equal(empty.complete, false);
});
test('exact observed GET parses a partial page with no extra fetch and never adds repeated pages', async () => {
  let calls = 0; const h = harness(() => { calls++; return Promise.resolve(jsonResponse(pageFixture())); });
  for (let i = 0; i < 2; i++) { await h.window.fetch(pluralUrl); await settle(); }
  const snapshots = h.packets.filter(p => p.type === 'snapshot');
  assert.equal(calls, 2); assert.equal(snapshots.length, 2);
  for (const p of snapshots) { assert.equal(p.stats.turns, 2); assert.equal(p.stats.complete, false); assert.equal(p.history.status, 'partial'); }
  assert.equal(JSON.stringify(h.packets).includes('第一页'), false);
  assert.equal(JSON.stringify(h.packets).includes('synthetic-older-cursor'), false);
});
test('older /messages pages without current_node remain partial and are not merged into a guessed branch', async () => {
  const page = pageFixture(); delete page.current_node;
  const h = harness(() => Promise.resolve(jsonResponse(page)));
  await h.window.fetch('/backend-api/conversations/abc/messages?before=older&num_turns=10'); await settle();
  assert.equal(h.packets.at(-1).stats.turns, 2); assert.equal(h.packets.at(-1).history.page, true);
  assert.equal(h.packets.at(-1).stats.complete, false);
});
test('GET only: writes to history endpoints are not observed', async () => {
  const h = harness(() => Promise.resolve(jsonResponse(pageFixture())));
  for (const method of ['POST', 'PATCH', 'DELETE']) await h.window.fetch(pluralUrl, { method });
  await settle(); assert.equal(h.packets.length, 0);
});
test('unsupported JSON and failed reads emit scoped diagnostics instead of perpetual silent waiting', async () => {
  const h = harness(() => Promise.resolve(jsonResponse({ items: [] })));
  await h.window.fetch(pluralUrl); await settle();
  assert.equal(h.packets.at(-1).stats, null); assert.equal(h.packets.at(-1).history.status, 'unsupported');
  const broken = harness(() => Promise.resolve(new Response('{', { headers: { 'content-type': 'application/json' } })));
  await broken.window.fetch(pluralUrl); await settle();
  assert.equal(broken.packets.at(-1).history.status, 'unreadable');
  const html = harness(() => Promise.resolve(new Response('not json', { headers: { 'content-type': 'text/html' } })));
  await html.window.fetch(pluralUrl); await settle(); assert.equal(html.packets.at(-1).history.status, 'unreadable');
});
test('plural responses and failures after navigation cannot repopulate another conversation', async () => {
  let resolve; const h = harness(() => new Promise(r => { resolve = r; }));
  h.window.fetch(pluralUrl); h.location.pathname = '/c/def'; resolve(jsonResponse(pageFixture()));
  await settle(); assert.equal(h.packets.filter(p => p.type === 'snapshot').length, 0);
  assert.equal(h.packets.length, 1); assert.equal(h.packets[0].conversationId, 'abc');
});
