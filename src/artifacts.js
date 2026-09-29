'use strict';

function imageArtifact(image = {}) {
  const artifact = {
    id: String(image.id || ''),
    object: 'artifact',
    type: 'image',
    mime_type: String(image.mimeType || 'application/octet-stream')
  };
  if (image.filename) artifact.filename = String(image.filename);
  if (Number.isFinite(Number(image.bytes))) artifact.bytes = Number(image.bytes);
  if (image.gatewayLocalPath) artifact.gateway_path = String(image.gatewayLocalPath);
  if (image.url) {
    artifact.url = String(image.url);
    artifact.markdown = `![Generated image](${image.url})`;
  }
  return artifact;
}

function imageArtifacts(images = []) {
  return Array.isArray(images) ? images.map(imageArtifact) : [];
}

// The model continuation needs machine-readable facts about the generated
// artifact, not the client-facing receipt. Keeping those two representations
// separate prevents the model and gateway from both presenting the same image.
function internalImageToolResult(image = {}) {
  const artifact = imageArtifact(image);
  delete artifact.markdown;
  return {
    status: 'completed',
    artifact,
    delivery: {
      handled_by: 'gateway',
      visible_receipt: 'automatic',
      repeat_in_assistant_text: false
    }
  };
}

function artifactReceipt(images = []) {
  const artifacts = imageArtifacts(images);
  if (!artifacts.length) return '';
  const lines = ['Image artifact delivery:'];
  artifacts.forEach((artifact, index) => {
    if (artifacts.length > 1) lines.push(`Image ${index + 1}:`);
    lines.push(`- ID: ${artifact.id}`);
    if (artifact.filename) lines.push(`- Filename: ${artifact.filename}`);
    lines.push(`- MIME type: ${artifact.mime_type}`);
    if (artifact.bytes != null) lines.push(`- Bytes: ${artifact.bytes}`);
    if (artifact.gateway_path) lines.push(`- Gateway local path: ${artifact.gateway_path}`);
    if (artifact.url) lines.push(`- URL: ${artifact.url}`);
    if (artifact.markdown) lines.push(`- Markdown: ${artifact.markdown}`);
  });
  return lines.join('\n');
}

function deliveryText(result = {}) {
  const text = String(result.text || '');
  const receipt = artifactReceipt(result.images);
  if (!receipt) return text;

  // The gateway owns the canonical external receipt. If a model ever echoes
  // that exact transport block (for example while an older continuation is
  // still in flight), remove every duplicate before appending it once.
  const narrative = text.includes(receipt)
    ? text.split(receipt).join('').trim()
    : text;
  return narrative ? `${narrative}\n\n${receipt}` : receipt;
}

// Native image generation has a second model turn. Its answer need not start
// with the commentary already streamed before the image tool ran. SSE cannot
// retract that commentary, so append the new phase instead of dropping it.
function streamTextRemainder(emitted, finalText) {
  if (!finalText || emitted === finalText) return '';
  if (finalText.startsWith(emitted)) return finalText.slice(emitted.length);
  return `${emitted ? '\n\n' : ''}${finalText}`;
}

module.exports = {
  streamTextRemainder,
  artifactReceipt,
  deliveryText,
  imageArtifact,
  imageArtifacts,
  internalImageToolResult
};
