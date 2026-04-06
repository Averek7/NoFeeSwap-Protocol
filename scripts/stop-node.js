"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PID_FILE = path.join(ROOT, ".local", "hardhat-node.pid");

if (!fs.existsSync(PID_FILE)) {
  console.log("No PID file found.");
  process.exit(0);
}

const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
if (pid) {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid);
    } else {
      process.kill(pid);
    }
    console.log(`Stopped Hardhat node with PID ${pid}`);
  } catch (error) {
    try {
      process.kill(pid);
      console.log(`Stopped Hardhat node with PID ${pid}`);
    } catch {
      console.log("PID file existed, but the process was not running.");
    }
  }
}

fs.rmSync(PID_FILE, { force: true });
