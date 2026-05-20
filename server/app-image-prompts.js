import fs from 'node:fs/promises';
import path from 'node:path';
import { listProjectSessions } from './codex-data.js';
import { isImageRequest } from './image-generator.js';
import { IMAGE_PROMPT_STATE } from './app-config.js';

const recentImagePromptsByProject = new Map();

export async function loadRecentImagePrompts() {
  try {
    const raw = await fs.readFile(IMAGE_PROMPT_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [projectId, entry] of Object.entries(parsed.projects || {})) {
      if (entry?.prompt) {
        recentImagePromptsByProject.set(projectId, entry.prompt);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[image] Failed to load prompt state:', error.message);
    }
  }
}

export function persistRecentImagePrompt(projectId, prompt) {
  if (!projectId || !prompt) {
    return;
  }
  fs.mkdir(path.dirname(IMAGE_PROMPT_STATE), { recursive: true })
    .then(async () => {
      let state = { version: 1, projects: {} };
      try {
        state = JSON.parse(await fs.readFile(IMAGE_PROMPT_STATE, 'utf8'));
      } catch {
        // Start a fresh state file.
      }
      state.version = 1;
      state.projects = {
        ...(state.projects || {}),
        [projectId]: {
          prompt,
          updatedAt: new Date().toISOString()
        }
      };
      await fs.writeFile(IMAGE_PROMPT_STATE, JSON.stringify(state, null, 2), 'utf8');
    })
    .catch((error) => console.warn('[image] Failed to persist prompt state:', error.message));
}

export function isContinuationMessage(message) {
  return /^(继续|中断了|又中断了|断了|重新来|重新生成|重新发送|再来|再试一次|retry|continue)$/i.test(String(message || '').trim());
}

export function rememberImagePrompt(projectId, prompt) {
  if (projectId && prompt && isImageRequest(prompt, [])) {
    recentImagePromptsByProject.set(projectId, prompt);
    persistRecentImagePrompt(projectId, prompt);
  }
}

export function resolveContinuationImagePrompt(projectId, message) {
  if (!isContinuationMessage(message)) {
    return '';
  }
  const remembered = recentImagePromptsByProject.get(projectId);
  if (remembered) {
    return remembered;
  }
  const sessions = listProjectSessions(projectId);
  const recentImageSession = sessions.find((session) =>
    isImageRequest(session.summary || session.title || '', [])
  );
  return recentImageSession?.summary || recentImageSession?.title || '';
}
