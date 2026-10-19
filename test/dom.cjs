/* DOM integration tests; not a substitute for actual Chrome extension loading. */
const { JSDOM } = require(process.env.CWM_JSDOM_MODULE || 'jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const sleep = n => new Promise(r => setTimeout(r, n));
const waitFor = async check => { for (let i = 0; i < 50; i++) { if (check()) return; await sleep(50); } assert.ok(check(), 'condition timed out'); };
const message = (role, value, id) => ({ id, author: { role }, content: { parts: [value] } });
const fixture = { conversation_id: 'abc', conversation_origin: 'chatgpt', current_node: 'a', mapping: {
  root: { parent: null }, u: { parent: 'root', message: message('user', '你好', 'u') },
  a: { parent: 'u', message: message('assistant', 'hello', 'a') }
} };
(async () => {
  const dom = new JSDOM('<!doctype html><main><article><div data-message-id="u" data-message-author-role="user">你好</div></article><article><div data-message-id="a" data-message-author-role="assistant">hello</div><button id="switch">分支</button></article></main>', {
    url: 'https://chatgpt.com/c/abc', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window, d = w.document, writes = [], errors = [];
  const el = name => d.getElementById('cwm-' + name);
  let data = {}, storageListener, calls = 0, responseData = fixture, contentType = 'application/json';
  w.addEventListener('error', e => errors.push(e.error));
  // jsdom has no layout engine; visibility is represented explicitly for this integration test.
  w.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  w.TextDecoder = TextDecoder;
  w.fetch = async () => { calls++; return new Response(typeof responseData === 'string' ? responseData : JSON.stringify(responseData), { headers: { 'content-type': contentType } }); };
  w.postMessage = payload => setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { source: w, origin: w.location.origin, data: payload })), 0);
  w.chrome = { storage: { local: {
    get: async () => data,
    set: async value => { data = JSON.parse(JSON.stringify(value)); writes.push(data); storageListener?.({ cwmSettingsV2: { newValue: data.cwmSettingsV2 } }, 'local'); }
  }, onChanged: { addListener: cb => { storageListener = cb; } } } };
  // The host may have module-like objects; entry points must not depend on them.
  w.module = { exports: {} };
  Object.defineProperty(w, '__CWM_CORE', { get() { throw new Error('global core access forbidden'); } });
  try {
    for (const file of ['page_script.js', 'content.js']) w.eval(fs.readFileSync(path.join(project, file), 'utf8'));
    await waitFor(() => el('badge'));
    await w.fetch('/backend-api/conversation/abc');
    await waitFor(() => /分支快照/.test(el('state').textContent));
    assert.match(el('counts').textContent, /1 条用户消息 · 7 个字符/);
    assert.equal(d.querySelectorAll('#cwm-reminder').length, 1, 'root ID must be unique');
    el('badge').click(); assert.equal(el('panel').hidden, false);
    const form = el('settings');
    form.elements.firstTurns.value = '1'; form.elements.secondTurns.value = '2';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => writes.length === 1);
    assert.equal(el('notice').hidden, false);
    assert.deepEqual(Object.keys(writes[0]), ['cwmSettingsV2']);
    assert.deepEqual(Object.keys(writes[0].cwmSettingsV2).sort(), ['enabled', 'firstChars', 'firstTurns', 'mode', 'secondChars', 'secondTurns']);
    assert.equal(JSON.stringify(writes).includes('你好'), false); assert.equal(JSON.stringify(writes).includes('abc'), false);
    el('dismiss').click(); assert.equal(el('notice').hidden, true);
    // Next stage must still notify after dismissing the first.
    responseData = 'data: [DONE]\n\n'; contentType = 'text/event-stream';
    assert.equal(await (await w.fetch('/backend-api/f/conversation', { body: JSON.stringify({ conversation_id: 'abc' }) })).text(), responseData);
    d.querySelector('main').insertAdjacentHTML('beforeend', '<article><div data-message-id="u2" data-message-author-role="user">新的消息</div></article>');
    await waitFor(() => /2 条用户消息/.test(el('counts').textContent));
    assert.match(el('state').textContent, /可见内容/); assert.equal(el('notice').hidden, false);
    // A smaller partial view must not retract the already-reached stronger reminder.
    d.querySelector('[data-message-id="u2"]').closest('article').remove();
    await waitFor(() => /1 条用户消息/.test(el('counts').textContent));
    assert.equal(el('notice').hidden, false); assert.match(el('reminder-text').textContent, /曾达到/);
    el('snooze').click(); assert.equal(el('notice').hidden, true);
    // Text mutations update the count, not only new message nodes.
    d.querySelector('[data-message-id="a"]').firstChild.data = 'hello world';
    await waitFor(() => /13 个字符/.test(el('counts').textContent));
    // A read-only/quota is not a hard cap. A later hard cap has priority.
    contentType = 'application/json'; responseData = { error_code: 'work_usage_limit_exceeded' };
    await w.fetch('/backend-api/conversation/init', { body: JSON.stringify({ conversation_id: 'abc', conversation_origin: 'flora' }) });
    await waitFor(() => /使用额度/.test(el('server').textContent));
    assert.match(el('mode-label').textContent, /Work/); assert.notEqual(d.getElementById('cwm-reminder').dataset.level, 'stop');
    responseData = { detail: { code: 'conversation_too_large' } };
    await w.fetch('/backend-api/f/conversation', { body: JSON.stringify({ conversation_id: 'abc' }) });
    await waitFor(() => /会话容量限制/.test(el('server').textContent));
    assert.equal(d.getElementById('cwm-reminder').dataset.level, 'stop');
    // Unknown/HTML bridge content cannot be rendered.
    w.postMessage({ type: 'CWM_OBSERVATION_V2', packet: { type: 'signal', pathname: '/c/abc', conversationId: 'abc', observedAt: Date.now(), signal: { code: '<img src=x onerror=alert(1)>' } } });
    await sleep(20); assert.equal(el('panel').querySelector('img'), null);
    // SPA route reset even if old page nodes linger longer than the debounce delay.
    w.history.pushState({}, '', '/c/def'); await sleep(1900);
    assert.equal(el('server').hidden, true); assert.match(el('counts').textContent, /打开已有对话/);
    d.querySelector('main').innerHTML = '<article><div data-message-id="def-u" data-message-author-role="user">新对话</div></article>';
    await waitFor(() => /1 条用户消息 · 3 个字符/.test(el('counts').textContent));
    assert.match(el('mode-label').textContent, /模式未确认/);
    // Explicit Chat mode enables the configurable reminder; detected Work overrode it earlier.
    form.elements.mode.value = 'chat';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => writes.length === 2); await sleep(20); assert.equal(el('notice').hidden, false);
    el('ignore').click(); assert.equal(el('notice').hidden, true);
    el('close').click(); assert.equal(el('panel').hidden, true);
    assert.equal(calls, 4, 'no additional fetches issued by the extension');
    assert.deepEqual(errors, []);
    console.log('PASS: DOM integration: unique IDs, snapshot, form/save whitelist, stages/dismiss/snooze/ignore, text streaming, Work/quota/hard-cap separation, safe bridge rendering, SPA stale DOM, no extra requests.');
  } finally { w.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
