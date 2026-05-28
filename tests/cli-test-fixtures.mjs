import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');

export async function makeFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-cli-home-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4-mini"\n', 'utf8');
  return {
    platform: 'darwin',
    env: {
      CODEXMOBILE_HOME: path.join(home, 'Library', 'Application Support', 'CodexMobile'),
      CODEX_HOME: codexHome
    },
    homedir: home,
    cwd: root,
    execFile: (command, args, options, callback) => {
      callback(Object.assign(new Error(`${command} unavailable`), { code: 'ENOENT' }));
    },
    portProbe: async (port) => ({
      port,
      status: 'available',
      detail: 'fixture port probe'
    }),
    stdout: () => {},
    stderr: () => {}
  };
}
