// Generation and active-job identity for user-run state. Destructive document
// operations invalidate callbacks first, then best-effort cancel the server job.

const scopes = {
  single: { generation: 0, job: null },
  batch: { generation: 0, job: null },
};

export function beginRun(scope) {
  const current = scopes[scope];
  current.generation += 1;
  current.job = null;
  return current.generation;
}

export function runIsCurrent(scope, generation) {
  return scopes[scope].generation === generation;
}

export function trackRunJob(scope, generation, job) {
  if (!runIsCurrent(scope, generation)) {
    job.cancel().catch(() => {});
    return false;
  }
  scopes[scope].job = job;
  return true;
}

export function activeRunJob(scope) {
  return scopes[scope].job;
}

export function finishRun(scope, generation, job = null) {
  const current = scopes[scope];
  if (current.generation !== generation) return false;
  if (job && current.job && current.job !== job) return false;
  current.job = null;
  return true;
}

export function invalidateRun(scope) {
  const current = scopes[scope];
  current.generation += 1;
  const job = current.job;
  current.job = null;
  if (job) job.cancel().catch(() => {});
}
