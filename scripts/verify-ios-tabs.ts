import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Verify the compiled fix, not the patched source or CocoaPods version string.
// Release archives are thin arm64 Mach-O binaries; reject other inputs explicitly.
const executable = process.argv[2] ?? "";
assert(executable, "Usage: node scripts/verify-ios-tabs.ts <Kanvil.app/Kanvil>");
const binary = readFileSync(executable);
assert.equal(binary.readUInt32LE(0), 0xfeedfacf, "Expected a thin Mach-O executable");
assert.equal(binary.readUInt32LE(4), 0x100000c, "Expected an arm64 executable");
const segments: { address: number; size: number; offset: number }[] = [];
let command = 32;
for (let index = 0; index < binary.readUInt32LE(16); index++) {
  if (binary.readUInt32LE(command) === 0x19) {
    segments.push({
      address: Number(binary.readBigUInt64LE(command + 24)),
      offset: Number(binary.readBigUInt64LE(command + 40)),
      size: Number(binary.readBigUInt64LE(command + 48)),
    });
  }
  command += binary.readUInt32LE(command + 4);
}
function offset(address: number) {
  const segment = segments.find(
    (entry) => address >= entry.address && address < entry.address + entry.size,
  );
  assert(segment, `Unmapped Mach-O address: ${address.toString(16)}`);
  return segment.offset + address - segment.address;
}
function dump(...args: string[]) {
  return execFileSync("xcrun", ["llvm-objdump", ...args, executable], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
const metadata = dump("--macho", "--objc-meta-data");
const stubs = dump("--macho", "--section=__objc_stubs", "--no-show-raw-insn");
function methodCalls(className: string, methodName: string, classMethod = false) {
  const host = metadata.split(` ${className}\n`)[classMethod ? 2 : 1];
  assert(host, `${className} is missing`);
  const methods = host.match(/baseMethods\s+(0x[\da-f]+)/);
  assert(methods, `${className} method table is missing`);
  const table = Number(methods[1]);
  const format = binary.readUInt32LE(offset(table));
  assert.equal(format >>> 30, 2, "Expected relative, indirect Objective-C methods");
  assert.equal(format & 0xffff, 12, "Unexpected Objective-C method entry size");
  const implementations: number[] = [];
  let attach: number | undefined;
  for (let index = 0; index < binary.readUInt32LE(offset(table) + 4); index++) {
    const entry = table + 8 + index * 12;
    const selectorReference = entry + binary.readInt32LE(offset(entry));
    // DYLD_CHAINED_PTR_64_OFFSET stores the selector's image-relative target in 36 bits.
    const selector =
      Number(binary.readBigUInt64LE(offset(selectorReference)) & 0xfffffffffn) + 0x100000000;
    const nameStart = offset(selector);
    const name = binary.toString("utf8", nameStart, binary.indexOf(0, nameStart));
    const implementation = entry + 8 + binary.readInt32LE(offset(entry) + 8);
    implementations.push(implementation);
    if (name === methodName) attach = implementation;
  }
  assert(attach, `${className}.${methodName} is missing`);
  const end = Math.min(...implementations.filter((address) => address > attach));
  assert(Number.isFinite(end), "Cannot determine the attachment method boundary");
  const assembly = dump(
    "--disassemble",
    "--no-show-raw-insn",
    `--start-address=${attach}`,
    `--stop-address=${end}`,
  );
  return [...assembly.matchAll(/\bbl\s+0x([\da-f]+)/g)].flatMap((call) => {
    const start = stubs.indexOf(`\n${call[1]}:`);
    if (start < 0) return [];
    const selector = stubs.slice(start).split("\n").slice(0, 4).join("\n");
    const name = selector.match(/Objc selector ref: (.+)/)?.[1];
    return name ? [name] : [];
  });
}
const calls = methodCalls("RNSTabsHostComponentView", "didMoveToWindow");
const mount = calls.indexOf("addChildViewController:toViewControllerManaging:withContainerView:");
const bounds = calls.indexOf("bounds");
const view = calls.indexOf("view", bounds + 1);
const frame = calls.indexOf("setFrame:", view + 1);
assert(
  bounds >= 0 && view > bounds && frame > view && mount > frame,
  `Native tabs must size their view before attachment. Compiled calls: ${calls.join(", ")}`,
);
const heightCalls = methodCalls("RNSScreen", "calculateHeaderHeightIsModal:");
assert(
  heightCalls.includes("minimizationEnabled") && heightCalls.includes("convertRect:toView:"),
  "Stable pane header measurement is missing from the compiled executable",
);
const edgeCalls = methodCalls("RNSScreenView", "updateContentScrollViewEdgeEffectsIfExists");
assert(
  edgeCalls.includes("setContentScrollView:forEdge:"),
  "Native content-scroll association is missing from the compiled executable",
);
const headerCalls = methodCalls(
  "RNSScreenStackHeaderConfig",
  "updateViewController:withConfig:animated:",
  true,
);
assert(
  headerCalls.includes("setVerticalBarCompressionBehavior:"),
  "Native bar-item compression preference is missing from the compiled executable",
);
assert(
  headerCalls.includes("configureTitle:attributes:") &&
    methodCalls("RNSGlassTitleView", "init").includes("effectWithStyle:"),
  "Native content-sized glass title is missing from the compiled executable",
);
assert(
  !metadata.includes("RNSScrollLegibilityMask") && !metadata.includes("RNSScrollEdgeBackdrop"),
  "A rejected scroll-content mask or backdrop remains in the executable",
);
console.log(
  JSON.stringify(
    {
      executable,
      tabSizingBeforeAttachment: true,
      headerMinimizationOverride: true,
      stablePaneHeaderMeasurement: true,
      nativeTitleGlass: true,
      noScrollContentMask: true,
      preferRailActions: true,
      heightCalls,
      calls,
    },
    null,
    2,
  ),
);
