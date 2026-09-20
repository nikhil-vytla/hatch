import { spawn } from "node:child_process";
const children = [
  spawn("bun", ["run", "server"], { stdio: "inherit" }),
  spawn("bun", ["run", "dev"], { stdio: "inherit" }),
];
const stop = () => {
  for (const child of children) child.kill();
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
