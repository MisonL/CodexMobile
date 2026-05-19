import path from 'node:path';

import { LAUNCH_AGENT_LABEL } from './paths.mjs';

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stringEntry(value) {
  return `    <string>${xmlEscape(value)}</string>`;
}

function envEntries(env) {
  const entries = Object.entries(env || {})
    .filter(([, value]) => String(value || '').trim())
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) {
    return '';
  }
  const lines = ['  <key>EnvironmentVariables</key>', '  <dict>'];
  for (const [key, value] of entries) {
    lines.push(`    <key>${xmlEscape(key)}</key>`);
    lines.push(stringEntry(value));
  }
  lines.push('  </dict>');
  return `${lines.join('\n')}\n`;
}

function buildLaunchAgentEnv(paths) {
  return {
    CODEXMOBILE_HOME: paths.dataDir,
    CODEX_HOME: paths.codexHome
  };
}

function buildLaunchctlCommands(paths) {
  return [
    `launchctl bootstrap gui/$(id -u) ${paths.launchAgentPath}`,
    `launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT_LABEL}`
  ];
}

export function buildLaunchAgentPlist(options = {}) {
  const label = options.label || LAUNCH_AGENT_LABEL;
  const args = [
    options.nodePath,
    options.cliPath,
    'serve'
  ].filter(Boolean);
  const outPath = path.posix.join(options.logDir, 'server.out.log');
  const errPath = path.posix.join(options.logDir, 'server.err.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${stringEntry(label)}
  <key>ProgramArguments</key>
  <array>
${args.map(stringEntry).join('\n')}
  </array>
  <key>WorkingDirectory</key>
${stringEntry(options.workingDirectory)}
${envEntries(options.env)}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
${stringEntry(outPath)}
  <key>StandardErrorPath</key>
${stringEntry(errPath)}
</dict>
</plist>
`;
}

export function buildMacInstallPlan(options = {}) {
  const paths = options.paths;
  if (!paths) {
    throw new Error('paths are required to build install plan.');
  }
  if (paths.platform !== 'darwin') {
    throw new Error('macOS LaunchAgent install plan is only available on darwin.');
  }
  if (!options.dryRun) {
    throw new Error('install currently requires --dry-run.');
  }

  const content = buildLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodePath: options.nodePath,
    cliPath: options.cliPath,
    workingDirectory: paths.repoRoot,
    logDir: paths.logDir,
    env: buildLaunchAgentEnv(paths)
  });

  return {
    command: 'install',
    platform: 'darwin',
    label: LAUNCH_AGENT_LABEL,
    dryRun: true,
    launchAgentPath: paths.launchAgentPath,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    wouldCreateDirs: [
      path.posix.dirname(paths.launchAgentPath),
      paths.dataDir,
      paths.logDir
    ],
    wouldWrite: [
      {
        path: paths.launchAgentPath,
        mode: '0644',
        content
      }
    ],
    wouldRun: buildLaunchctlCommands(paths)
  };
}
