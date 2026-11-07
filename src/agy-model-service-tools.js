'use strict';

const { isDeepStrictEqual } = require('node:util');

// Official unmodified agy 1.5.2 image-tool-v1 capture. Runtime must not read
// test fixtures. Wire vocabulary and descriptions remain byte-for-byte exact;
// gateway delivery policy belongs in system guidance, not this descriptor.
const IMAGE_TOOL_NAME = 'generate_image';
const IMAGE_DESCRIPTOR = {
  name: IMAGE_TOOL_NAME,
  description: 'Generate an image, or edit existing images, from a text prompt.',
  parameters: {
    type: 'OBJECT',
    properties: {
      AspectRatio: { type: 'STRING', description: 'Defaults to 1:1.', enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] },
      ImageName: { type: 'STRING', description: 'Short descriptive name for the saved file.', minLength: '1' },
      ImagePaths: { type: 'ARRAY', description: 'Images to edit, combine, or use as references.', items: { type: 'STRING' }, maxItems: '3' },
      Prompt: { type: 'STRING', description: 'What the image should depict, or how to edit the given images.', minLength: '1' }
    },
    required: ['Prompt', 'ImageName']
  }
};
const IMAGE_SERVICE_INSTRUCTIONS = 'Generate a new image or edit up to three attached reference images. '
  + 'Use only when a newly generated or edited image is the requested deliverable, not for analyzing attachments. '
  + 'Pass the relevant uploaded image paths in ImagePaths for editing or reference-guided generation; attachment IDs are also accepted when no path is provided. '
  + 'Call this tool alone, without other tools in the same response. The image is delivered automatically once. '
  + 'After the result, continue the task without repeating an image delivery receipt, paths or URLs in the visible answer; '
  + 'you may pass the returned artifact to a client tool when the task requires it.';

function localSchema(schema) {
  const result = structuredClone(schema);
  result.type = result.type.toLowerCase();
  for (const key of ['minLength', 'maxItems']) if (result[key] !== undefined) result[key] = Number(result[key]);
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([name, value]) => [name, localSchema(value)]));
  if (result.items) result.items = localSchema(result.items);
  return result;
}
const IMAGE_SCHEMA = { ...localSchema(IMAGE_DESCRIPTOR.parameters), additionalProperties: false };
const IMAGE_MARKER = 'google-antigravity-api/1.5.2/generate_image';
const issuedTools = new WeakSet();

function createNativeImageTool() {
  const tool = { name: IMAGE_TOOL_NAME, description: IMAGE_DESCRIPTOR.description, kind: 'function', internal: true,
    modelService: IMAGE_MARKER, schema: structuredClone(IMAGE_SCHEMA) };
  issuedTools.add(tool);
  return tool;
}

function matchesImageContract(tool) {
  return tool?.name === IMAGE_TOOL_NAME && tool.kind === 'function' && tool.internal === true && tool.modelService === IMAGE_MARKER
    && tool.description === IMAGE_DESCRIPTOR.description && isDeepStrictEqual(tool.schema, IMAGE_SCHEMA);
}

// A JSON flag, a copied marker, or a tool named generate_image cannot grant
// model-service authority. Check the original factory-issued object before
// the adapter clones declarations, plus the actual post-cleaning contract.
function trustedModelServiceDefinition(source, tool = source) {
  if (!issuedTools.has(source) || !matchesImageContract(source) || !matchesImageContract(tool)) return null;
  return { declaration: structuredClone(IMAGE_DESCRIPTOR), schema: structuredClone(IMAGE_SCHEMA), instructions: IMAGE_SERVICE_INSTRUCTIONS };
}

module.exports = { IMAGE_TOOL_NAME, IMAGE_SERVICE_INSTRUCTIONS, createNativeImageTool, trustedModelServiceDefinition };
