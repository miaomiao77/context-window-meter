/* Synthetic isolated UI integration. A captured listener substitutes a trusted event;
   actual isTrusted + isolated-world behavior still require test/browser.cjs in Chrome. */
const { JSDOM } = require(process.env.CWM_JSDOM_MODULE || 'jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const sleep = n => new Promise(r => setTimeout(r,n));
const waitFor = async predicate => { for(let i=0;i<80;i++){if(predicate())return;await sleep(30);} assert.ok(predicate(),'UI wait timed out'); };
const msg=(id,role,text)=>({id,author:{role},content:{parts:[text]}});
const head={conversation_id:'abc',conversation_origin:'chatgpt',current_node:'a2',messages:[msg('u2','user','新问题'),msg('a2','assistant','新回答')],page_info:{has_previous_page:true,start_cursor:'older'}};
const older={messages:[msg('u1','user','旧问题'),msg('a1','assistant','旧回答')],page_info:{has_previous_page:false}};
(async()=>{
 const dom=new JSDOM('<main><article><div data-message-id="u2" data-message-author-role="user">新问题</div></article><article><div data-message-id="a2" data-message-author-role="assistant">新回答</div></article></main>',{url:'https://chatgpt.com/c/abc',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,calls=[],writes=[],errors=[],bridge=[];let start;
 const el=name=>d.getElementById('cwm-'+name);
 w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 Object.defineProperty(w.crypto,'subtle',{value:webcrypto.subtle});w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
 const add=w.EventTarget.prototype.addEventListener;
 w.EventTarget.prototype.addEventListener=function(type,callback,...rest){if(this.id==='cwm-scan-start'&&type==='click')start=callback;return add.call(this,type,callback,...rest);};
 w.addEventListener('error',e=>errors.push(e.message));
 w.postMessage=data=>{bridge.push(data);setTimeout(()=>w.dispatchEvent(new w.MessageEvent('message',{source:w,origin:w.location.origin,data})),0);};
 w.chrome={storage:{local:{get:async()=>({}),set:async data=>writes.push(data)},onChanged:{addListener(){}}}};
 w.fetch=async(url,options)=>{
  const p=new URL(url);calls.push({url,options});
  const value=p.pathname==='/api/auth/session'?{accessToken:'test-private-token'}:p.pathname.endsWith('/messages')?older:head;
  return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 };
 try{
  w.eval(fs.readFileSync(require.resolve('../content.js'),'utf8'));await waitFor(()=>el('badge'));
  el('badge').click();el('scan-start').click();await sleep(50);
  assert.equal(calls.length,0,'synthetic DOM click must not authenticate');
  w.postMessage({type:'CWM_SCAN_START_V2',conversationId:'abc'});await sleep(30);assert.equal(calls.length,0);
  const run=start({isTrusted:true});
  await waitFor(()=>!el('scan-cancel').hidden);assert.equal(el('scan-start').disabled,true);
  await run;await waitFor(()=>/接口历史已读完/.test(el('state').textContent));
  assert.match(el('counts').textContent,/2 条用户消息 · 12 个字符/);
  assert.match(el('state').textContent,/分支关系未验证/);assert.match(el('scan-status').textContent,/已读 2 页/);
  assert.equal(calls.length,4);assert.equal(el('scan-start').disabled,false);assert.equal(el('scan-cancel').hidden,true);
  assert.deepEqual(writes,[]);assert.equal(JSON.stringify(bridge).includes('test-private-token'),false);
  // Same-length edit must invalidate a previous scan, not silently keep its larger total.
  d.querySelector('[data-message-id="a2"]').firstChild.data='改回答';
  await waitFor(()=>/作废/.test(el('scan-status').textContent));
  await waitFor(()=>/页面可见内容/.test(el('state').textContent));
  const again=start({isTrusted:true});await waitFor(()=>/正在读取/.test(el('scan-status').textContent));
  el('scan-cancel').click();await again;
  assert.match(el('scan-status').textContent,/已取消/);assert.match(el('state').textContent,/尚不完整/);
  assert.equal(calls.length,6,'cancel during interval must prevent the next request');
  // New message insertion invalidates even an unverified/partial result.
  d.querySelector('main').insertAdjacentHTML('beforeend','<article><div data-message-id="u3" data-message-author-role="user">第三条</div></article>');
  await waitFor(()=>/作废/.test(el('scan-status').textContent));
  const pending=start({isTrusted:true});await waitFor(()=>/正在读取/.test(el('scan-status').textContent));
  w.history.pushState({},'','/c/def');await pending;await sleep(1300);
  assert.doesNotMatch(el('state').textContent,/接口历史已读完|已核对返回/);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS: manual scan UI; synthetic clicks/bridge cannot start; progress, cancellation, exhausted/verified distinction, equal-length edit and new-message invalidation, navigation, no persistent writes/token bridge.');
 }finally{w.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
