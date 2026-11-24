// Finalize videos through browser_close before Playwright's process watchdog runs.
function stopWorker(child, timeout = 20000, beforeStop) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    timer.unref();
    child.once('close', () => {clearTimeout(timer); resolve();});
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      child.kill('SIGTERM');
    };
    if (beforeStop) Promise.resolve().then(beforeStop).catch(() => {}).then(terminate);
    else terminate();
  });
}
module.exports = {stopWorker};
