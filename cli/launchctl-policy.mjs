import { LAUNCH_AGENT_LABEL } from './paths.mjs';

export function buildLaunchctlCommands(paths) {
  return [
    `launchctl bootout gui/$(id -u)/${LAUNCH_AGENT_LABEL}`,
    `launchctl bootstrap gui/$(id -u) ${paths.launchAgentPath}`,
    `launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT_LABEL}`
  ];
}

export function buildLaunchctlNotes() {
  return [
    'The bootout step ignores only not-loaded or not-found launchctl errors. Other bootout failures stop install or enable.'
  ];
}

export function currentUserDomain() {
  if (typeof process.getuid !== 'function') {
    throw new Error('process.getuid is required for macOS LaunchAgent commands.');
  }
  return `gui/${process.getuid()}`;
}

export function serviceTarget() {
  return `${currentUserDomain()}/${LAUNCH_AGENT_LABEL}`;
}

export function launchctlErrorText(error) {
  return String(`${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`).trim();
}

export function isAlreadyBootstrapped(error) {
  const text = launchctlErrorText(error);
  return /already loaded|already bootstrapped|service already loaded/i.test(text) ||
    /operation already in progress/i.test(text) ||
    /bootstrap failed:\s*5:\s*input\/output error/i.test(text) ||
    (error?.code === 5 && /bootstrap failed|input\/output error/i.test(text));
}

export function isNotBootstrapped(error) {
  const text = launchctlErrorText(error);
  return /could not find service|no such process|service is not loaded|not bootstrapped|unknown service|does not exist/i.test(text);
}
