// eslint.config.js — the easy slips, caught before a push: a name used but
// never defined, an import or a variable never used, a case that falls
// through. Style is not policed here; CLAUDE.md is for that.
//
//   npx eslint .

const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  history: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly',
  innerWidth: 'readonly', innerHeight: 'readonly', devicePixelRatio: 'readonly',
  performance: 'readonly', crypto: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  FormData: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  AbortController: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  Intl: 'readonly', Notification: 'readonly', Image: 'readonly', OffscreenCanvas: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', KeyboardEvent: 'readonly', PointerEvent: 'readonly',
  MouseEvent: 'readonly', TouchEvent: 'readonly', HashChangeEvent: 'readonly', DragEvent: 'readonly',
  Node: 'readonly', Element: 'readonly', HTMLElement: 'readonly', HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly', HTMLSelectElement: 'readonly', HTMLCanvasElement: 'readonly',
  HTMLButtonElement: 'readonly', HTMLAnchorElement: 'readonly', DOMParser: 'readonly',
  MutationObserver: 'readonly', ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
  caches: 'readonly', self: 'readonly', clients: 'readonly', registration: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly', open: 'readonly', close: 'readonly',
  scrollTo: 'readonly', addEventListener: 'readonly', removeEventListener: 'readonly',
  dispatchEvent: 'readonly', visualViewport: 'readonly', screen: 'readonly', btoa: 'readonly', atob: 'readonly'
};

const node = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly',
  fetch: 'readonly', structuredClone: 'readonly', performance: 'readonly'
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-fallthrough': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-assign': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  eqeqeq: ['error', 'smart']
};

export default [
  { ignores: ['node_modules/**', '_site/**', 'supabase/**', 'tests/.smoke/**', 'docs/**'] },
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser },
    rules
  },
  {
    // the test pages are inline modules in HTML; only the runners are files
    files: ['tests/**/*.mjs', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...browser, ...node } },
    rules
  }
];
