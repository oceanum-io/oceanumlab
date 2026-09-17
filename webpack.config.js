// Bundle Python kernel sources (kernel/*.py) as text strings, so the bootstrap can be
// imported as a module and injected into a kernel. The asset sits at the package root
// rather than under src/, so that the same relative path resolves both from src/auth
// during typecheck and from lib/auth, which is what webpack actually builds against.
module.exports = {
  module: {
    rules: [{ test: /\.py$/, type: 'asset/source' }]
  }
};
