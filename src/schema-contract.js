'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout, clearTimeout } = require('node:timers');
const schemaBoundary = new AsyncLocalStorage();
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const DEFAULT_LIMITS = Object.freeze({ workers: 2, queue: 64, queueBytes: 16 * 1024 * 1024,
  compileMs: 1000, validateMs: 250, queueMs: 2000, startupMs: 10000, memoryMb: 64 });

class SchemaContractError extends Error {
  constructor(message, cause, { code = 'invalid_tool_schema', status = 400 } = {}) {
    super(message, { cause }); this.name = 'SchemaContractError'; this.code = code; this.status = status;
  }
}
function failure(message, code, status = 400) { return new SchemaContractError(message, undefined, { code, status }); }
function abortFailure(signal) { return signal?.reason instanceof Error ? signal.reason : new DOMException('Schema 校验已取消。', 'AbortError'); }
function withAsyncSchemaBoundary(callback) { return schemaBoundary.run(true, callback); }
function assertSyncAllowed() {
  if (schemaBoundary.getStore()) throw failure('HTTP 请求不能使用同步 Schema 校验路径。', 'schema_sync_forbidden', 500);
}
function serialize(value, limit, label) {
  let result;
  try { result = JSON.stringify(value); }
  catch (cause) { throw new SchemaContractError(`${label}不是可序列化的 JSON。`, cause); }
  if (result === undefined || Buffer.byteLength(result) > limit) throw failure(`${label}超过大小限制。`, 'invalid_tool_schema');
  // Bound the entire value, including annotations and const/enum payloads.
  const stack = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (depth > MAX_SCHEMA_DEPTH) throw failure(`${label}嵌套超过支持深度。`, 'invalid_tool_schema');
    if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return result;
}

class SchemaWorkerPool {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid schema worker limit: ${key}`);
    this.slots = []; this.queue = []; this.queuedBytes = 0; this.closed = false;
  }
  execute(operation, schema, value, { signal } = {}) {
    if (this.closed) return Promise.reject(failure('Schema 校验服务已关闭。', 'schema_worker_unavailable', 503));
    if (signal?.aborted) return Promise.reject(abortFailure(signal));
    const bytes = Buffer.byteLength(schema) + (value ? Buffer.byteLength(value) : 0);
    if (this.queue.length >= this.limits.queue || this.queuedBytes + bytes > this.limits.queueBytes) {
      return Promise.reject(failure('Schema 校验队列已满，请稍后重试。', 'schema_capacity_exceeded', 503));
    }
    return new Promise((resolve, reject) => {
      const job = { operation, schema, value, bytes, signal, resolve, reject, settled: false, slot: null };
      job.abort = () => this.cancel(job, abortFailure(signal));
      signal?.addEventListener('abort', job.abort, { once: true });
      job.queueTimer = setTimeout(() => this.cancel(job, failure('Schema 校验排队超时。', 'schema_capacity_exceeded', 503)), this.limits.queueMs);
      this.queue.push(job); this.queuedBytes += bytes;
      this.drain();
    });
  }
  settle(job, error, result) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.queueTimer); clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
  }
  cancel(job, error) {
    if (job.settled) return;
    if (job.slot) this.retire(job.slot, error);
    else {
      const index = this.queue.indexOf(job);
      if (index !== -1) { this.queue.splice(index, 1); this.queuedBytes -= job.bytes; }
      this.settle(job, error); this.drain();
    }
  }
  spawn() {
    const worker = new Worker(path.join(__dirname, 'schema-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: this.limits.memoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    });
    const slot = { worker, ready: false, job: null, retired: false };
    this.slots.push(slot);
    slot.startupTimer = setTimeout(() => this.retire(slot, failure('Schema 校验线程启动超时。', 'schema_worker_unavailable', 503)), this.limits.startupMs);
    worker.on('message', message => {
      if (slot.retired) return;
      if (message.ready) { slot.ready = true; clearTimeout(slot.startupTimer); this.drain(); return; }
      const job = slot.job;
      if (!job) return;
      if (message.phase === 'validation') {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => this.retire(slot,
          failure('Schema 参数校验超过执行预算。', 'schema_execution_timeout')), this.limits.validateMs);
        return;
      }
      slot.job = null; job.slot = null;
      const error = message.error ? failure(message.error.message, message.error.code, message.error.status) : null;
      this.settle(job, error, message); worker.unref(); this.drain();
    });
    worker.on('error', () => this.retire(slot, failure('Schema 校验线程异常退出。', 'schema_worker_unavailable', 503)));
    worker.on('exit', () => { if (!slot.retired) this.retire(slot, failure('Schema 校验线程已退出。', 'schema_worker_unavailable', 503)); });
    return slot;
  }
  retire(slot, error) {
    if (slot.retired) return;
    slot.retired = true; clearTimeout(slot.startupTimer);
    if (slot.job) { this.settle(slot.job, error); slot.job = null; }
    // terminate actually interrupts runaway RegExp/compilation, not merely its
    // waiting promise. A replacement is created only if another job needs it.
    // A retiring thread still occupies capacity until termination completes.
    // Cancellation bursts therefore cannot create unbounded live workers.
    slot.termination = slot.worker.terminate().catch(() => {}).then(() => {
      const index = this.slots.indexOf(slot);
      if (index !== -1) this.slots.splice(index, 1);
      this.drain();
    });
    this.drain();
  }
  drain() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = this.slots.find(item => !item.retired && item.ready && !item.job);
      if (!slot) {
        if (this.slots.length < this.limits.workers) { this.spawn(); continue; }
        break;
      }
      const job = this.queue.shift(); this.queuedBytes -= job.bytes;
      clearTimeout(job.queueTimer); job.slot = slot; slot.job = job;
      slot.worker.ref();
      job.timer = setTimeout(() => this.retire(slot,
        failure('Schema 编译或参数校验超过执行预算。', 'schema_execution_timeout')),
      this.limits.compileMs);
      slot.worker.postMessage({ operation: job.operation, schema: job.schema, value: job.value });
    }
    for (const slot of this.slots) if (slot.ready && !slot.job) slot.worker.unref();
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) this.settle(job, failure('Schema 校验服务已关闭。', 'schema_worker_unavailable', 503));
    this.queuedBytes = 0;
    const slots = [...this.slots];
    await Promise.all(slots.map(slot => {
      slot.retired = true; clearTimeout(slot.startupTimer);
      if (slot.job) this.settle(slot.job, failure('Schema 校验服务已关闭。', 'schema_worker_unavailable', 503));
      return slot.termination || slot.worker.terminate();
    }));
    this.slots = [];
  }
}

let defaultPool;
const pool = () => defaultPool ||= new SchemaWorkerPool();
async function compileSchemaAsync(schema, options = {}) {
  const source = schema === undefined ? true : schema;
  if (typeof source !== 'boolean' && (!source || typeof source !== 'object' || Array.isArray(source))) {
    throw new SchemaContractError('工具 Schema 必须是 JSON Schema 对象或布尔值。');
  }
  const serialized = serialize(source, MAX_SCHEMA_BYTES, '工具 Schema');
  const workerPool = options.pool || pool();
  await workerPool.execute('compile', serialized, undefined, options);
  const validate = async value => {
    const serializedValue = serialize(value, MAX_VALUE_BYTES, '工具参数');
    const result = await workerPool.execute('validate', serialized, serializedValue, options);
    validate.errors = result.errors || null;
    return result.valid === true;
  };
  validate.errors = null;
  return validate;
}
async function validateSchemaAsync(value, schema, options = {}) {
  try { return await (await compileSchemaAsync(schema, options))(value); }
  catch (error) { if (error.code === 'invalid_tool_schema') return false; throw error; }
}
// Synchronous APIs are retained for offline conversion fixtures only. Runtime
// HTTP/provider entry points import the Async variants. Ajv is lazy-loaded so
// an HTTP-only process never loads a main-thread compiler at all.
function compileSchema(schema) {
  assertSyncAllowed();
  let compiled;
  try { compiled = require('./schema-engine').compileSchema(schema); }
  catch (error) { throw new SchemaContractError(error.message, error); }
  const validate = value => { assertSyncAllowed(); return compiled(value); };
  Object.defineProperty(validate, 'errors', { get: () => compiled.errors });
  return validate;
}
function validateSchema(value, schema) {
  assertSyncAllowed();
  try { return compileSchema(schema)(value) === true; } catch { return false; }
}
async function closeSchemaWorkers() { const current = defaultPool; defaultPool = null; await current?.close(); }
module.exports = { compileSchema, validateSchema, compileSchemaAsync, validateSchemaAsync, SchemaContractError,
  MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH, MAX_VALUE_BYTES, DEFAULT_LIMITS, SchemaWorkerPool, closeSchemaWorkers, withAsyncSchemaBoundary };
