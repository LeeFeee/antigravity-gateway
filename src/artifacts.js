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
  return text ? `${text}\n\n${receipt}` : receipt;
}

module.exports = {
  artifactReceipt,
  deliveryText,
  imageArtifact,
  imageArtifacts
};
