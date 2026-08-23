'use strict';

/**
 * Coordinates the runtime boundary around transactional root-state replacement.
 *
 * Persistent restore swaps the live root object. Any service that can still
 * mutate the old state must first report itself idle, and every ephemeral cache,
 * capability or in-memory job view that can retain references into the previous
 * root must be cleared immediately after a successful swap.
 *
 * This module deliberately owns the ordering and failure aggregation for those
 * cross-domain callbacks so restore-service and core-state-application depend on
 * one small contract instead of a long list of unrelated runtime hooks.
 */

function normalizeSteps(steps, kind) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError(`state-replacement coordinator requires non-empty ${kind}`);
  }
  const seen = new Set();
  return Object.freeze(steps.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError(`state-replacement coordinator ${kind}[${index}] must be [name, callback]`);
    }
    const name = String(entry[0] || '').trim();
    const callback = entry[1];
    if (!name) throw new TypeError(`state-replacement coordinator ${kind}[${index}] requires a name`);
    if (seen.has(name)) throw new TypeError(`state-replacement coordinator duplicate ${kind} name: ${name}`);
    if (typeof callback !== 'function') {
      throw new TypeError(`state-replacement coordinator ${kind} requires ${name}()`);
    }
    seen.add(name);
    return Object.freeze({ name, callback });
  }));
}

function isThenable(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function busyCheckFailure(step, cause) {
  const error = new Error(`state-replacement-busy-check-failed: ${step.name}`);
  error.code = 'STATE_REPLACEMENT_BUSY_CHECK_FAILED';
  error.step = step.name;
  error.cause = cause;
  return error;
}

function createStateReplacementCoordinator(options = {}) {
  const busyChecks = normalizeSteps(options.busyChecks, 'busyChecks');
  const resetSteps = normalizeSteps(options.resetSteps, 'resetSteps');
  let resetInProgress = false;

  function isBusyForStateReplacement() {
    for (const step of busyChecks) {
      let result;
      try {
        result = step.callback();
        if (isThenable(result)) {
          // Busy probes are deliberately synchronous: restore must decide whether
          // it can replace the root state without yielding back to the event loop.
          // Treat an accidental async probe as a configuration failure, not as a
          // truthy "busy" value that would hide the broken contract forever.
          if (typeof result.catch === 'function') result.catch(() => {});
          throw new TypeError(`state-replacement busy check ${step.name} returned a Promise`);
        }
      } catch (error) {
        if (error && error.code === 'STATE_REPLACEMENT_BUSY_CHECK_FAILED') throw error;
        throw busyCheckFailure(step, error);
      }
      if (result) return true;
    }
    return false;
  }

  function clearRuntimeAfterRestore() {
    if (resetInProgress) {
      const error = new Error('state-replacement-runtime-reset-reentrant');
      error.code = 'STATE_REPLACEMENT_RESET_REENTRANT';
      throw error;
    }

    resetInProgress = true;
    const failures = [];
    try {
      for (const step of resetSteps) {
        try {
          const result = step.callback();
          if (isThenable(result)) {
            // All runtime invalidation must complete synchronously before the
            // restored state is exposed to another request. If a future service
            // changes one of these callbacks to async, fail loudly and force the
            // existing post-restore recovery shutdown instead of returning success.
            if (typeof result.catch === 'function') result.catch(() => {});
            const error = new TypeError(`state-replacement reset step ${step.name} returned a Promise`);
            error.code = 'STATE_REPLACEMENT_ASYNC_RESET_UNSUPPORTED';
            throw error;
          }
        } catch (error) {
          failures.push({ name:step.name, error });
        }
      }
    } finally {
      resetInProgress = false;
    }

    if (failures.length) {
      const error = new Error('restore-runtime-reset-failed: ' + failures.map((failure) => failure.name).join(','));
      error.code = 'RESTORE_RUNTIME_RESET_FAILED';
      error.failures = failures;
      throw error;
    }
  }

  return Object.freeze({
    isBusyForStateReplacement,
    clearRuntimeAfterRestore,
  });
}

module.exports = { createStateReplacementCoordinator };
