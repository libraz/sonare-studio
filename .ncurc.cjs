// npm-check-updates configuration.
//
// One package is held on its current major line; everything else tracks the
// latest release. It still receives minor and patch upgrades.
//
//   typescript — vue-tsc drives `yarn typecheck` and `yarn build`, and resolves
//     the compiler through `typescript/lib/tsc`. TypeScript 7 (the native port)
//     dropped that subpath from its `exports`, so vue-tsc fails to start.
//     Release the pin once vue-tsc supports TypeScript 7.
const HELD_ON_CURRENT_MAJOR = ['typescript'];

module.exports = {
  packageManager: 'yarn',
  target: (packageName) => (HELD_ON_CURRENT_MAJOR.includes(packageName) ? 'minor' : 'latest'),
};
