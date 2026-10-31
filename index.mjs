// Native Host adapter based on the MIT-licensed dsh-im gateway/peer and
// interaction patterns (xmanrui/dsh-im 5.4.0). See LICENSE.dsh-im.
// This plugin never connects to QQ and never starts or stops the Desktop Host.
import http from 'node:http';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { PromptFailureTracker } from './prompt-failure-tracker.mjs';

const copy = JSON.parse(readFileSync(new URL('./locales/zh-CN.json', import.meta.url), 'utf8'));
const fail = (key, code = -32602) => Object.assign(new Error(copy[key]), { code });
const textOf = content => (content ?? []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
const selectionValue = (provider, model) => JSON.stringify([provider, model]);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export const name = 'aibotlink-dsh-companion';
export const inject = ['connection', 'typertGateway', 'sessionController'];

export async function apply(ctx, config = {}) {
  const bridge = await startBridge(ctx, config);
  ctx.effect(() => () => bridge.close());
  (typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger)?.info?.(copy.ready);
}

export async function startBridge(ctx, config = {}) {
  if (typeof ctx.typertGateway?.invoke !== 'function' || typeof ctx.connection?.createPeer !== 'function') throw fail('unavailable');
  const base = config.dataHome ?? process.env.BOTLINK_HOME ?? (process.platform === 'win32' ? path.join(homedir(), 'AppData/Local/AIBotLink') : path.join(homedir(), '.local/state/aibotlink'));
  if (!path.isAbsolute(base)) throw fail('invalid');
  for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) throw fail('invalidDataHome');
    if (dir === path.dirname(dir)) break;
  }
  const configFile = path.join(base, 'dsh-bridge.json');
  const token = randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  const runs = new Map(); const pending = new Map(); const disposers = []; const admissions = new Set();
  const calls = new AsyncLocalStorage();
  let subscriber; let closing = false;
  const assertConnection = () => { const caller = calls.getStore(); if (caller && caller !== subscriber) throw fail('disconnected'); };
  const invoke = (namespace, method, args = {}) => { assertConnection(); return ctx.typertGateway.invoke({ namespace, method, args, peer, signal: lifetime.signal }); };
  const emit = (method, params, id) => {
    if (!subscriber || subscriber.response.destroyed) throw fail('disconnected');
    // Bound the SSE buffer instead of allowing an unresponsive client to grow it.
    if (subscriber.response.writableLength > 4 * 1024 * 1024) { subscriber.response.destroy(); throw fail('disconnected'); }
    subscriber.response.write(`data: ${JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) })}\n\n`);
  };
  const update = (sessionId, value) => emit('session/update', { sessionId, update: value });
  const list = async () => (await invoke('session', 'list', { _request: {} })).items;
  const summary = async sessionId => {
    const row = (await list()).find(s => s.sessionId === sessionId);
    if (!row) throw fail('missing');
    if (row.origin === 'subagent') throw fail('unsupported');
    return row;
  };
  const idle = async sessionId => { if (runs.has(sessionId) || (await summary(sessionId)).running) throw fail('busy'); };
  const snapshot = async sessionId => {
    assertConnection();
    const controller = new AbortController(); let iterator;
    try {
      const source = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId }, maxMessages: 10 } }, peer,
        signal: AbortSignal.any([lifetime.signal, controller.signal]) });
      iterator = source[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value?.type !== 'snapshot' || first.value.header?.id !== sessionId) throw fail('missing');
      if (first.value.header.origin === 'subagent') throw fail('unsupported');
      return first.value;
    } finally { controller.abort(); await Promise.resolve(iterator?.return?.()).catch(() => {}); }
  };
  const sessionOptions = async sessionId => {
    const [catalog, row] = await Promise.all([invoke('session', 'modelCatalog'), summary(sessionId)]);
    const current = row.projections?.values?.modelSelection?.next ?? row.projections?.values?.modelSelection?.lastUsed ?? catalog.default;
    const groups = catalog.groups.map(g => ({ group: g.id, name: g.name, options: g.models.map(m => ({ value: selectionValue(g.id, m.id), name: m.name })) }));
    const model = catalog.groups.find(g => g.id === current.provider)?.models.find(m => m.id === current.model);
    return { sessionId, model: current.model, modelProvider: current.provider, reasoningEffort: current.reasoningEffort,
      configOptions: [
        { id: 'model', name: copy.model, type: 'select', category: 'model', currentValue: selectionValue(current.provider, current.model), options: groups },
        ...(model?.reasoning ? [{ id: 'reasoning', name: copy.reasoning, type: 'select', category: 'thought_level', currentValue: current.reasoningEffort ?? model.reasoning.defaultEffort,
          options: model.reasoning.efforts.map(e => ({ value: e.id, name: e.name })) }] : []),
      ] };
  };
  const command = async (sessionId, line) => {
    await idle(sessionId);
    // Public Host service: resume the Agent in this Host, keeping one native writer.
    await ctx.sessionController.resolveAgent(sessionId);
    const commands = await invoke('commands', 'list', { agentId: sessionId });
    if (!commands.some(c => c.name === line.slice(1).split(' ')[0])) throw fail('unsupported');
    const result = await invoke('commands', 'execute', { agentId: sessionId, line, submittedAttachments: [] });
    if (!result || result.result?.kind === 'error') throw new Error(result?.result?.text ?? copy.unsupported);
    return result;
  };
  const permissions = async sessionId => {
    const [catalog, projection] = await Promise.all([invoke('permissionPresets', 'catalog'), invoke('session', 'projections', { request: { sessionId } })]);
    if (!projection?.values?.permissions || !Array.isArray(catalog.options)) throw fail('unsupported');
    return { currentValue: projection.values.permissions.currentValue, options: catalog.options };
  };
  const settleInteractions = (sessionId, error) => {
    for (const [id, interaction] of pending) if (!sessionId || interaction.sessionId === sessionId) {
      pending.delete(id); interaction.withdraw(error);
    }
  };
  const finish = (sessionId, error, stopReason = 'end_turn') => {
    const run = runs.get(sessionId); if (!run) return;
    runs.delete(sessionId); run.closeWatch?.(); settleInteractions(sessionId, fail('interactionExpired'));
    if (error) run.reject(error); else {
      // Canonical final text replaces streamed preambles and tool-boundary text.
      try { update(sessionId, { sessionUpdate: 'agent_message_final', text: run.final || run.delta }); run.resolve({ stopReason, text: run.final || run.delta }); }
      catch (deliveryError) { run.reject(deliveryError); }
    }
  };
  const sessionEvent = (session, event) => {
    const id = session?.id; const run = runs.get(id); if (!run) return;
    try {
      if (!Number.isSafeInteger(event.seq) || event.seq <= run.lastSeq) return;
      run.lastSeq = event.seq;
      const d = event.data ?? {}; const failedTurn = run.failure.consume(event);
      // DSH admits a prompt through the durable inbox and starts the turn before
      // the user/message record is appended; that record does not carry `turn`.
      // Claim only this request's exact rpcId, never a guessed turn.
      const claimed = (event.type === 'user/message' && run.requestIds.has(d.source?.rpcId))
        || (event.type === 'agent/inbox/spliced' && (d.inserted ?? []).some(message => run.requestIds.has(message?.source?.rpcId)));
      if (claimed) {
        run.admitted = true;
        if (Number.isSafeInteger(d.turn)) run.turn = d.turn;
        else if (run.turn === undefined && Number.isSafeInteger(run.recentTurn) && run.recentTurnTime >= run.createdAt) run.turn = run.recentTurn;
      }
      if (event.type === 'turn/start' && Number.isSafeInteger(d.turn)) {
        run.recentTurn = d.turn; run.recentTurnTime = Number.isSafeInteger(event.time) ? event.time : Date.now();
        if (run.admitted && run.turn === undefined) run.turn = d.turn;
      }
      if (event.type === 'turn/end' && failedTurn !== null && d.turn === failedTurn) { finish(id, fail('failed')); return; }
      if (run.turn === undefined || d.turn !== run.turn) return;
      if (event.type === 'assistant/chunk' && d.chunk?.type === 'text-delta') {
        run.delta += d.chunk.text; update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: d.chunk.text } });
      }
      if (event.type === 'assistant/message') {
        const content = d.message?.content ?? [];
        run.final = content.some(p => p.type === 'tool-call') ? '' : textOf(content);
      }
      if (event.type === 'tool/call') { run.final = ''; run.delta = ''; update(id, { sessionUpdate: 'tool_call', title: d.name }); }
      if (event.type === 'turn/end') {
        const reason = typeof d.reason === 'string' ? d.reason : d.reason?.kind;
        if (reason === 'completed') finish(id);
        else if (reason === 'cancelled' || reason === 'interrupted') finish(id, undefined, 'cancelled');
        else finish(id, fail('failed'));
      }
    } catch (error) { finish(id, error); }
  };
  disposers.push(ctx.on('session/event', sessionEvent, { global: true }));

  // Forward only interactions proved to belong to our exact accepted input.
  // Native Desktop answerers stay available; the first valid answer wins.
  const interaction = async (kind, request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id;
    const run = runs.get(sessionId);
    if (run && run.turn === undefined) {
      const session = request.agent?.session;
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events;
      if (Array.isArray(events)) for (const event of events) sessionEvent({ id: sessionId }, event);
    }
    if (!subscriber || run?.turn === undefined) return next();
    const id = randomUUID(); const controller = new AbortController();
    const outer = request.signal;
    const abort = () => controller.abort(outer?.reason);
    outer?.addEventListener('abort', abort, { once: true });
    request.signal = controller.signal;
    let resolveIm, rejectIm;
    const im = new Promise((resolve, reject) => { resolveIm = resolve; rejectIm = reject; });
    const onAbort = () => rejectIm(fail('interactionExpired'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    let imAvailable = true; let nativeAvailable = true;
    const withdraw = error => { imAvailable = false; if (!nativeAvailable) rejectIm(error); };
    pending.set(id, { sessionId, kind, request, connection: subscriber.id, resolve: resolveIm, reject: rejectIm, withdraw });
    let viaIm = false;
    try {
      if (outer?.aborted) throw fail('interactionExpired');
      if (kind === 'approval') emit('session/request_permission', { sessionId, toolCall: { title: request.toolName, rawInput: request.reason }, options: [
        { optionId: 'allow', name: copy.allow, kind: 'allow_once' }, { optionId: 'decline', name: copy.decline, kind: 'reject_once' },
      ] }, id);
      else emit('item/tool/requestUserInput', { sessionId, questions: request.questions.map(q => ({ ...q, question: q.question })) }, id);
      const native = Promise.resolve().then(next).then(value => {
        if (kind === 'approval' && !['allowed-once', 'rejected'].includes(value)) {
          nativeAvailable = false; if (!imAvailable) throw fail('interactionExpired');
          return new Promise(() => {});
        }
        return value;
      }, error => { nativeAvailable = false; if (!imAvailable) throw error; return new Promise(() => {}); });
      return await Promise.race([native, im.then(value => { viaIm = true; return value; })]);
    } finally {
      pending.delete(id); outer?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      if (viaIm) controller.abort(Object.assign(fail('interactionExpired'), { code: 'ASK_ABORTED' }));
      request.signal = outer;
      try { if (subscriber) emit('serverRequest/resolved', { sessionId, requestId: id }); } catch { /* A settled native answer remains valid when delivery fails. */ }
    }
  };
  disposers.push(ctx.on('approval/request', (r, next) => interaction('approval', r, next), { global: true, prepend: true }));
  disposers.push(ctx.on('user-questions/request', (r, next) => interaction('question', r, next), { global: true, prepend: true }));

  const dispatch = async (method, p) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, fork: {} }, aibotlinkHost: true } };
    if (method === 'session/new') {
      if (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd)) throw fail('invalid');
      const created = await invoke('session', 'create', { request: { cwd: p.cwd } });
      return sessionOptions(created.sessionId);
    }
    if (method === 'session/list') return { sessions: (await list()).filter(s => (!p.cwd || samePath(s.cwd, p.cwd)) && s.origin !== 'subagent').map(s => ({ sessionId: s.sessionId, title: s.title ?? s.sessionId })) };
    if (typeof p.sessionId !== 'string' || !p.sessionId) throw fail('invalid');
    const id = p.sessionId;
    switch (method) {
      case 'session/resume': await snapshot(id); return sessionOptions(id);
      case 'session/fork': {
        await idle(id); const child = await invoke('session', 'fork', { request: { sessionId: id } });
        return sessionOptions(child.sessionId);
      }
      case 'session/history': {
        const frame = await snapshot(id);
        // DSH records injected instructions and runtime context as user/message
        // events. /history shows only real user input and assistant replies.
        const text = frame.records
          .filter(r => r.type === 'event' && ['user/message', 'assistant/message'].includes(r.event?.type))
          .map(r => {
            const data = r.event.data ?? {};
            if (r.event.type === 'user/message' && data.source?.kind && data.source.kind !== 'user') return '';
            const content = textOf(data.content ?? data.message?.content);
            if (!content) return '';
            const role = r.event.type === 'user/message' ? copy.historyUser : copy.historyAssistant;
            return `${role}：\n${content}`;
          })
          .filter(Boolean).join('\n\n');
        return { text };
      }
      case 'session/set_config_option': {
        await idle(id); const options = await sessionOptions(id);
        const modelOption = options.configOptions[0]; let provider, model, reasoningEffort;
        if (p.configId === 'model') {
          if (!modelOption.options.some(g => g.options.some(m => m.value === p.value))) throw fail('modelMissing');
          [provider, model] = JSON.parse(p.value);
        } else if (p.configId === 'reasoning') {
          if (!options.configOptions.find(o => o.id === 'reasoning')?.options.some(o => o.value === p.value)) throw fail('modelMissing');
          [provider, model] = JSON.parse(modelOption.currentValue); reasoningEffort = p.value;
        } else throw fail('invalid');
        await invoke('session', 'selectModel', { request: { sessionId: id, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } });
        return sessionOptions(id);
      }
      case 'session/permissions': return permissions(id);
      case 'session/set_permission': {
        if (!(await permissions(id)).options.some(o => o.value === p.mode)) throw fail('invalid');
        await command(id, `/permission ${p.mode}`); return { session: id, ...(await permissions(id)) };
      }
      case 'session/compact': return command(id, '/compact');
      case 'session/cancel':
        if (!runs.has(id)) throw fail('busy');
        return invoke('session', 'cancel', { request: { sessionId: id } });
      case 'session/steer': {
        const run = runs.get(id); if (!run || run.turn === undefined || typeof p.text !== 'string' || !p.text.trim()) throw fail('busy');
        const requestId = randomUUID(); run.requestIds.add(requestId);
        return invoke('session', 'prompt', { request: { requestId, sessionId: id, mode: 'steer', content: [{ type: 'text', text: p.text }] } });
      }
      case 'session/prompt': {
        await idle(id);
        if (!Array.isArray(p.prompt) || p.prompt.length !== 1 || p.prompt[0].type !== 'text' || typeof p.prompt[0].text !== 'string' || !p.prompt[0].text.trim()) throw fail('invalid');
        const requestId = randomUUID(); const controller = new AbortController(); let iterator;
        assertConnection();
        const source = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow',
          args: { request: { address: { kind: 'session', sessionId: id }, maxMessages: 1 } }, peer,
          signal: AbortSignal.any([lifetime.signal, controller.signal]) });
        iterator = source[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || first.value?.type !== 'snapshot') { controller.abort(); await iterator.return?.(); throw fail('missing'); }
        const before = first.value;
        const completed = new Promise((resolve, reject) => {
          runs.set(id, { resolve, reject, requestIds: new Set([requestId]), delta: '', final: '', lastSeq: before.cursor,
            admitted: false, createdAt: Date.now(), recentTurn: undefined, recentTurnTime: 0,
            failure: new PromptFailureTracker(requestId, before.cursor),
            closeWatch: () => { controller.abort(); void Promise.resolve(iterator.return?.()).catch(() => {}); },
          });
        });
        // Attach a handler before native admission: some Hosts finish synchronously.
        void completed.catch(() => {});
        // The native follow contract supplies gap-free durable events. Global
        // Cordis events can arrive first; sequence deduplication unifies both.
        void (async () => {
          try {
            while (!controller.signal.aborted && runs.has(id)) {
              const next = await iterator.next();
              if (next.done) { if (runs.has(id)) finish(id, fail('disconnected')); break; }
              if (next.value?.type === 'event') sessionEvent({ id }, next.value.event);
            }
          } catch (error) { if (!controller.signal.aborted && runs.has(id)) finish(id, error); }
        })();
        try { await invoke('session', 'prompt', { request: { requestId, sessionId: id, mode: 'queue', content: p.prompt } }); }
        catch (error) { finish(id, error); }
        return completed;
      }
      default: throw fail('unsupported', -32601);
    }
  };
  const respond = (body, connection) => {
    const item = pending.get(body.id);
    if (!item || item.connection !== connection) throw fail('interactionExpired');
    if (body.error) { pending.delete(body.id); item.reject(fail('interactionExpired')); return; }
    let value;
    if (item.kind === 'approval') {
      const choice = body.result?.outcome;
      if (choice?.outcome !== 'selected' || !['allow', 'decline'].includes(choice.optionId)) throw fail('invalid');
      value = choice.optionId === 'allow' ? 'allowed-once' : 'rejected';
    } else {
      value = { answers: item.request.questions.map(q => {
        const answer = body.result?.answers?.[q.id]?.answers;
        if (!Array.isArray(answer) || answer.some(s => typeof s !== 'string') || !answer.length) throw fail('invalid');
        const labels = new Set(q.options?.map(o => o.label) ?? []);
        const selected = answer.filter(s => labels.has(s)); const custom = answer.filter(s => !labels.has(s));
        if (!q.multiSelect && selected.length + custom.length !== 1) throw fail('invalid');
        return { id: q.id, selected, ...(custom.length ? { custom: custom.join('\n') } : {}) };
      }) };
    }
    pending.delete(body.id); item.resolve(value);
  };

  const authorized = req => {
    const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    return !req.headers.origin && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const json = (res, status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const disconnect = id => {
    if (subscriber?.id !== id) return;
    subscriber = undefined;
    // Leave native tasks alone; the disconnected gateway marks outcomes unknown.
    for (const sessionId of [...runs.keys()]) finish(sessionId, fail('disconnected'));
    settleInteractions(undefined, fail('disconnected'));
  };
  const server = http.createServer((req, res) => { void (async () => {
    if (!authorized(req)) { json(res, 401, {}); return; }
    const connection = req.headers['x-aibotlink-connection'];
    if (typeof connection !== 'string' || !/^[a-f0-9-]{36}$/i.test(connection)) { json(res, 400, {}); return; }
    if (req.url === '/events' && req.method === 'GET') {
      if (subscriber) { json(res, 409, {}); return; }
      subscriber = { id: connection, response: res };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.flushHeaders(); res.write(': ready\n\n');
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000); heartbeat.unref();
      res.on('close', () => { clearInterval(heartbeat); disconnect(connection); }); return;
    }
    if (req.method !== 'POST' || !['/rpc', '/respond'].includes(req.url)) { json(res, 404, {}); return; }
    if (!subscriber || subscriber.id !== connection) { json(res, 409, {}); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) { json(res, 413, {}); req.destroy(); return; } }
    let body; try { body = JSON.parse(raw); } catch { json(res, 400, {}); return; }
    try {
      if (req.url === '/respond') { respond(body, connection); json(res, 200, {}); return; }
      if (typeof body.method !== 'string' || !body.params || typeof body.params !== 'object') throw fail('invalid');
      const caller = subscriber;
      if (!caller || caller.id !== connection) throw fail('disconnected');
      const mutating = ['session/prompt', 'session/fork', 'session/set_config_option', 'session/set_permission', 'session/compact'].includes(body.method);
      const sessionId = body.params.sessionId;
      if (mutating && admissions.has(sessionId)) throw fail('busy');
      if (mutating) admissions.add(sessionId);
      let result;
      try { result = await calls.run(caller, () => dispatch(body.method, body.params)); }
      finally { if (mutating) admissions.delete(sessionId); }
      json(res, 200, { ...(body.id === undefined ? {} : { id: body.id }), result: result ?? {} });
    } catch (error) {
      json(res, 200, { ...(body.id === undefined ? {} : { id: body.id }), error: { code: typeof error.code === 'number' ? error.code : -32603,
        message: error.message ?? copy.failed, data: { nativeCode: error.failure?.code ?? error.code } } });
    }
  })().catch(() => { json(res, 500, {}); }); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const record = { version: 1, url: `http://127.0.0.1:${server.address().port}`, token };
    await mkdir(base, { recursive: true, mode: 0o700 });
    const temp = `${configFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, configFile);
    return { configFile, async close() {
      if (closing) return; closing = true; lifetime.abort();
      for (const sessionId of [...runs.keys()]) finish(sessionId, fail('disconnected'));
      settleInteractions(undefined, fail('disconnected')); subscriber?.response.end(); subscriber = undefined;
      for (const dispose of disposers) if (typeof dispose === 'function') await dispose();
      await peer.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      try { if (JSON.parse(await readFile(configFile, 'utf8')).token === token) await unlink(configFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } };
  } catch (error) {
    lifetime.abort(); for (const dispose of disposers) if (typeof dispose === 'function') await dispose(); await peer.dispose(); server.close(); throw error;
  }
}
