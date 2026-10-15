'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { RobinGrpcTransport } = require('../src/robin-provider');
const { robinErrorCategory } = require('../src/robin-account-pool');
const { grpcFrame, GrpcFrameDecoder, protoStruct, decodeProtoStruct } = require('../src/robin-proto');

function harness(onMessage) {
  const request = new EventEmitter();
  const client = new EventEmitter();
  request.write = () => true;
  request.end = () => {};
  request.close = () => { request.closed = true; };
  client.request = () => request;
  client.close = () => { client.closed = true; };
  const transport = new RobinGrpcTransport({ connectImpl: () => client });
  const stream = transport.request('/test', 'test-token', { onMessage });
  return { request, client, stream };
}

test('Robin gRPC failures never inherit HTTP 200 and preserve error categories', async () => {
  for (const [grpc, status, category] of [[1,499,'request'],[2,502,'transient'],[3,400,'request'],[4,504,'transient'],[5,404,'request'],[6,409,'request'],[7,403,'account'],[8,429,'quota'],[9,412,'request'],[10,409,'request'],[11,400,'request'],[12,501,'request'],[13,502,'transient'],[14,503,'transient'],[15,502,'transient'],[16,401,'account']]) {
    const { request, stream } = harness();
    const rejected = assert.rejects(stream.done, error => {
      assert.equal(error.status,status,`gRPC ${grpc}`);
      assert.equal(robinErrorCategory(error),category,`category for gRPC ${grpc}`);
      return true;
    });
    request.emit('response', { ':status': 200 });
    request.emit('trailers', { 'grpc-status': String(grpc), 'grpc-message': 'test%20failure' });
    request.emit('end');
    await rejected;
  }
});

test('Robin transport accepts fragmented frames only after a valid success status', async () => {
  const seen = [];
  const { request, stream } = harness(bytes => seen.push(bytes.toString()));
  const frame = grpcFrame(Buffer.from('reply'));
  request.emit('response', { ':status': 200 });
  request.emit('data', frame.subarray(0,3));
  request.emit('data', frame.subarray(3));
  request.emit('trailers', { 'grpc-status': '0' });
  request.emit('end');
  assert.deepEqual((await stream.done).map(b=>b.toString()), ['reply']);
  assert.deepEqual(seen,['reply']);
});

test('Robin transport rejects incomplete streams and contains decoder/callback failures', async () => {
  for(const kind of ['missing-status','truncated','closed','bad-flag','oversized','callback']) {
    const { request, client, stream } = harness(() => { if(kind==='callback')throw Error('handler failed'); });
    const rejected = assert.rejects(stream.done);
    request.emit('response', { ':status': 200 });
    if(kind==='missing-status') request.emit('end');
    else if(kind==='closed')request.emit('close');
    else {
      const frame=grpcFrame(Buffer.from('reply'));
      if(kind==='truncated')request.emit('data',frame.subarray(0,7));
      else if(kind==='bad-flag'){frame[0]=2;assert.doesNotThrow(()=>request.emit('data',frame));}
      else if(kind==='oversized'){frame.writeUInt32BE(0xffffffff,1);assert.doesNotThrow(()=>request.emit('data',frame.subarray(0,5)));}
      else assert.doesNotThrow(()=>request.emit('data',frame));
      request.emit('trailers', { 'grpc-status': '0' });
      request.emit('end');
    }
    await rejected;
    assert.equal(client.closed,true);
    assert.equal(request.closed,true);
  }
});

test('Robin Struct preserves empty strings, empty map keys and prototype-shaped JSON keys', () => {
  const data=JSON.parse('{"":"empty key","empty":"","array":["",null],"__proto__":{"marker":"value"},"constructor":"ordinary"}');
  const result=decodeProtoStruct(protoStruct(data));
  assert.deepEqual(result,data);
  assert.equal(Object.getPrototypeOf(result),Object.prototype);
  assert.equal(Object.hasOwn(result,'__proto__'),true);
  assert.equal(result.marker,undefined);
});

test('gRPC decoder limits declared frame sizes before buffering a body', () => {
  const decoder=new GrpcFrameDecoder({ maxFrameBytes: 8 });
  const frame=grpcFrame(Buffer.alloc(9));
  assert.throws(()=>decoder.push(frame.subarray(0,5)),/frame.*limit/i);
});
