const { withPodfile } = require("expo/config-plugins");

// The installed Screens version compiles SplitView as stubs unless this flag is set.
// No existing Expo plugin exposes it; keep it in prebuild rather than a generated Podfile.
module.exports = function withNativeSplit(config) {
  return withPodfile(config, (mod) => {
    const flag = "ENV['RNS_GAMMA_ENABLED'] = '1'";
    if (!mod.modResults.contents.includes(flag))
      mod.modResults.contents = `${flag}\n${mod.modResults.contents}`;
    return mod;
  });
};
