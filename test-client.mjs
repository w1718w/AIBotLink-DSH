// TEST_FIXTURE: minimal client for this package's ephemeral local Host tests.
// It trusts fixture records and does not duplicate production URL/token policy.
// Production transport validation is covered in the separate gateway repository.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export class HostRpcClient extends EventEmitter {
  controller = new AbortController();
  connection = randomUUID();
  nextId = 0;
  dead = false;
  get alive() { return !this.dead; }
  static async connect(file) {
    const record = JSON.parse(await readFile(file, 'utf8'));
    const client = new HostRpcClient(); client.url = record.url; client.token = record.token;
    const response = await fetch(`${client.url}/events`, { headers: client.headers(), signal: client.controller.signal, redirect: 'error' });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('无法连接测试服务'); }
    client.stream = client.events(response.body); return client;
  }
  headers() { return { Authorization: `Bearer ${this.token}`, 'X-AIBotLink-Connection': this.connection, 'Content-Type': 'application/json' }; }
  async events(body) {
    const decoder = new TextDecoder(); let buffer = '';
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true }); let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) { const event = JSON.parse(data); this.emit(event.id === undefined ? 'notification' : 'request', event); }
        }
      }
    } catch { /* Fixture stream abort is represented by the single closed event. */ }
    finally { this.end(); }
  }
  end() { if (!this.dead) { this.dead = true; this.controller.abort(); this.emit('closed', new Error('测试连接已断开')); } }
  async post(route, body, timeout = 2000) {
    if (this.dead) throw new Error('测试连接已断开');
    try {
      const response = await fetch(`${this.url}${route}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), redirect: 'error',
        signal: timeout ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout)]) : this.controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('测试请求失败'); }
      const value = await response.json();
      if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code });
      return value;
    } catch (error) { if (this.dead) throw new Error('测试连接已断开'); throw error; }
  }
  async call(method, params = {}, timeout = 2000) { return (await this.post('/rpc', { id: ++this.nextId, method, params }, timeout)).result; }
  async respond(id, result) { await this.post('/respond', { id, result }); }
  async reject(id, message) { await this.post('/respond', { id, error: { code: -32601, message } }); }
  async stop() { this.end(); await this.stream; }
}
