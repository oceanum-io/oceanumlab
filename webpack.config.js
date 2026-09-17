// Bundle Python kernel sources (src/auth/kernel/*.py) as text strings, so the
// kernel bootstrap can be imported as a module and injected into a kernel.
module.exports = {
  module: {
    rules: [{ test: /\.py$/, type: 'asset/source' }]
  }
};
