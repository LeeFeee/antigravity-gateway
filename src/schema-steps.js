'use strict';

// A conversion is described once. Offline callers can run its pure steps
// synchronously; HTTP/provider paths await the worker-backed schema steps.
function runSync(iterator) {
  let step = iterator.next();
  while (!step.done) {
    if (step.value && typeof step.value.then === 'function') throw new Error('Async schema step used by synchronous conversion.');
    step = iterator.next(step.value);
  }
  return step.value;
}

async function runAsync(iterator) {
  let step = iterator.next();
  while (!step.done) {
    let value;
    try { value = await step.value; }
    catch (error) { step = iterator.throw(error); continue; }
    step = iterator.next(value);
  }
  return step.value;
}

module.exports = { runSync, runAsync };
