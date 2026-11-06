// Compatibility shim: the running OpenCode server cached this path as
// the plugin entrypoint before the rename to main.ts. Fresh installs
// resolve package.json exports ("./src/main.ts") directly.
export { default } from "./main.ts"
