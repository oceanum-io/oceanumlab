const webpack = require('webpack');

module.exports = {
  plugins: [
    new webpack.DefinePlugin({
      DATAMESH_UI_SERVICE: JSON.stringify('https://ui.datamesh.oceanum.io')
    })
  ]
};
