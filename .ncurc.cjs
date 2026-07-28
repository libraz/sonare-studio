// npm-check-updates configuration.
//
// Two packages are held on their current major line; everything else tracks the
// latest release. They still receive minor and patch upgrades.
//
//   typescript — vue-tsc drives `yarn typecheck` and `yarn build`, and resolves
//     the compiler through `typescript/lib/tsc`. TypeScript 7 (the native port)
//     dropped that subpath from its `exports`, so vue-tsc fails to start.
//     Release the pin once vue-tsc supports TypeScript 7.
//
//   jsdom — the vitest DOM environment. jsdom 30 requires Node
//     ^22.22.2 || ^24.15.0 || >=26.0.0, which the Node version pinned in
//     `volta.node` does not satisfy. Release the pin when that Node pin moves.
const HELD_ON_CURRENT_MAJOR = ['typescript', 'jsdom'];

module.exports = {
  packageManager: 'yarn',
  target: (packageName) => (HELD_ON_CURRENT_MAJOR.includes(packageName) ? 'minor' : 'latest'),
};
