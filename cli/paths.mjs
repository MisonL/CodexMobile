import os from 'node:os';
import path from 'node:path';

export const LAUNCH_AGENT_LABEL = 'com.codexmobile.agent';

function cleanEnvValue(value) {
  return String(value || '').trim();
}

function pathForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolveWithPlatform(platform, value) {
  const pathApi = pathForPlatform(platform);
  return pathApi.resolve(value);
}

export function resolveUserDataDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const override = cleanEnvValue(env.CODEXMOBILE_HOME);
  const pathApi = pathForPlatform(platform);

  if (override) {
    return resolveWithPlatform(platform, override);
  }
  if (platform === 'darwin') {
    return pathApi.join(homedir, 'Library', 'Application Support', 'CodexMobile');
  }
  if (platform === 'win32') {
    const appData = cleanEnvValue(env.APPDATA) || pathApi.join(homedir, 'AppData', 'Roaming');
    return pathApi.join(appData, 'CodexMobile');
  }

  const xdgData = cleanEnvValue(env.XDG_DATA_HOME) || pathApi.join(homedir, '.local', 'share');
  return pathApi.join(xdgData, 'codexmobile');
}

function resolveLogDir({ platform, env, homedir, dataDir }) {
  const pathApi = pathForPlatform(platform);
  if (platform === 'darwin') {
    return pathApi.join(homedir, 'Library', 'Logs', 'CodexMobile');
  }
  if (platform === 'win32') {
    const localAppData = cleanEnvValue(env.LOCALAPPDATA);
    const base = localAppData || dataDir;
    return pathApi.join(base, 'CodexMobile', 'Logs');
  }

  const xdgState = cleanEnvValue(env.XDG_STATE_HOME) || pathApi.join(homedir, '.local', 'state');
  return pathApi.join(xdgState, 'codexmobile', 'logs');
}

function resolveLaunchAgentPath({ platform, homedir }) {
  if (platform !== 'darwin') {
    return '';
  }
  return path.posix.join(homedir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function resolveRuntimePaths(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const cwd = options.cwd || process.cwd();
  const pathApi = pathForPlatform(platform);
  const dataDir = resolveUserDataDir({ platform, env, homedir });
  const logDir = resolveLogDir({ platform, env, homedir, dataDir });
  const codexHome = cleanEnvValue(env.CODEX_HOME) || pathApi.join(homedir, '.codex');
  const repoRoot = resolveWithPlatform(platform, cwd);

  return {
    platform,
    repoRoot,
    dataDir,
    stateDir: pathApi.join(dataDir, 'state'),
    runDir: pathApi.join(dataDir, 'run'),
    logDir,
    configPath: pathApi.join(dataDir, 'config.json'),
    relayConfigPath: pathApi.join(dataDir, 'relay.json'),
    codexHome,
    codexConfigPath: pathApi.join(codexHome, 'config.toml'),
    launchAgentPath: resolveLaunchAgentPath({ platform, homedir }),
    serverOutLogPath: pathApi.join(logDir, 'server.out.log'),
    serverErrLogPath: pathApi.join(logDir, 'server.err.log'),
    relayOutLogPath: pathApi.join(logDir, 'relay.out.log'),
    relayErrLogPath: pathApi.join(logDir, 'relay.err.log')
  };
}
