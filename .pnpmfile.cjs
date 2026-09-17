// Keep Better Call's Zod 4 types local while ts-rest consumes Zod 3.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'better-call' && pkg.version === '1.4.0') {
        pkg.dependencies = { ...pkg.dependencies, zod: '4.6.5' };
        delete pkg.peerDependencies?.zod;
        delete pkg.peerDependenciesMeta?.zod;
      }
      return pkg;
    },
  },
};
