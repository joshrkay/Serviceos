module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // babel-preset-expo auto-adds react-native-reanimated/plugin when
    // reanimated is installed — don't add it again here.
  };
};
