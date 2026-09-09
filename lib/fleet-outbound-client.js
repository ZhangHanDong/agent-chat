import { setTimeout as delay } from 'node:timers/promises';
import { normalizeOutboundTransport } from './fleet-outbound-config.js';

/** Only initiates outbound HTTP. All side effects use the existing authenticated bridge adapters. */
export class FleetOutboundClient {
  constructor({ fleetId, transport, store, transaction, protocol, fetchImpl = fetch, warning = () => {}, intervalMs = 15000 }) {
    this.fleetId = fleetId; this.transport = normalizeOutboundTransport(transport, fleetId);
    this.store = store; this.transaction = transaction; this.protocol = protocol;
    this.fetch = fetchImpl; this.warning = warning; this.intervalMs = intervalMs;
    this.abort = new AbortController(); this.stopped = false;
  }
  active() { this.abort.signal.throwIfAborted(); }
  async call(endpoint, body, { wait = false } = {}) {
    this.active();
    const response = await this.fetch(`${this.transport.url}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.transport.token}`, 'Content-Type': 'application/json',
        'X-HAFleet-Generation': String(this.transport.generation) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(wait ? 35000 : 15000)]),
    });
    const data = await response.json(); this.active();
    if (!response.ok) throw Object.assign(new Error(`outbound ${endpoint.split('?')[0]} failed (${response.status}, ${String(data.code ?? 'upstream_error').slice(0,80)})`),
      { code: data.code, status: response.status });
    return data;
  }
  async runProtocol(method, path, body) {
    this.active();
    const result = await this.protocol({ method, path: `/api/fleet/v1${path}`, body, generation: this.transport.generation });
    this.active();
    if (result.status !== 200) throw Object.assign(new Error(result.body?.error || 'fleet operation unavailable'),
      { code: result.body?.code, status: result.status });
    return result.body;
  }
  async receiveOnce(lane, wait = 25000) {
    const response = await this.call(`/poll?lane=${lane}&consumer=${encodeURIComponent(this.store.meta('consumer'))}&wait=${wait}`, undefined, { wait: true });
    if (response.v !== 2 || response.generation !== this.transport.generation) throw new Error('outbound poll registration mismatch');
    if (!response.delivery) return false;
    if (response.delivery.lane !== lane) throw new Error('outbound poll lane mismatch');
    this.store.receive(response.delivery, this.transport.generation);
    // Even a locally completed duplicate needs its new transport ACK. Payload
    // identity is checked by receive() before any server acknowledgement.
    await this.ack(response.delivery);
    return true;
  }
  async ack(row) {
    try {
      await this.call('/ack', { id: row.id, lane: row.lane, token: row.token });
      this.store.acknowledged(row.id, row.lane);
    } catch (error) {
      if (error.code === 'stale_lease') this.store.reclaim(row.id, row.lane);
      throw error;
    }
  }
  async processOnce(lane) {
    const row = this.store.next(lane); if (!row) return false;
    try {
      if (row.state === 'received') await this.ack(row);
      this.active();
      if (row.kind === 'transaction') {
        const outcome = await this.transaction(row.payload, { generation: row.generation }); this.active();
        if (outcome?.status !== 200) throw Object.assign(new Error('outbound Matrix transaction awaits successful processing'), { code: 'matrix_processing_pending' });
        this.store.finish(row.id, { lane: row.lane });
      } else if (row.kind === 'request') {
        // Durable tracking is separate from admission, which may need another
        // Matrix event or a later contributor configuration change.
        this.store.finish(row.id, { request: row.payload, lane: row.lane });
      } else {
        const receipt = await this.runProtocol('POST', '/probe', row.payload);
        this.store.finish(row.id, { receipt, lane: row.lane });
      }
      return true;
    } catch (error) {
      this.active(); this.store.retry(row.id, error.code ?? 'processing_pending', Date.now(), row.lane); throw error;
    }
  }
  async publishOnce() {
    let payload = this.store.pendingUpdate();
    if (!payload) {
      const capabilities = await this.runProtocol('GET', '/capabilities');
      const statuses = this.store.requestSnapshots();
      payload = this.store.enqueueUpdate({ v: 2, generation: this.transport.generation, heartbeat: true, capabilities, statuses });
    }
    await this.call('/updates', payload);
    this.store.updateAccepted(payload);
  }
  async reconcileRequestsOnce() {
    // Slow room/owner verification cannot block the heartbeat or either inbox.
    await Promise.all(this.store.dueRequests().map(async row => {
      this.store.deferRequest(row.id);
      try {
        if (!row.admitted) {
          await this.runProtocol('POST', '/requests', row.payload);
          this.store.admitted(row.id);
        }
        const status = await this.runProtocol('GET', `/requests/${encodeURIComponent(row.id)}`);
        this.store.observeRequest(row.id, status);
      } catch (error) {
        this.active();
        this.warning(`Agent request ${row.id} awaits verification (${String(error.code ?? 'provider_unavailable').slice(0,80)})`);
        this.store.observeRequest(row.id, { ...row.payload, ...(row.status ? JSON.parse(row.status) : {}),
          state: row.admitted && row.status ? JSON.parse(row.status).state : 'submission_pending', ready: false,
          fulfillment: { phase: row.admitted ? 'verification' : 'admission', incomplete: true,
            error: 'HAFleet is retrying request verification; see its provider diagnostics.' } });
      }
    }));
  }
  async loop(fn, pauseMs) {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try { await fn(); failures = 0; }
      catch (error) { failures++; if (!this.abort.signal.aborted) this.warning(`Outbound fleet connection: ${error.code ?? error.message}`); }
      if (this.abort.signal.aborted) break;
      try { await delay(failures ? Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)) : pauseMs, undefined, { signal: this.abort.signal }); } catch { break; }
    }
  }
  start() {
    if (this.running) return this;
    this.running = [
      ...['matrix', 'work'].map(lane => this.loop(async () => {
        if (!await this.processOnce(lane)) {
          const waiting = this.store.waiting(lane);
          // Preserve Matrix transaction ordering while its first accepted
          // transaction needs recovery; do not drain an unbounded remote queue.
          if (lane === 'matrix' && waiting) return;
          await this.receiveOnce(lane, waiting ? Math.min(25000, Math.max(0, waiting.retry_at - Date.now())) : 25000);
        }
      }, 100)),
      this.loop(() => this.publishOnce(), this.intervalMs),
      this.loop(() => this.reconcileRequestsOnce(), 1000),
    ];
    return this;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.abort.abort();
    this.stopPromise = Promise.allSettled(this.running ?? []).then(() => this.store.close());
    return this.stopPromise;
  }
}
