const { withAppDelegate } = require("expo/config-plugins");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// AppDelegate owns the pre-JS lifecycle. A config plugin keeps that hook reproducible
// without checking in the generated iOS project or changing Expo's delegate.
function injectStartupDiagnostics(contents) {
  const begin = "// BEGIN KANVIL STARTUP DIAGNOSTICS";
  const end = "// END KANVIL STARTUP DIAGNOSTICS";
  const start = contents.indexOf(begin);
  if (start >= 0) {
    const finish = contents.indexOf(end, start);
    if (finish < 0) throw new Error("Unterminated startup diagnostics block");
    contents = contents.slice(0, start) + contents.slice(finish + end.length);
  }
  const call = "    KanvilStartupDiagnostics.startIfEnabled()\n";
  contents = contents.replaceAll(call, "");
  const anchor = "    let delegate = ReactNativeDelegate()";
  if (!contents.includes(anchor)) throw new Error("Unrecognized Swift AppDelegate startup hook");
  if (!contents.includes("import UIKit")) contents = `import UIKit\n${contents}`;
  const source = readFileSync(join(__dirname, "StartupDiagnostics.swift"), "utf8");
  return `${contents.replace(anchor, call + anchor).trimEnd()}\n\n${begin}\n${source}\n${end}\n`;
}
module.exports = (config) =>
  withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift")
      throw new Error("Startup diagnostics require Swift AppDelegate");
    mod.modResults.contents = injectStartupDiagnostics(mod.modResults.contents);
    return mod;
  });
module.exports.injectStartupDiagnostics = injectStartupDiagnostics;
