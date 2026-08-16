import { pathToFileURL } from "node:url"
const { register } = await import("tsx/esm/api")
register()
console.log("  wrapper pid=" + process.pid)
await import(pathToFileURL("/tmp/tsxtest/sleeper.ts").href)
