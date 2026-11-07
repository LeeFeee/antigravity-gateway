'use strict';

const CAPTURED_IMAGE_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_IMAGE_MODEL = String(process.env.ANTIGRAVITY_IMAGE_MODEL || '').trim() || CAPTURED_IMAGE_MODEL;
const IMAGE_MODEL_ALIASES = Object.freeze({ 'gpt-image-1': CAPTURED_IMAGE_MODEL });

class ImageModelError extends Error {
  constructor(model) {
    super(`图片接口不支持模型 ${String(model)}，请选择账号目录中的图片生成模型。`);
    this.name = 'ImageModelError';
    this.code = 'unsupported_image_model';
    this.status = 400;
  }
}

function imageModelName(value, defaultModel = DEFAULT_IMAGE_MODEL) {
  if (value != null && typeof value !== 'string') throw new ImageModelError(value);
  const name = String(value || defaultModel).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) throw new ImageModelError(name);
  return Object.hasOwn(IMAGE_MODEL_ALIASES, name) ? IMAGE_MODEL_ALIASES[name] : name;
}

function assertImageModel(model, discovered = []) {
  // The captured model has a verified image_gen contract. New IDs require
  // an actual imageGenerationModelIds entry, never a name-based inference.
  if (model !== CAPTURED_IMAGE_MODEL && !discovered.includes(model)) throw new ImageModelError(model);
  return model;
}

module.exports = { CAPTURED_IMAGE_MODEL, DEFAULT_IMAGE_MODEL, IMAGE_MODEL_ALIASES,
  ImageModelError, imageModelName, assertImageModel };
