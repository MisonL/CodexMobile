import { fileURLToPath } from 'node:url';

export const DEFAULT_CLI_PATH = fileURLToPath(new URL('../bin/codexmobile.mjs', import.meta.url));
export const DEFAULT_RELAY_CLIENT_PATH = fileURLToPath(new URL('../scripts/relay-mac-client.mjs', import.meta.url));
