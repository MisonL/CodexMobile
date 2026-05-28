const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  ReadableStream: 'readonly',
  Response: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly'
};

const browserGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  alert: 'readonly',
  Audio: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  Blob: 'readonly',
  cancelAnimationFrame: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  EventSource: 'readonly',
  fetch: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  Image: 'readonly',
  localStorage: 'readonly',
  MediaRecorder: 'readonly',
  navigator: 'readonly',
  Notification: 'readonly',
  performance: 'readonly',
  prompt: 'readonly',
  ReadableStream: 'readonly',
  requestAnimationFrame: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  SpeechSynthesisUtterance: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  window: 'readonly'
};

export default [
  {
    ignores: [
      'asr-service/**',
      'client/dist/**',
      'dist/**',
      'node_modules/**'
    ]
  },
  {
    files: [
      '*.js',
      'bin/**/*.mjs',
      'cli/**/*.mjs',
      'scripts/**/*.mjs',
      'server/**/*.js',
      'tests/**/*.mjs'
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: browserGlobals
    },
    rules: {
      'no-undef': 'error'
    }
  }
];
