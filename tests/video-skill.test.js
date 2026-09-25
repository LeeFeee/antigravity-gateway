'use strict';

const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function pythonCommand() {
  for (const command of ['python3', 'python']) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0) return command;
  }
  return '';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('bundled video skill uploads native video, analyzes it, and deletes the temporary file', async (t) => {
  const python = pythonCommand();
  if (!python) return t.skip('Python is unavailable');
  const observed = { upload: null, chat: null, deleted: false };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'POST' && req.url === '/v1/files') {
      observed.upload = { contentType: req.headers['content-type'], body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'file_0123456789abcdef0123456789abcdef' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      observed.chat = JSON.parse(body.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'native video answer' } }] }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/v1/files/file_0123456789abcdef0123456789abcdef') {
      observed.deleted = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-video-skill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const video = path.join(directory, 'sample.mp4');
  fs.writeFileSync(video, Buffer.from('video-test-bytes'));
  const script = path.join(__dirname, '..', 'skills', 'antigravity-video-understanding', 'scripts', 'analyze_video.py');
  const address = server.address();
  const { stdout, stderr } = await execFileAsync(python, [
    script, video,
    '--base-url', `http://127.0.0.1:${address.port}/v1`,
    '--api-key', 'test-key',
    '--model', 'gemini-video-test',
    '--prompt', 'What happens in this video?'
  ], { timeout: 10000 });

  assert.equal(stdout.trim(), 'native video answer');
  assert.equal(stderr, '');
  assert.match(observed.upload.contentType, /^multipart\/form-data; boundary=/);
  assert.ok(observed.upload.body.includes(Buffer.from('video-test-bytes')));
  assert.equal(observed.chat.model, 'gemini-video-test');
  assert.deepEqual(observed.chat.messages[0].content, [
    { type: 'text', text: 'What happens in this video?' },
    { type: 'input_video', file_id: 'file_0123456789abcdef0123456789abcdef', mime_type: 'video/mp4' }
  ]);
  assert.equal(observed.deleted, true);
});
