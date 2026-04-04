"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, ".local");
const PID_FILE = path.join(STATE_DIR, "hardhat-node.pid");
const LOG_FILE = path.join(STATE_DIR, "hardhat-node.log");
const ERR_FILE = path.join(STATE_DIR, "hardhat-node.err.log");
const HARDHAT_CMD = path.join(ROOT, "node_modules", ".bin", "hardhat.cmd");

fs.mkdirSync(STATE_DIR, { recursive: true });

if (fs.existsSync(PID_FILE)) {
  const existingPid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  if (existingPid) {
    try {
      process.kill(existingPid, 0);
      console.log(`Hardhat node already running with PID ${existingPid}`);
      process.exit(0);
    } catch (error) {
      fs.rmSync(PID_FILE, { force: true });
    }
  }
}

const outFd = fs.openSync(LOG_FILE, "a");
const errFd = fs.openSync(ERR_FILE, "a");
const child = spawn("cmd.exe", ["/c", HARDHAT_CMD, "node"], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", outFd, errFd]
});

child.unref();
fs.writeFileSync(PID_FILE, String(child.pid));

console.log(`Started Hardhat node with PID ${child.pid}`);
console.log(`Log: ${LOG_FILE}`);
