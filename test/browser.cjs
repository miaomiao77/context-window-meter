/* Real Chromium extension test on intercepted, synthetic pages. No account/session. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-test-'));
const message = (role, value, id) => ({ id, author: { role }, content: { parts: [value] } });
const history = { conversation_id: 'abc', conversation_origin: 'chatgpt', current_node: 'a', mapping: {
  root: { parent: null }, u: { parent: 'root', message: message('user', '你好，测试提醒。', 'u') },
  a: { parent: 'u', message: message('assistant', '这是一个测试回答。', 'a') }
} };
const historyPage = { conversation_id: 'abc', conversation_origin: 'chatgpt', current_node: 'a',
  messages: [history.mapping.u.message, history.mapping.a.message], page_info: { has_previous_page: true, start_cursor: 'older' } };
const html = `<!doctype html><html><meta charset="utf-8"><title>Mock ChatGPT</title><body style="background:#f5f5f2;margin:40px"><main>
<article><div data-message-id="u" data-message-author-role="user">你好，测试提醒。</div></article>
<article><div data-message-id="a" data-message-author-role="assistant">这是一个测试回答。</div><button id="branch">另一个回答</button></article></main></body></html>`;
(async () => {
  let context;
  try {
    const options = { headless: true, ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 1200, height: 900 }, args: [
      '--no-sandbox', `--disable-extensions-except=${project}`, `--load-extension=${project}`
    ] };
    if (process.env.CWM_CHROMIUM_PATH) options.executablePath = process.env.CWM_CHROMIUM_PATH;
    else options.channel = 'chromium';
    context = await chromium.launchPersistentContext(profile, options);
    const requests = [], errors = [];
    let initReply = {}, sendReply = 'data: [DONE]\n\n', delayHistory = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()); requests.push(url.pathname);
      if (url.origin !== 'https://chatgpt.com') return route.abort();
      if (url.pathname === '/backend-api/conversations/abc')
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(historyPage) });
      if (url.pathname === '/backend-api/conversation/abc') {
        if (delayHistory) await new Promise(r => setTimeout(r, delayHistory));
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(history) });
      }
      if (url.pathname.endsWith('/init')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(initReply) });
      if (url.pathname === '/backend-api/f/conversation') return route.fulfill({ contentType: 'text/event-stream', body: sendReply });
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const waitText = (selector, pattern) => page.waitForFunction(({ selector, source }) =>
      new RegExp(source).test(document.querySelector(selector)?.textContent || ''), { selector, source: pattern.source });
    const getHistory = () => page.evaluate(() => fetch('/backend-api/conversations/abc?num_turns=10&include_has_versions=true').then(r => r.json()));
    const send = body => page.evaluate(body => fetch('/backend-api/f/conversation', {
      method: 'POST', body: JSON.stringify(body)
    }).then(r => r.text()), body);
    const init = body => page.evaluate(body => fetch('/backend-api/conversation/init', {
      method: 'POST', body: JSON.stringify(body)
    }).then(r => r.json()), body);
    await page.goto('https://chatgpt.com/c/abc');
    await page.locator('#cwm-badge').waitFor();
    await getHistory(); await waitText('#cwm-state', /本页消息统计/);
    assert.match(await page.locator('#cwm-history').textContent(), /num_turns=10/);
    await page.locator('#cwm-badge').click();
    assert.match(await page.locator('#cwm-counts').textContent(), /1 条用户消息/);
    assert.equal((await page.locator('#cwm-panel').textContent()).includes('128,000'), false);
    await page.getByText('提醒设置', { exact: true }).click();
    await page.locator('[name="firstTurns"]').fill('1');
    await page.locator('[name="secondTurns"]').fill('2');
    await page.locator('[name="firstChars"]').fill('100000');
    await page.locator('[name="secondChars"]').fill('200000');
    await page.getByText('保存设置', { exact: true }).click();
    await waitText('#cwm-form-status', /已保存/);
    await page.waitForFunction(() => !document.querySelector('#cwm-notice').hidden);
    await page.locator('#cwm-dismiss').click();
    assert.equal(await page.locator('#cwm-notice').isVisible(), false);
    await send({ conversation_id: 'abc', conversation_origin: 'chatgpt' });
    await page.evaluate(() => {
      const el = document.createElement('article'); el.innerHTML = '<div data-message-id="u2" data-message-author-role="user">又一条消息。</div>';
      document.querySelector('main').appendChild(el);
    });
    await waitText('#cwm-counts', /2 条用户消息/);
    await waitText('#cwm-state', /可见内容/);
    await page.waitForFunction(() => !document.querySelector('#cwm-notice').hidden);
    await page.locator('#cwm-snooze').click();
    assert.equal(await page.locator('#cwm-notice').isVisible(), false);
    // Mode safety and quota distinction.
    initReply = { error_code: 'work_usage_limit_exceeded' };
    await init({ conversation_id: 'abc', conversation_origin: 'flora' });
    await waitText('#cwm-server', /使用额度/); await waitText('#cwm-mode-label', /Work/);
    // Persistent settings only: reload and verify the form.
    await page.reload(); await page.locator('#cwm-badge').click();
    await page.getByText('提醒设置', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[name="firstTurns"]').value === '1');
    // Ignore threshold reminders in this test from this point.
    await page.locator('[name="enabled"]').uncheck(); await page.getByText('保存设置', { exact: true }).click();
    sendReply = 'data: {"error":"mock","error_code":"conversation_too_large"}\n\ndata: [DONE]\n\n';
    const returned = await send({ conversation_id: 'abc' }); assert.equal(returned, sendReply);
    await waitText('#cwm-server', /会话容量限制/);
    assert.equal(await page.locator('#cwm-reminder').getAttribute('data-level'), 'stop');
    // A forged untrusted text cannot become HTML in the extension panel.
    await page.evaluate(() => window.postMessage({ type: 'CWM_OBSERVATION_V2', packet: {
      type: 'signal', pathname: '/c/abc', conversationId: 'abc', observedAt: Date.now(),
      signal: { code: '<img src=x onerror=alert(1)>', kind: 'hard' }
    } }, location.origin));
    assert.equal(await page.locator('#cwm-panel img').count(), 0);
    // Delayed old fetch and old visible DOM must not contaminate new navigation.
    delayHistory = 1200;
    await page.evaluate(() => { window.testPending = fetch('/backend-api/conversation/abc'); history.pushState({}, '', '/c/def'); });
    await page.waitForTimeout(1500);
    await waitText('#cwm-counts', /打开已有对话/);
    assert.equal(await page.locator('#cwm-server').isVisible(), false);
    await page.evaluate(() => { document.querySelector('main').innerHTML = '<article><div data-message-id="different" data-message-author-role="user">新对话</div></article>'; });
    await waitText('#cwm-counts', /1 条用户消息/);
    // Responsive panel stays inside viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.locator('#cwm-panel').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    // Optional visual artifact for internal QA only.
    if (process.env.CWM_SCREENSHOT) await page.screenshot({ path: process.env.CWM_SCREENSHOT });
    assert.deepEqual(errors, []);
    // All requests were page navigation or explicit test actions; observer issued none.
    assert.deepEqual([...new Set(requests)].sort(), ['/backend-api/conversation/abc', '/backend-api/conversation/init', '/backend-api/conversations/abc', '/backend-api/f/conversation', '/c/abc'].sort());
    console.log('PASS: actual MV3 load; plural message page; settings persistence; staged/snoozed reminders; Work/quota separation; SSE original body; untrusted bridge; SPA races; mobile layout; no added requests.');
  } finally {
    await context?.close(); fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
