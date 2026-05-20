import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, openAICompatibleConfig } from './provider-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

export const GENERATED_ROOT = path.join(ROOT_DIR, '.codexmobile', 'generated');
export const DEFAULT_IMAGE_BASE_URL = DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const IMAGE_TIMEOUT_MS = Number(process.env.CODEXMOBILE_IMAGE_TIMEOUT_MS || 420000);
export const IMAGE_MAX_ATTEMPTS = Math.max(1, Number(process.env.CODEXMOBILE_IMAGE_MAX_ATTEMPTS || 3));
export const IMAGE_FALLBACK_MAX_ATTEMPTS = Math.max(1, Number(process.env.CODEXMOBILE_IMAGE_FALLBACK_MAX_ATTEMPTS || 2));
export const IMAGE_RETRY_BASE_DELAY_MS = Number(process.env.CODEXMOBILE_IMAGE_RETRY_BASE_DELAY_MS || 1600);

export const GENERATE_PATTERNS = [
  /(?:生成|画|绘制|制作|设计|出图|创建|做一张|来一张).*(?:图片|图像|图|照片|海报|宣传图|壁纸|头像|插画|封面|logo)/i,
  /(?:图片|图像|图|照片|海报|宣传图|壁纸|头像|插画|封面|logo).*(?:生成|画|绘制|制作|设计|出图|创建|做)/i,
  /\b(?:generate|create|draw|make)\b.*\b(?:image|photo|picture|poster|wallpaper|avatar|logo)\b/i
];

export const EDIT_PATTERNS = [
  /(?:修改|编辑|改|换|去掉|移除|添加|变成|修图|美化|上色|扩图|换背景|抠图)/i,
  /\b(?:edit|modify|change|remove|add|retouch|replace|background)\b/i
];

export function safeErrorMessage(error) {
  const message = String(error?.message || error || '图片生成失败').trim();
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]');
}

export function isTransientImageError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('stream disconnected') ||
    message.includes('before completion') ||
    message.includes('requesttimeout') ||
    message.includes('timeout') ||
    message.includes('context canceled') ||
    message.includes('internal_server_error') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function imageMimeToExt(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) {
    return 'jpg';
  }
  if (mime.includes('webp')) {
    return 'webp';
  }
  return 'png';
}

export function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || 'image/png',
    b64: match[2]
  };
}

export function detectImageIntent(message, attachments) {
  const text = String(message || '').trim();
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  if (imageAttachments.length && EDIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'edit';
  }
  if (GENERATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return imageAttachments.length ? 'edit' : 'generate';
  }
  if (imageAttachments.length && /(生成|出图|重绘|做成|变成|generate|create|draw|make)/i.test(text)) {
    return 'edit';
  }
  return null;
}

export function isImageRequest(message, attachments = []) {
  return Boolean(detectImageIntent(message, attachments));
}

export async function imageApiConfig(config = {}) {
  const providerConfig = await openAICompatibleConfig({
    baseUrl: process.env.CODEXMOBILE_IMAGE_BASE_URL || config.baseUrl,
    defaultBaseUrl: DEFAULT_IMAGE_BASE_URL,
    apiKeys: [process.env.CODEXMOBILE_IMAGE_API_KEY]
  });
  return {
    ...providerConfig,
    model: process.env.CODEXMOBILE_IMAGE_MODEL || DEFAULT_IMAGE_MODEL
  };
}

export async function readImageAttachment(attachment) {
  const data = await fs.readFile(attachment.path);
  const mimeType = attachment.mimeType || 'image/png';
  return {
    name: attachment.name || path.basename(attachment.path),
    mimeType,
    data
  };
}

export function canFallbackEditToGeneration({ intent, attachments, error }) {
  return intent === 'edit' && attachments.some((attachment) => attachment.kind === 'image') && isTransientImageError(error);
}

export function buildFallbackGenerationPrompt(prompt, attachments, error) {
  const imageNames = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.name)
    .filter(Boolean)
    .join(', ');
  const reason = safeErrorMessage(error);
  return [
    'Create a new image as a fallback because the image editing API disconnected.',
    imageNames ? `The user attached reference image file(s): ${imageNames}. Use the user request as the main visual direction.` : '',
    `User request: ${prompt}`,
    `Previous edit error: ${reason}`,
    'Do not mention the technical failure in the image. Produce a polished final image that best matches the request.'
  ].filter(Boolean).join('\n');
}

export async function requestImageGeneration({ prompt, attachments, config, forceGenerate = false }) {
  const intent = forceGenerate ? 'generate' : detectImageIntent(prompt, attachments) || 'generate';
  const imageConfig = await imageApiConfig(config);
  const imageAttachments = forceGenerate ? [] : attachments.filter((attachment) => attachment.kind === 'image');
  const imageFiles = [];
  for (const attachment of imageAttachments) {
    imageFiles.push(await readImageAttachment(attachment));
  }

  async function sendRequest(apiKey) {
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const timeoutSignal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
    if (intent === 'edit' && imageFiles.length) {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('model', imageConfig.model);
      form.append('response_format', 'b64_json');
      form.append('size', '1024x1024');
      for (const image of imageFiles) {
        form.append('image', new Blob([image.data], { type: image.mimeType }), image.name);
      }
      return fetch(`${imageConfig.baseUrl}/images/edits`, {
        method: 'POST',
        headers,
        body: form,
        signal: timeoutSignal
      });
    }

    return fetch(`${imageConfig.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify({
        model: imageConfig.model,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json'
      }),
      signal: timeoutSignal
    });
  }

  const apiKeys = imageConfig.apiKeys.length ? imageConfig.apiKeys : [''];
  let response = null;
  let text = '';
  let lastError = null;

  for (let index = 0; index < apiKeys.length; index += 1) {
    response = await sendRequest(apiKeys[index]);
    text = await response.text();
    if (response.ok) {
      break;
    }

    let errorMessage = text;
    try {
      const parsed = text ? JSON.parse(text) : null;
      errorMessage = parsed?.error?.message || parsed?.error || parsed?.message || text;
    } catch {
      // Keep the raw text.
    }
    lastError = new Error(errorMessage || `图片接口返回 ${response.status}`);
    const invalidKey = /invalid api key|incorrect api key|unauthorized|401/i.test(errorMessage || '') || response.status === 401;
    if (!invalidKey || index === apiKeys.length - 1) {
      break;
    }
    console.warn(`[image] API key #${index + 1} failed, trying next key.`);
  }

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || lastError?.message || text || `图片接口返回 ${response.status}`;
    throw new Error(message);
  }

  const items = Array.isArray(data?.data) ? data.data : [];
  const images = items
    .map((item) => {
      if (item.b64_json) {
        return {
          b64: item.b64_json,
          mimeType: data?.output_format ? `image/${data.output_format}` : 'image/png',
          revisedPrompt: item.revised_prompt || ''
        };
      }
      const parsed = parseDataUrl(item.url);
      return parsed ? { ...parsed, revisedPrompt: item.revised_prompt || '' } : null;
    })
    .filter(Boolean);

  if (!images.length) {
    throw new Error('图片接口没有返回图片内容');
  }

  return {
    intent,
    model: imageConfig.model,
    images,
    usage: data?.usage || null
  };
}
