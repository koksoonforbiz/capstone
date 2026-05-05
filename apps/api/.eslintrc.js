module.exports = {
  extends: [require.resolve('@ats/config/eslint')],
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  // `scripts/` is intentionally outside src/ (one-off CLI utilities) so it's
  // not part of the type-aware tsconfig — exclude from lint as well.
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.js', 'scripts'],
};
