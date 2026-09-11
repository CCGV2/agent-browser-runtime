const fs = require('node:fs');
const path = require('node:path');
function configure(source) {
  if (!source.includes('<desktops>') || !source.includes('<applications>')) throw Error('Unsupported Openbox configuration');
  return source.replace(/<desktops>[\s\S]*?<\/desktops>/, '<desktops><number>1</number><firstdesk>1</firstdesk><names><name>Browser</name></names><popupTime>0</popupTime></desktops>')
    .replace('<applications>', '<applications>\n<application class="Chromium-browser"><desktop>1</desktop><maximized>yes</maximized></application>');
}
if (require.main === module) {
  const dir = path.join(process.env.HOME, '.config', 'openbox');
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'rc.xml'), configure(fs.readFileSync('/etc/xdg/openbox/rc.xml','utf8')));
}
module.exports = {configure};
