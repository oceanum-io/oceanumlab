const jestJupyterLab = require('@jupyterlab/testutils/lib/jest-config');

const esModules = [
  '@codemirror',
  '@jupyter/ydoc',
  '@jupyterlab/',
  'lib0',
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
  // The built labextension contains a COPY of package.json, so jest sees two
  // modules both named @oceanum/oceanumlab and warns about a haste collision on
  // every run. It is gitignored build output, not source, and nothing here
  // should be resolved out of it.
  modulePathIgnorePatterns: ['<rootDir>/oceanumlab/labextension/'],
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
