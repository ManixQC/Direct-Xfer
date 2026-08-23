'use strict';

// Host/container path translation and containment checks. Keeping these helpers
// behind one boundary makes every caller use the same traversal and symlink
// policy while server.js remains a composition root.
function createHostPathService(deps = {}) {
  const { fs, path, hostRoot } = deps;
  if (!fs || !fs.promises || typeof fs.promises.realpath !== 'function' || !path || typeof path.relative !== 'function') {
    throw new TypeError('createHostPathService requires fs and path');
  }
  if (typeof hostRoot !== 'string' || !hostRoot) {
    throw new TypeError('createHostPathService requires hostRoot');
  }

  // True if `target` equals `root` or is strictly contained in it (no `..`).
  function withinRoot(root, target) {
    const rel = path.relative(root, target);
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    const segments = rel.split(path.sep);
    return !segments.includes('..');
  }

  // Resolves a user-provided sub-path, neutralizing any traversal.
  function resolveWithin(root, sub) {
    const raw = String(sub == null ? '' : sub).replace(/\\/g, '/');
    const normalized = path.posix.normalize('/' + raw).replace(/^\/+/, '');
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    // `sub` is untrusted, but it is normalized above (posix.normalize strips any
    // `..` that would climb past the leading `/`) and the resolved path is
    // rejected below by withinRoot() if it still escapes `root`. Nothing derived
    // from `target` is used before that check.
    const target = path.resolve(root, normalized);
    if (!withinRoot(root, target)) {
      const err = new Error('Path outside the allowed root');
      err.code = 'EPATH';
      throw err;
    }
    return target;
  }

  // Checks that the REAL path (symlinks resolved) stays within the real root.
  async function assertRealWithin(root, target) {
    const realRoot = await fs.promises.realpath(root);
    const realTarget = await fs.promises.realpath(target);
    if (!withinRoot(realRoot, realTarget)) {
      const err = new Error('Path outside the root (symlink)');
      err.code = 'EPATH';
      throw err;
    }
    return realTarget;
  }

  // Real host path (absolute POSIX) of a container path located under hostRoot.
  function containerToHost(containerAbs) {
    const target = path.resolve(String(containerAbs == null ? '' : containerAbs));
    if (!withinRoot(hostRoot, target)) {
      const err = new Error('Path outside the allowed host root');
      err.code = 'EPATH';
      throw err;
    }
    const rel = path.relative(hostRoot, target).split(path.sep).join('/');
    return '/' + rel;
  }

  // Real container path matching a host path, with anti-traversal guard.
  function hostToContainer(hostPath) {
    return resolveWithin(hostRoot, hostPath);
  }

  return Object.freeze({ withinRoot, resolveWithin, assertRealWithin, containerToHost, hostToContainer });
}

module.exports = { createHostPathService };
