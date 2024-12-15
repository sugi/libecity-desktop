module.exports = {
  packagerConfig: {
    ignore: [
      '^src/',
      '^\\.git',
      '^\\.github/',
      '\\..*rc',
      '^tsconfig\\.json',
      '^out/',
      '^node_modules/.*',
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
};
