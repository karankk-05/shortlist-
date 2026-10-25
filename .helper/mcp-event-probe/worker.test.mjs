import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.mjs';
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
function env() {
  const values = new Map();
  return { PROBE: { async put(k,v) { values.set(k,v); }, async get(k,type) { const v=values.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }, async list({prefix}) { return {keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))}; }, async delete(k) { values.delete(k); } }, values };
}
const request = () => new Request('https://probe.example/mcp', {method:'POST', body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'probe.ready',arguments:{test_id:'shortlist-check'},delivery:{mode:'webhook',url:'https://connectors.api.openai.com/test-callback',secret}}})});
test('verifies the challenge with a Standard Webhooks signature before storing a subscription', async () => {
  const state=env(), original=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    assert.equal(new URL(url).hostname,'connectors.api.openai.com');
    assert.equal(options.redirect,'manual');
    const expected=createHmac('sha256',Buffer.alloc(32,7)).update(options.headers['webhook-id']+'.'+options.headers['webhook-timestamp']+'.'+options.body).digest('base64');
    assert.equal(options.headers['webhook-signature'],'v1,'+expected);
    const body=JSON.parse(options.body); assert.equal(body.type,'verification');
    return Response.json({challenge:body.challenge});
  };
  try { const result=await (await worker.fetch(request(),state)).json(); assert.ok(result.result.id.startsWith('sub_')); assert.equal([...state.values.keys()].filter(k=>k.startsWith('sub:')).length,1); }
  finally { globalThis.fetch=original; }
});
test('records a rejected challenge without creating an active subscription', async()=>{
  const state=env(), original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({error:'rejected'}, {status:401});
  try { const result=await (await worker.fetch(request(),state)).json(); assert.equal(result.error.code,-32015); assert.equal([...state.values.keys()].filter(k=>k.startsWith('sub:')).length,0); const records=[...state.values.values()].map(JSON.parse); assert.equal(records.at(-1).status,401); }
  finally { globalThis.fetch=original; }
});
test('network diagnostics redact callback URLs and signing keys', async()=>{
  const state=env(), original=globalThis.fetch;
  globalThis.fetch=async()=>{throw new TypeError('Connection failed https://connectors.api.openai.com/private-path '+secret);};
  try { const result=await (await worker.fetch(request(),state)).json(); assert.equal(result.error.code,-32015); const records=[...state.values.values()].map(JSON.parse); assert.equal(records.at(-1).error.message,'Connection failed [callback] [secret]'); }
  finally { globalThis.fetch=original; }
});
test('refuses a callback redirect without creating a subscription', async()=>{
  const state=env(), original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(url,options)=>{calls++; assert.equal(options.redirect,'manual'); return new Response(null,{status:307,headers:{Location:'https://untrusted.example/callback'}});};
  try { const result=await (await worker.fetch(request(),state)).json(); assert.equal(result.error.code,-32015); assert.equal(calls,1); assert.equal([...state.values.keys()].filter(k=>k.startsWith('sub:')).length,0); const records=[...state.values.values()].map(JSON.parse); assert.equal(records.at(-1).error.message,'Callback redirects are not allowed.'); }
  finally { globalThis.fetch=original; }
});
