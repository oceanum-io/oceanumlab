const jestJupyterLab = require('@jupyterlab/testutils/lib/jest-config');

const esModules = [
  '@codemirror',
  // ESM-only dependencies of @jupyterlab/ui-components, which the sidebar
  // widget's tests import.
  '@jupyter/react-components',
  '@jupyter/web-components',
  '@microsoft',
  '@jupyter/ydoc',
  '@jupyterlab/',
  'color',
  'exenv-es6',
  'lib0',
  'marked',
  'nanoid',
  'vscode-ws-jsonrpc',
  'y-protocols',
  'y-websocket',
  'yjs'
].join('|');

const baseConfig = jestJupyterLab(__dirname);

module.exports = {
  ...baseConfig,
  automock: false,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/.ipynb_checkpoints/*'
  ],
  coverageReporters: ['lcov', 'text'],
  testRegex: 'src/.*/.*.spec.ts[x]?$',
  // Crawl source only. Each built labextension contains a COPY of its package.json,
  // so a default crawl indexes two packages under each name; the haste map then
  // cannot resolve that name at all, and `import '@oceanum/auth-oceanum'` in
  // src/index.ts fails outright once packages/auth-oceanum has been built.
  // `modulePathIgnorePatterns` does not help — it filters resolution, not the haste
  // map, which is why the @oceanum/oceanumlab collision it was added for was only
  // ever silenced by nothing importing that name.
  roots: ['<rootDir>/src', '<rootDir>/packages/auth-oceanum/src'],
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    // Only the sign-in contract: the package's entry point pulls in the Oceanum
    // nav's React 19 and Mantine, which this suite has no transforms for and no
    // use for. Importing anything else from it here fails loudly rather than
    // silently resolving.
    '^@oceanum/auth-oceanum$': '<rootDir>/packages/auth-oceanum/src/tokens.ts'
  },
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
