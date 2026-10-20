const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../core');
const createScanner = require('../scanner');
const message = (id, role = 'user', text = '私密原文' + id) => ({ id, author: { role }, content: { parts: [text] } });
const initial = () => ({ conversation_id: 'abc', conversation_origin: 'chatgpt', current_node: 'a2',
  messages: [message('u2'), message('a2','assistant')], page_info: { has_previous_page: true, start_cursor: 'cursor/older?x=y' } });
const older = () => ({ messages: [message('u1'), message('a1','assistant'), message('u2')], page_info: { has_previous_page: false } });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup(replies, limits = {}) {
  const calls = [], updates = [];
  const scanner = createScanner(C, { limits: { interval: 0, ...limits }, fetch: async (url, options) => {
    calls.push({ url, options }); const item = replies.shift();
    if (typeof item === 'function') return item(url,options);
    if (item instanceof Response) return item;
    if (item instanceof Error) throw item;
    assert.ok(item, 'unexpected extra request'); return response(item);
  } });
  return { calls, updates, run: options => scanner.scan({ conversationId: 'abc', onUpdate: u => updates.push(u), ...options }) };
}
const session = () => ({ accessToken: 'synthetic-test-token', user: { email: 'not-used@example.test' } });
test('manual scan follows cursor, deduplicates overlap, rechecks head and reports exhausted without invented parent proof', async () => {
  const h = setup([session(), initial(), older(), initial()]); const r = await h.run();
  assert.equal(r.status, 'done'); assert.equal(r.exhausted, true); assert.equal(r.stats.complete, false);
  assert.equal(r.stats.turns, 2); assert.equal(r.stats.messages, 4); assert.equal(r.pages, 2);
  assert.equal(h.calls.length, 4);
  assert.equal(new URL(h.calls[2].url).searchParams.get('before'), 'cursor/older?x=y');
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname), ['/api/auth/session','/backend-api/conversations/abc','/backend-api/conversations/abc/messages','/backend-api/conversations/abc']);
  for (const c of h.calls) { assert.equal(c.options.method,'GET'); assert.equal(c.options.redirect,'error'); assert.equal(c.options.credentials,'same-origin'); }
  assert.equal(h.calls[0].options.headers.Authorization, undefined);
  assert.equal(h.calls[1].options.headers.Authorization, 'Bearer synthetic-test-token');
  const exposed = JSON.stringify([r,h.updates]);
  for (const privateValue of ['私密原文','synthetic-test-token','not-used@example.test','cursor/older']) assert.equal(exposed.includes(privateValue),false);
});
test('only a closed explicit mapping parent chain is verified, alternate branch excluded', async () => {
  const head = { conversation_id:'abc',current_node:'a', mapping: {
    root: { parent:null }, u:{ parent:'root',message:message('u') }, a:{parent:'u',message:message('a','assistant')},
    other:{parent:'root',message:message('other')}
  } };
  const r = await setup([session(),head,head]).run();
  assert.equal(r.status,'done'); assert.equal(r.stats.complete,true); assert.equal(r.stats.turns,1);
  assert.equal(r.stats.activeIds.includes('other'),false);
});
test('missing ancestor cannot become complete just because mapping response omits page_info', async () => {
  const head = { current_node:'a',mapping:{a:{parent:'missing',message:message('a')}} };
  const r=await setup([session(),head,head]).run();
  assert.equal(r.status,'done'); assert.equal(r.stats.complete,false);
});
test('mapping fragments can join by explicit parent links across pages', async () => {
  const head={current_node:'a',mapping:{a:{parent:'u',message:message('a','assistant')}},page_info:{has_previous_page:true,start_cursor:'next'}};
  const past={mapping:{root:{parent:null},u:{parent:'root',message:message('u')}},page_info:{has_previous_page:false}};
  const r=await setup([session(),head,past,head]).run(); assert.equal(r.stats.complete,true); assert.equal(r.stats.turns,1);
});
test('repeated cursor or page stops without a loop or double counting', async () => {
  const same=initial(); const h=setup([session(),initial(),same]); const r=await h.run();
  assert.equal(r.status,'stopped');assert.equal(r.reason,'cursor');assert.equal(r.stats.messages,2);assert.equal(h.calls.length,3);
});
test('conflicting duplicate with same text length invalidates scan instead of mixing edits', async () => {
  const past=older();past.messages[2].content.parts=['私密原文xx'];
  const r=await setup([session(),initial(),past]).run(); assert.equal(r.reason,'conflict');assert.equal(r.stats.messages,0);
});
test('wrong overlap order and changed head are rejected', async () => {
  const past=older(); past.messages=[message('u2'),message('u1')];
  assert.equal((await setup([session(),initial(),past]).run()).reason,'conflict');
  const changed=initial(); changed.messages[1].content.parts=['same size but different'];
  const r=await setup([session(),initial(),older(),changed]).run();assert.equal(r.reason,'changed');assert.equal(r.stats.messages,0);
});
test('malformed page_info never gives false completion, versions are not counted', async () => {
  const malformed=initial();delete malformed.page_info;
  assert.equal((await setup([session(),malformed]).run()).reason,'schema');
  const head=initial(); head.messages[0].versions=[message('alternative')];
  const r=await setup([session(),head,older(),head]).run();assert.equal(r.stats.messages,4);
});
test('different conversation and requested branch are rejected', async () => {
  const wrong=initial();wrong.conversation_id='different';
  assert.equal((await setup([session(),wrong]).run()).reason,'scope');
  assert.equal((await setup([session(),initial()]).run({branch:'different'})).reason,'changed');
});
test('cancel before start makes no requests; cancellation between pages retains only partial stats', async () => {
  const controller=new AbortController();controller.abort(); const h=setup([]);
  assert.equal((await h.run({signal:controller.signal})).reason,'cancelled');assert.equal(h.calls.length,0);
  const c=new AbortController(), g=setup([session(),initial()]);
  const r=await g.run({signal:c.signal,onUpdate:u=>{ if(u.status==='reading') c.abort(); }});
  assert.equal(r.reason,'cancelled');assert.equal(r.stats.complete,false);assert.equal(g.calls.length,2);
});
test('cancel aborts in-flight request; timeout and navigation do not leak old results', async () => {
  const controller=new AbortController();
  const pending=(url,o)=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new Error('aborted')));setTimeout(()=>controller.abort(),5);});
  assert.equal((await setup([session(),pending]).run({signal:controller.signal})).reason,'cancelled');
  const hung=(url,o)=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
  assert.equal((await setup([hung],{requestTime:5}).run()).reason,'timeout');
  let current=true;const h=setup([session(),()=>{current=false;return response(initial());}]);
  const r=await h.run({isCurrent:()=>current});assert.equal(r.reason,'changed');assert.equal(r.stats.messages,0);
});
test('401/403/429 stop with no retries, no fallback endpoint, no auto-refresh', async () => {
  for(const [status,reason] of [[401,'auth'],[403,'forbidden'],[429,'rate-limit']]){
    const h=setup([session(),new Response('{}',{status})]);const r=await h.run();
    assert.equal(r.reason,reason);assert.equal(h.calls.length,2);
  }
  const h=setup([{user:{id:'not-a-token'}}]);assert.equal((await h.run()).reason,'auth');assert.equal(h.calls.length,1);
});
test('page, bytes and message budgets preserve partial status; Work does not inherit Chat', async () => {
  assert.equal((await setup([session(),initial()],{pages:1}).run()).reason,'budget');
  assert.equal((await setup([session()],{bytes:1}).run()).reason,'budget');
  assert.equal((await setup([session(),initial()],{messages:1}).run()).reason,'budget');
  const work=initial();work.conversation_origin='flora';const r=await setup([session(),work]).run();
  assert.equal(r.reason,'work');assert.equal(r.mode,'work');
});
test('scanner only exists in isolated entry, trusted click required and MAIN bridge cannot start it', () => {
  const main=fs.readFileSync(require.resolve('../page_script'),'utf8');
  const ui=fs.readFileSync(require.resolve('../content'),'utf8');
  assert.equal(main.includes('createCWMScanner'),false);assert.equal(main.includes('/api/auth/session'),false);
  assert.ok(ui.includes('if (!event.isTrusted || manualController) return;'));
  assert.equal(ui.includes('cwmScanToken'),false);
});
