const path = require('path');

module.exports = {
  module: {
    // Bundle the kernel bootstrap (kernel/bootstrap.py) as a text string.
    rules: [{ test: /\.py$/, type: 'asset/source' }]
  },
  resolve: {
    // This extension bundles its own React 19 for the Oceanum nav (package.json
    // jupyterlab.sharedPackages), while JupyterLab installs React 18 at the repository root.
    // npm hoists React-bound dependencies (@floating-ui/react, @auth0/auth0-react, ...) to the
    // root, where `import "react"` would find React 18: two Reacts in one bundle, and hooks
    // fail ("Cannot read properties of null (reading 'useId')"). Resolve every React import
    // here, including subpaths such as react/jsx-runtime, to this package's React.
    alias: {
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom')
    }
  }
};
