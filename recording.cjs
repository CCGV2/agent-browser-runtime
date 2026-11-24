const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function parseRecording(value) {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw Error('AGENT_BROWSER_RECORD_VIDEO must be 1, true, 0, false, or empty');
}

function prepareRecording(baseDirectory, enabled) {
  const directory = enabled ? path.join(baseDirectory, randomUUID()) : baseDirectory;
  fs.mkdirSync(directory, {recursive: true});
  if (!enabled) return {directory};
  const videoDirectory = path.join(directory, 'videos');
  fs.mkdirSync(videoDirectory, {recursive: true});
  const configPath = path.join(directory, 'mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify({browser: {contextOptions: {recordVideo: {
    dir: videoDirectory, size: {width: 1440, height: 900},
  }}}}), {mode: 0o600});
  return {directory, videoDirectory, configPath};
}
module.exports = {parseRecording, prepareRecording};
