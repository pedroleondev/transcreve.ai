const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const jobs = new AsyncLocalStorage();
const getJobSignal = () => jobs.getStore();
const runWithJobSignal = (signal, fn) => jobs.run(signal, fn);
const jobSleep = ms => delay(ms, undefined, { signal: getJobSignal() });
module.exports = { getJobSignal, runWithJobSignal, jobSleep };
