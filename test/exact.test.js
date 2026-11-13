const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../core'), createScanner = require('../scanner');
const {countTokens} = require('gpt-tokenizer/encoding/o200k_base');
const count = s => countTokens(s, {disallowedSpecial:new Set()});
// Oracle: Python tiktoken.get_encoding("o200k_base").encode_ordinary
const oracle = [['2 + 2 = 4',7],['お誕生日おめでとう',8],['🫠😈',5],['等她反馈。',4],
  ['const x = 3;\n',6],['<|endoftext|>',7],['👨‍👩‍👧‍👦',11]];
test('ordinary text matches reference tokenizer; repeated parts are real, mirror fields are not', () => {
  for (const [s,n] of oracle) {
    const m=C.messageStats({content:{parts:[s],text:s}},count);
    assert.equal(m.tokens,n); assert.equal(m.mirrors,1);
  }
  const m=C.messageStats({content:{parts:['重复','重复'], text:'重复\n重复'}},count);
  assert.equal(m.tokens,3);assert.equal(m.mirrors,1);
});
function history() {
  const msg=(id,i)=>({id,author:{role:'assistant'},content:{parts:[oracle[i][0]],text:oracle[i][0]}});
  const pages=[[msg('m4',4),msg('m5',5)],[msg('m2',2),msg('m3',3),msg('m4',4)],
    [msg('m0',0),msg('m1',1),msg('m2',2)]];
  let failOnce=false;
  return {pages, arm:()=>{failOnce=true;}, fetch: async url=>{
    const u=new URL(url);if(u.pathname.includes('session'))return Response.json({accessToken:'synthetic'});
    const i=Number(u.searchParams.get('before')||0);
    if(i===2 && failOnce){failOnce=false;throw new Error('simulated network interruption');}
    return Response.json({conversation_id:'abc',current_node:'m5',messages:pages[i],
      page_info:{has_previous_page:i+1<pages.length,start_cursor:String(i+1)}});
  }};
}
const opts={conversationId:'abc'};
test('pausing mid-history then resuming matches one uninterrupted run and an independent known total',async()=>{
  const h=history(), env={fetch:h.fetch,countTokens:count,limits:{interval:0}};
  const whole=await createScanner(C,env).scan(opts);
  const s=createScanner(C,env); h.arm();const interrupted=await s.scan(opts);
  assert.equal(interrupted.pages,2); assert.equal(interrupted.resumable,true); assert.equal(interrupted.reason,'network');
  const resumed=await s.scan({...opts,resume:true});assert.equal(resumed.status,'done');
  assert.deepEqual(resumed.stats,whole.stats);assert.equal(whole.stats.tokens,37);assert.equal(whole.stats.messages,6);
  const sliced=createScanner(C,{...env,limits:{interval:0,pages:1}});
  const partial=await sliced.scan(opts);assert.equal(partial.budgetType,'pages');
  assert.equal((await sliced.scan({...opts,resume:true})).pages,2);
  assert.deepEqual((await sliced.scan({...opts,resume:true})).stats,whole.stats);
});
for (const changed of [0,1]) test('reject modified '+(changed?'boundary':'head')+' rather than joining inconsistent history',async()=>{
  const h=history(),s=createScanner(C,{fetch:h.fetch,countTokens:count,limits:{interval:0,pages:2}});
  assert.equal((await s.scan(opts)).resumable,true);
  h.pages[changed][0].content.parts=['edited'];
  const r=await s.scan({...opts,resume:true});
  assert.equal(r.reason,'changed');assert.equal(r.stats.messages,0);assert.equal(r.resumable,false);
});

test('inline media in text is omitted before tokenization',()=>{
  const uri='data:image/png;'+'base64,'+'A'.repeat(400);
  const s=C.messageStats({content:{parts:['前'+uri+' 后']}},count);
  assert.equal(s.tokens,count('前 后'));assert.equal(s.omitted,true);assert.equal(C.text({parts:['A'.repeat(400)]}).length,400);
});
