import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/main.mjs', import.meta.url), 'utf8');
const deployment = 'QmQUcPAEpUQJL3AYK21hsgNnj6XmWepTXJXySHdFXMmp7p';
const meta = { deployment, hasIndexingErrors: false, block: { number: 1, hash: '0x' + '1'.repeat(64) } };
const never = () => new Promise(() => {});

async function harness(mode, rows = []) {
  let clock = 1_800_000_000_000, fetches = 0;
  const signals = [], timers = new Set();
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ Date: Clock, AbortController,
    setTimeout(fn, delay) {
      const timer = setTimeout(() => { timers.delete(timer); clock += delay; fn(); }, 5);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async (_url, options) => {
      fetches++; signals.push(options.signal);
      assert.ok(options.signal instanceof AbortSignal);
      if (mode === 'fetch-stall') return never();
      return { ok: mode !== 'http-error', status: mode === 'http-error' ? 503 : 200,
        json: async () => {
          if (mode === 'body-stall') return never();
          if (mode === 'run-deadline') clock += 600_001;
          const request = JSON.parse(options.body);
          const page = request.query.includes("query Silos") ? rows.filter(r => !request.variables.cursor || r.id > request.variables.cursor).slice(0, 1000) : [];
          return mode === 'graph-error' ? { errors: [{ message: 'unavailable' }] } : { data: { _meta: meta, silos: page } };
        } };
    },
  });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw Error('Unexpected runtime dependency'); });
  await module.evaluate();
  return { run: module.namespace.returnTags, signals, timers, fetches: () => fetches };
}

for (const mode of ['fetch-stall', 'body-stall', 'http-error', 'graph-error', 'run-deadline']) {
  test('throws and releases its transport timer on ' + mode, { timeout: 1000 }, async () => {
    const h = await harness(mode);
    await assert.rejects(h.run('146', 'synthetic-query-capability'));
    assert.equal(h.fetches(), 1);
    assert.ok(h.signals[0].aborted);
    assert.equal(h.timers.size, 0);
  });
}
test('a complete empty source is returned only after its final seal', async () => {
  const h = await harness('healthy');
  assert.equal((await h.run('146', 'synthetic-query-capability')).length, 0);
  assert.equal(h.fetches(), 3);
  assert.ok(h.signals.every(signal => signal.aborted));
  assert.equal(h.timers.size, 0);
});
test('invalid chain or key fails before a request or timer', async () => {
  const h = await harness('healthy');
  await assert.rejects(h.run('1', 'synthetic-query-capability'));
  await assert.rejects(h.run('146', ''));
  assert.equal(h.fetches(), 0); assert.equal(h.timers.size, 0);
});

const addr = n => '0x' + n.toString(16).padStart(40, '0');
const row = n => ({id:addr(n),configAddress:addr(n),siloId:String(n),gaugeHookReceiver:addr(n+10000),market1:{id:addr(n+20000)},market2:{id:addr(n+30000)}});
test('only explicit no-receiver values are omitted, with every nonzero receiver retained', async () => {
 const rows = [row(1), {...row(2),gaugeHookReceiver:addr(0)},row(3)];
 const h = await harness('healthy', rows), tags = await h.run('146','synthetic-query-capability');
 assert.deepEqual(Array.from(tags,t=>t['Contract Address']),[addr(10001),addr(10003)].map(a=>'eip155:146:'+a));
 assert.ok(tags.every(t=>t['Public Note'].includes('Silo Finance')));
});
test('a zero receiver does not hide invalid source configuration metadata',async()=>{
 const h=await harness('healthy',[{...row(1),configAddress:addr(0),gaugeHookReceiver:addr(0)}]);
 await assert.rejects(h.run('146','synthetic-query-capability'),/Invalid Silo/);
});
test('all pages retain every nonzero receiver without using the page limit as a selection',async()=>{
 const h=await harness('healthy',Array.from({length:1002},(_,i)=>row(i+1)));
 const tags=await h.run('146','synthetic-query-capability');assert.equal(tags.length,1002);assert.equal(h.fetches(),4);
});
test('duplicate nonzero receivers fail rather than dropping a real source entry',async()=>{
 const a=row(1),h=await harness('healthy',[a,{...row(2),gaugeHookReceiver:a.gaugeHookReceiver}]);
 await assert.rejects(h.run('146','synthetic-query-capability'),/multiple source configurations/);
});
