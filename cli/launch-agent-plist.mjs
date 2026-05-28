import path from 'node:path';
import { LAUNCH_AGENT_LABEL } from './paths.mjs';

const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 10;

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

export function buildLaunchAgentEnv(paths) {
  return {
    CODEXMOBILE_HOME: paths.dataDir,
    CODEX_HOME: paths.codexHome
  };
}

export function buildLaunchAgentPlist(options = {}) {
  const label = options.label || LAUNCH_AGENT_LABEL;
  const args = options.programArguments || [
    options.nodePath,
    options.cliPath,
    'serve'
  ].filter(Boolean);
  const logName = options.logName || 'server';
  const outPath = path.posix.join(options.logDir, `${logName}.out.log`);
  const errPath = path.posix.join(options.logDir, `${logName}.err.log`);

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
  <true/>
  <key>ThrottleInterval</key>
  <integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>
  <key>StandardOutPath</key>
${stringEntry(outPath)}
  <key>StandardErrorPath</key>
${stringEntry(errPath)}
</dict>
</plist>
`;
}
