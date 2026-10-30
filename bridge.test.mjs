import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBridge } from './index.mjs';

// TEST_ONLY integration: use the gateway's real built client when available.
// An independent Companion checkout still exercises its server with a fixture.
const gatewayRoot = process.env.AILINKBRIDGE_GATEWAY || fileURLToPath(new URL('../gateway/', import.meta.url));
let realGateway = false;
try { await Promise.all(['host-rpc.js', 'agent.js'].map(file => access(path.join(gatewayRoot, 'dist', file)))); realGateway = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const { HostRpcClient } = await import(realGateway ? pathToFileURL(path.join(gatewayRoot, 'dist/host-rpc.js')).href : './test-client.mjs');
const NativeAgent = realGateway ? (await import(pathToFileURL(path.join(gatewayRoot, 'dist/agent.js')).href)).NativeAgent : undefined;

// TEST_FIXTURE: in-memory native Host services plus a real ephemeral loopback
// HTTP/SSE transport. No Desktop process, native model, QQ bot or account is used.
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aibotlink-companion-'));
  const calls = []; const listeners = new Map(); const events = new EventEmitter();
  const gates = {};
  const rows = new Map([['existing', { sessionId: 'existing', cwd: root, title: 'existing', running: false }]]);
  const cursors = new Map(); let nextId = 0; let disposed = false; let clients = [];
  const catalog = { default: { provider: 'native', model: 'default-model', reasoningEffort: 'high' }, groups: [
    { id: 'native', name: 'Native', models: [{ id: 'default-model', name: 'Default', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }, { id: 'other', name: 'Other' }] },
  ] };
  let permission = 'read-only';
  const ctx = {
    connection: { createPeer(options) { calls.push({ peer: options }); return { async dispose() { disposed = true; } }; } },
    sessionController: { async resolveAgent(id) { calls.push({ resolveAgent: id }); return {}; } },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    typertGateway: {
      async invoke({ namespace, method, args, signal }) {
        assert.equal(signal.aborted, false); calls.push({ namespace, method, args });
        if (namespace === 'session' && method === 'list') return { items: [...rows.values()] };
        if (namespace === 'session' && method === 'create') {
          const sessionId = `new-${++nextId}`; rows.set(sessionId, { sessionId, cwd: args.request.cwd, running: false }); return { sessionId };
        }
        if (namespace === 'session' && method === 'modelCatalog') return catalog;
        if (namespace === 'session' && method === 'selectModel') {
          const { sessionId, provider, model, reasoningEffort } = args.request;
          rows.get(sessionId).projections = { values: { modelSelection: { next: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } } } }; return {};
        }
        if (namespace === 'session' && method === 'prompt') { events.emit('prompt', args.request); return {}; }
        if (namespace === 'session' && method === 'fork') {
          const sessionId = `branch-${++nextId}`; rows.set(sessionId, { ...rows.get(args.request.sessionId), sessionId }); return { sessionId };
        }
        if (namespace === 'session' && method === 'projections') return { values: { permissions: { currentValue: permission } } };
        if (namespace === 'permissionPresets' && method === 'catalog') return { options: [{ value: 'read-only' }, { value: 'workspace-write' }] };
        if (namespace === 'commands' && method === 'list') return [{ name: 'compact' }, { name: 'permission' }];
        if (namespace === 'commands' && method === 'execute') {
          if (args.line.startsWith('/permission ')) permission = args.line.slice('/permission '.length);
          return { result: { kind: 'text', text: 'native result' } };
        }
        if (namespace === 'session' && method === 'cancel') return {};
        throw new Error(`Unexpected fake service: ${namespace}/${method}`);
      },
      async *stream({ namespace, method, args, signal }) {
        assert.equal(namespace, 'session'); assert.equal(method, 'follow'); assert.equal(signal.aborted, false);
        const id = args.request.address.sessionId;
        calls.push({ namespace, method, args });
        if (gates.follow) await gates.follow();
        const queue = []; let wake;
        const notify = () => { wake?.(); wake = undefined; };
        const onEvent = frame => { if (frame.id === id) { queue.push({ type: 'event', event: frame.event }); notify(); } };
        events.on('session-stream', onEvent); signal.addEventListener('abort', notify, { once: true });
        try {
          // Subscribe before the snapshot so an event between first next() and
          // the consumer's next read remains queued, matching native follow.
          yield { type: 'snapshot', header: { id, origin: 'root' }, cursor: cursors.get(id) ?? 0, records: [
            { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: 'stored user' }] } } },
            { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stored assistant' }] } } } },
          ] };
          while (!signal.aborted) {
            if (queue.length) yield queue.shift();
            else await new Promise(resolve => { wake = resolve; });
          }
        } finally { events.off('session-stream', onEvent); signal.removeEventListener('abort', notify); }
      },
    },
  };
  const bridge = await startBridge(ctx, { dataHome: root });
  const record = JSON.parse(await readFile(bridge.configFile, 'utf8'));
  const connect = async () => { const client = await HostRpcClient.connect(bridge.configFile); clients.push(client); return client; };
  const emit = (type, data = {}, id = 'existing') => {
    const seq = (cursors.get(id) ?? 0) + 1; cursors.set(id, seq);
    const event = { seq, type, data };
    events.emit('session-stream', { id, event });
    if (gates.globalEvents !== false) listeners.get('session/event')?.({ id }, event);
  };
  return { calls, ctx, events, root, record, configFile: bridge.configFile, connect, emit, listeners, gates,
    async close() {
      for (const client of clients) await client.stop();
      await bridge.close(); assert.equal(disposed, true); assert.equal(listeners.size, 0);
      assert.equal(events.listenerCount('session-stream'), 0);
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
    } };
}
const event = (client, name, predicate = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { client.off(name, listener); reject(new Error(`Missing event: ${name}`)); }, 2000);
  const listener = value => { if (predicate(value)) { clearTimeout(timer); client.off(name, listener); resolve(value); } };
  client.on(name, listener);
});

test('NativeAgent completes through Companion native follow when global Cordis events are unavailable', { skip: !realGateway && 'Build the sibling gateway or set AILINKBRIDGE_GATEWAY to enable integration' }, async () => {
  const f = await fixture(); f.gates.globalEvents = false;
  const agent = new NativeAgent('dsh', { type: 'dsh', cwd: f.root, dshBridge: f.configFile });
  try {
    await agent.attach('existing');
    const admitted = once(f.events, 'prompt', { signal: AbortSignal.timeout(2000) });
    const done = event(agent, 'event', e => ['done', 'failed'].includes(e.kind));
    await agent.send('existing', 'test only', {});
    const [input] = await admitted;
    f.emit('user/message', { source: { rpcId: 'desktop-request' }, turn: 4 });
    f.emit('assistant/chunk', { turn: 4, chunk: { type: 'text-delta', text: 'desktop-only' } });
    f.emit('turn/end', { turn: 4, reason: 'completed' });
    f.emit('user/message', { source: { rpcId: input.requestId }, turn: 5 });
    f.emit('assistant/chunk', { turn: 5, chunk: { type: 'text-delta', text: 'streamed preamble' } });
    f.emit('assistant/message', { turn: 5, message: { content: [{ type: 'text', text: 'canonical bridge final' }] } });
    f.emit('turn/end', { turn: 5, reason: 'completed' });
    const terminal = await done;
    assert.equal(terminal.kind, 'done'); assert.equal(terminal.text, 'canonical bridge final');
    assert.equal(terminal.session, 'existing'); assert.equal(agent.runs.size, 0);
    assert.equal(f.calls.filter(c => c.method === 'create').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1);
  } finally { await agent.stop(); await f.close(); }
});
async function startPrompt(f, client) {
  const admitted = once(f.events, 'prompt', { signal: AbortSignal.timeout(2000) });
  const completion = client.call('session/prompt', { sessionId: 'existing', prompt: [{ type: 'text', text: 'test input' }] }, 0);
  // Attach rejection handling before emitting synchronous failure events.
  void completion.catch(() => {});
  const [input] = await admitted; return { input, completion };
}

test('Companion reuses existing sessions, exposes native defaults and forwards fork/history/permission controls', async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    const initialized = await client.call('initialize'); assert.equal(initialized.agentCapabilities.aibotlinkHost, true);
    const resumed = await client.call('session/resume', { sessionId: 'existing' });
    assert.equal(resumed.model, 'default-model'); assert.equal(resumed.modelProvider, 'native');
    assert.equal(f.calls.filter(c => c.method === 'create').length, 0);
    const created = await client.call('session/new', { cwd: f.root }); assert.match(created.sessionId, /^new-/);
    assert.equal(f.calls.filter(c => c.method === 'create').length, 1);
    assert.deepEqual(f.calls.find(c => c.method === 'create').args, { request: { cwd: f.root } });
    const selected = await client.call('session/set_config_option', { sessionId: 'existing', configId: 'reasoning', value: 'low' });
    assert.equal(selected.reasoningEffort, 'low');
    await assert.rejects(client.call('session/set_config_option', { sessionId: 'existing', configId: 'model', value: '["missing","fake"]' }), /目录/);
    assert.equal(f.calls.filter(c => c.method === 'selectModel').length, 1);
    const fork = await client.call('session/fork', { sessionId: 'existing' }); assert.match(fork.sessionId, /^branch-/);
    assert.deepEqual(f.calls.find(c => c.method === 'fork').args, { request: { sessionId: 'existing' } });
    assert.equal((await client.call('session/history', { sessionId: 'existing' })).text, 'stored user\n\nstored assistant');
    const changed = await client.call('session/set_permission', { sessionId: 'existing', mode: 'workspace-write' });
    assert.equal(changed.currentValue, 'workspace-write');
    await client.call('session/compact', { sessionId: 'existing' });
    assert.deepEqual(f.calls.filter(c => c.namespace === 'commands' && c.method === 'execute').map(c => c.args.line), ['/permission workspace-write', '/compact']);
    assert.equal(f.calls.filter(c => c.resolveAgent === 'existing').length, 2);
  } finally { await f.close(); }
});

test('Companion prompt ownership filters Desktop turns and emits only the canonical gateway final', async () => {
  const f = await fixture();
  try {
    const client = await f.connect(); const updates = []; client.on('notification', e => updates.push(e));
    const { input, completion } = await startPrompt(f, client);
    f.emit('user/message', { source: { rpcId: 'desktop' }, turn: 5 });
    f.emit('assistant/chunk', { turn: 5, chunk: { type: 'text-delta', text: 'unrelated reply' } });
    f.emit('turn/end', { turn: 5, reason: 'completed' });
    f.emit('user/message', { source: { rpcId: input.requestId }, turn: 6 });
    f.emit('assistant/chunk', { turn: 5, chunk: { type: 'text-delta', text: 'late unrelated reply' } });
    f.emit('assistant/chunk', { turn: 6, chunk: { type: 'text-delta', text: 'preamble' } });
    f.emit('tool/call', { turn: 6, name: 'test tool' });
    f.emit('assistant/message', { turn: 6, message: { content: [{ type: 'text', text: 'canonical final' }] } });
    const final = event(client, 'notification', e => e.params.update?.sessionUpdate === 'agent_message_final');
    f.emit('turn/end', { turn: 6, reason: 'completed' });
    assert.equal((await completion).stopReason, 'end_turn'); assert.equal((await final).params.update.text, 'canonical final');
    assert.ok(!JSON.stringify(updates).includes('unrelated reply'));
    assert.equal(updates.filter(e => e.params.update?.sessionUpdate === 'agent_message_chunk').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1);
  } finally { await f.close(); }
});

test('Companion attributes pre-message failures through exact durable inbox claims', async () => {
  const f = await fixture(); f.gates.globalEvents = false;
  try {
    const client = await f.connect(); const { input, completion } = await startPrompt(f, client);
    let settled = false; void completion.finally(() => { settled = true; }).catch(() => {});
    f.emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source: { rpcId: 'desktop' } }], removedCount: 0 });
    f.emit('turn/start', { turn: 1 });
    f.emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [], removedCount: 1 });
    f.emit('turn/end', { turn: 1, reason: 'failed' });
    await client.call('session/list'); assert.equal(settled, false);
    f.emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source: { rpcId: input.requestId } }], removedCount: 0 });
    f.emit('turn/start', { turn: 2 });
    f.emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [], removedCount: 1 });
    f.emit('turn/end', { turn: 2, reason: 'failed' });
    await assert.rejects(completion, /原生任务失败/);
  } finally { await f.close(); }
});

test('Companion approvals race Desktop answers, reject expired tokens and never auto-allow', async () => {
  const f = await fixture();
  try {
    const client = await f.connect(); const { input, completion } = await startPrompt(f, client);
    const handler = f.listeners.get('approval/request');
    const request = signal => ({ agent: { session: { id: 'existing' } }, toolName: 'test', reason: 'local fixture', signal });
    // Admission alone grants no live-turn approval ownership.
    assert.equal(await handler(request(), () => 'rejected'), 'rejected');
    f.emit('user/message', { source: { rpcId: input.requestId }, turn: 3 });
    let desktopAnswer; let nativeSignal; const desktop = new Promise(resolve => { desktopAnswer = resolve; });
    const incoming = event(client, 'request'); const nativeRequest = request();
    const outcome = handler(nativeRequest, () => { nativeSignal = nativeRequest.signal; return desktop; }); let allowed = false; void outcome.then(() => { allowed = true; });
    const approval = await incoming; await client.call('session/list'); assert.equal(allowed, false);
    await client.respond(approval.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
    assert.equal(await outcome, 'allowed-once'); assert.equal(nativeSignal.aborted, true); assert.equal(nativeRequest.signal, undefined);
    desktopAnswer('rejected');
    await assert.rejects(client.respond(approval.id, { outcome: { outcome: 'selected', optionId: 'allow' } }), /已结束/);

    let resolveDesktop; const nextDesktop = new Promise(resolve => { resolveDesktop = resolve; });
    const request2 = event(client, 'request'); const desktopWins = handler(request(), () => nextDesktop);
    const approval2 = await request2; resolveDesktop('rejected'); assert.equal(await desktopWins, 'rejected');
    await assert.rejects(client.respond(approval2.id, { outcome: { outcome: 'selected', optionId: 'allow' } }), /已结束/);

    const controller = new AbortController(); const request3 = event(client, 'request');
    const expired = handler(request(controller.signal), () => new Promise(() => {})); void expired.catch(() => {});
    const approval3 = await request3; controller.abort(); await assert.rejects(expired, /已结束/);
    await assert.rejects(client.respond(approval3.id, { outcome: { outcome: 'selected', optionId: 'allow' } }), /已结束/);

    const questionEvent = event(client, 'request', e => e.method === 'item/tool/requestUserInput');
    const questions = f.listeners.get('user-questions/request')({ ...request(), questions: [{ id: 'q', question: 'Test?', options: [{ label: 'Choice' }], multiSelect: false }] }, () => new Promise(() => {}));
    const question = await questionEvent;
    await client.respond(question.id, { answers: { q: { answers: ['custom answer'] } } });
    assert.deepEqual(await questions, { answers: [{ id: 'q', selected: [], custom: 'custom answer' }] });
    const final = event(client, 'notification', e => e.params.update?.sessionUpdate === 'agent_message_final');
    f.emit('assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'done' }] } });
    f.emit('turn/end', { turn: 3, reason: 'completed' }); await completion; await final;
  } finally { await f.close(); }
});

test('Companion permits one authenticated client and disconnect never cancels a native task', async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await assert.rejects(HostRpcClient.connect(path.join(f.root, 'dsh-bridge.json')), /无法连接/);
    const denied = await fetch(`${f.record.url}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer invalid', 'X-AIBotLink-Connection': '11111111-1111-1111-1111-111111111111' }, body: '{}' });
    assert.equal(denied.status, 401);
    const wrongConnection = await fetch(`${f.record.url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${f.record.token}`, 'X-AIBotLink-Connection': '11111111-1111-1111-1111-111111111111' }, body: '{}' });
    assert.equal(wrongConnection.status, 409);
    const { completion } = await startPrompt(f, client);
    const disconnected = assert.rejects(completion, /断开/); await client.stop(); await disconnected;
    assert.equal(f.calls.filter(c => c.method === 'cancel').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1);
  } finally { await f.close(); }
});

test('Companion reserves prompt admission before async snapshots and rejects concurrent mutation', async () => {
  const f = await fixture(); let releaseSnapshot;
  try {
    const client = await f.connect();
    let snapshotEntered; const entered = new Promise(resolve => { snapshotEntered = resolve; });
    const release = new Promise(resolve => { releaseSnapshot = resolve; });
    f.gates.follow = async () => { snapshotEntered(); await release; };
    const admitted = once(f.events, 'prompt', { signal: AbortSignal.timeout(2000) });
    const prompt = client.call('session/prompt', { sessionId: 'existing', prompt: [{ type: 'text', text: 'first' }] }, 0); void prompt.catch(() => {});
    await entered;
    await assert.rejects(client.call('session/prompt', { sessionId: 'existing', prompt: [{ type: 'text', text: 'second' }] }, 0), /正在执行/);
    await assert.rejects(client.call('session/fork', { sessionId: 'existing' }), /正在执行/);
    releaseSnapshot(); const [input] = await admitted;
    f.emit('user/message', { source: { rpcId: input.requestId }, turn: 1 });
    const final = event(client, 'notification', e => e.params.update?.sessionUpdate === 'agent_message_final');
    f.emit('turn/end', { turn: 1, reason: 'completed' }); await prompt; await final;
    assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1); assert.equal(f.calls.filter(c => c.method === 'fork').length, 0);
  } finally { releaseSnapshot?.(); await f.close(); }
});

test('disconnect withdraws the IM approval leg while a native Desktop answer remains valid', async () => {
  const f = await fixture();
  try {
    const client = await f.connect(); const { input, completion } = await startPrompt(f, client);
    f.emit('user/message', { source: { rpcId: input.requestId }, turn: 7 });
    let answer; let nativeSignal;
    const desktop = new Promise(resolve => { answer = resolve; });
    const nativeRequest = { agent: { session: { id: 'existing' } }, toolName: 'test', reason: 'fixture' };
    const request = event(client, 'request');
    const result = f.listeners.get('approval/request')(nativeRequest, () => { nativeSignal = nativeRequest.signal; return desktop; });
    void result.catch(() => {}); await request;
    const disconnected = assert.rejects(completion, /断开/);
    await client.stop(); await disconnected;
    // A new accepted subscriber proves the old server-side disconnect ran.
    const replacement = await f.connect(); await replacement.call('session/list');
    assert.equal(nativeSignal.aborted, false);
    answer('allowed-once'); assert.equal(await result, 'allowed-once');
    assert.equal(nativeRequest.signal, undefined);
    assert.equal(f.calls.filter(c => c.method === 'cancel').length, 0);
  } finally { await f.close(); }
});
