'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { artifactReceipt, imageArtifact } = require('../src/artifacts');
const { anthropicResponse, chatResponse, responsesResponse } = require('../src/protocol');
const { imagesResponse } = require('../antigravity-gateway');

const image = {
  id: 'file_0123456789abcdef0123456789abcdef',
  mimeType: 'image/jpeg',
  data: 'base64-image',
  filename: 'generated.jpg',
  bytes: 12345,
  gatewayLocalPath: '/gateway/media/file.bin',
  url: 'https://gateway.example/v1/files/file_0123456789abcdef0123456789abcdef/content',
  prompt: 'draw a bird'
};

const result = {
  text: 'The image is ready.',
  toolCalls: [],
  images: [image],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

test('image artifacts expose transport-neutral delivery metadata without embedding base64', () => {
  const artifact = imageArtifact(image);
  assert.deepEqual(artifact, {
    id: image.id,
    object: 'artifact',
    type: 'image',
    mime_type: 'image/jpeg',
    filename: 'generated.jpg',
    bytes: 12345,
    gateway_path: '/gateway/media/file.bin',
    url: image.url,
    markdown: `![Generated image](${image.url})`
  });
  assert.doesNotMatch(JSON.stringify(artifact), /base64-image/);
  const receipt = artifactReceipt([image]);
  assert.match(receipt, /Gateway local path: \/gateway\/media\/file\.bin/);
  assert.match(receipt, /Markdown: !\[Generated image\]\(https:\/\/gateway\.example/);
});

test('every conversation protocol returns a readable receipt and structured artifacts', () => {
  const anthropic = anthropicResponse('gemini-test', result);
  assert.match(anthropic.content[0].text, /The image is ready/);
  assert.match(anthropic.content[0].text, /Image artifact delivery/);
  assert.equal(anthropic.artifacts[0].url, image.url);

  const chat = chatResponse('gemini-test', result);
  assert.match(chat.choices[0].message.content, /Image artifact delivery/);
  assert.equal(chat.choices[0].message.images[0].image_url.url, image.url);
  assert.equal(chat.choices[0].message.artifacts[0].gateway_path, image.gatewayLocalPath);

  const responses = responsesResponse('gemini-test', result, 'resp_test');
  assert.match(responses.output[0].content[0].text, /Image artifact delivery/);
  assert.equal(responses.output[1].type, 'image_generation_call');
  assert.equal(responses.output[1].artifact.markdown, `![Generated image](${image.url})`);
  assert.equal(responses.artifacts[0].id, image.id);
});

test('OpenAI Images responses keep the standard field and add the same artifact envelope', () => {
  const urlBody = imagesResponse([image], { prompt: image.prompt, response_format: 'url' });
  assert.equal(urlBody.data[0].url, image.url);
  assert.equal(urlBody.data[0].artifact.gateway_path, image.gatewayLocalPath);
  assert.deepEqual(urlBody.artifacts, [urlBody.data[0].artifact]);

  const base64Body = imagesResponse([image], { prompt: image.prompt, response_format: 'b64_json' });
  assert.equal(base64Body.data[0].b64_json, image.data);
  assert.equal(base64Body.data[0].artifact.url, image.url);
});
