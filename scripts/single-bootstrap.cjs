// The distributed executable contains all assets. Only the private runtime cache
// is materialized; no installed Node, project checkout or node_modules is used.
const sea = require('node:sea');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {gunzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const id = '__EMCLI_ASSET_ID__';
const cache = process.env.EMCLI_SEA_CACHE || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'emcli', 'single');
const root = path.join(cache, id);
function ready() { return fs.existsSync(path.join(root, '.complete')); }
try {
  if (!ready()) {
    fs.mkdirSync(cache, {recursive: true, mode: 0o700});
    const stage = fs.mkdtempSync(path.join(cache, '.extract-'));
    try {
      const manifest = JSON.parse(sea.getAsset('manifest', 'utf8'));
      for (const file of manifest.files) {
        const destination = path.join(stage, file.path);
        const content = gunzipSync(Buffer.from(sea.getAsset(file.key)));
        if (createHash('sha256').update(content).digest('hex') !== file.key) throw new Error('Corrupt embedded asset: ' + file.path);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        fs.writeFileSync(destination, content, {mode: file.mode});
      }
      for (const link of manifest.links) {
        const destination = path.join(stage, link.path);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        // Windows junctions store absolute targets. Point at the final cache,
        // otherwise renaming the extraction directory leaves every link broken.
        const target = process.platform === 'win32'
          ? path.join(root, link.target)
          : path.relative(path.dirname(destination), path.join(stage, link.target));
        fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
      }
      fs.writeFileSync(path.join(stage, '.complete'), id);
      try { fs.renameSync(stage, root); } catch (error) { if (!ready()) throw error; }
    } finally { fs.rmSync(stage, {recursive: true, force: true}); }
  }
  const main = path.join(root, 'app', 'dist', 'main.js');
  const worker = path.join(root, 'app', 'dist', 'studio', 'driver-worker.js');
  // fork() executes this SEA again and supplies the extracted entry as argv[2].
  const requested = process.argv[2];
  const entry = requested === main || requested === worker ? requested : main;
  if (requested === main || requested === worker) process.argv.splice(1, 1);
  import(pathToFileURL(entry).href).catch(error => { console.error(error); process.exitCode = 1; });
} catch (error) {
  console.error('Unable to initialize emcli runtime:', error.message);
  process.exitCode = 1;
}
