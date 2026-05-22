import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');

function cleanEnvValue(value) {
  return String(value || '').trim();
}

export function resolveCodexMobileDataRoot(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT_DIR;
  const cwd = options.cwd || process.cwd();
  const override = cleanEnvValue(env.CODEXMOBILE_HOME);

  if (override) {
    return path.resolve(cwd, override);
  }
  return path.join(rootDir, '.codexmobile');
}

export function resolveCodexMobileRuntimePaths(options = {}) {
  const dataRoot = resolveCodexMobileDataRoot(options);
  const stateDir = path.join(dataRoot, 'state');
  return {
    dataRoot,
    stateDir,
    uploadRoot: path.join(dataRoot, 'uploads'),
    generatedRoot: path.join(dataRoot, 'generated'),
    tlsDir: path.join(dataRoot, 'tls'),
    modelCacheDir: path.join(dataRoot, 'model-cache'),
    larkAgentDir: path.join(dataRoot, 'lark-cli-agent'),
    larkGuardDir: path.join(dataRoot, 'lark-cli-guard')
  };
}

const runtimePaths = resolveCodexMobileRuntimePaths();

export const CODEXMOBILE_DATA_ROOT = runtimePaths.dataRoot;
export const CODEXMOBILE_STATE_DIR = runtimePaths.stateDir;
export const CODEXMOBILE_UPLOAD_ROOT = runtimePaths.uploadRoot;
export const CODEXMOBILE_GENERATED_ROOT = runtimePaths.generatedRoot;
export const CODEXMOBILE_TLS_DIR = runtimePaths.tlsDir;
export const CODEXMOBILE_MODEL_CACHE_DIR = runtimePaths.modelCacheDir;
export const CODEXMOBILE_LARK_AGENT_DIR = runtimePaths.larkAgentDir;
export const CODEXMOBILE_LARK_GUARD_DIR = runtimePaths.larkGuardDir;

export function dataPath(...segments) {
  return path.join(CODEXMOBILE_DATA_ROOT, ...segments);
}

export function statePath(...segments) {
  return path.join(CODEXMOBILE_STATE_DIR, ...segments);
}
