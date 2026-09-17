/** Python sources bundled as text (see webpack.config.js). */
declare module '*.py' {
  const source: string;
  export default source;
}
