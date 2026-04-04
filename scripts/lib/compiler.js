"use strict";

const fs = require("fs");
const path = require("path");
const solc = require("solc");

function readRemappings(repoRoot) {
  const remappingsPath = path.join(repoRoot, "remappings.txt");
  if (!fs.existsSync(remappingsPath)) {
    return [];
  }

  return fs
    .readFileSync(remappingsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractImports(content) {
  const matches = content.matchAll(/import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g);
  return Array.from(matches, (match) => match[1]);
}

function normalizeSourceName(sourceName) {
  return path.posix.normalize(sourceName).replace(/^\.\//, "");
}

function resolveImport(sourceName, importPath, remappings) {
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    return normalizeSourceName(
      path.posix.join(path.posix.dirname(sourceName), importPath)
    );
  }

  for (const remapping of remappings) {
    const [prefix, target] = remapping.split("=");
    if (importPath.startsWith(prefix)) {
      return normalizeSourceName(importPath.replace(prefix, target));
    }
  }

  return normalizeSourceName(importPath);
}

function loadSourceGraph(repoRoot, sourceNames, remappings, sources = {}) {
  for (const sourceName of sourceNames) {
    if (sources[sourceName]) {
      continue;
    }

    const diskPath = path.join(repoRoot, sourceName);
    if (!fs.existsSync(diskPath)) {
      throw new Error(`Missing Solidity source: ${diskPath}`);
    }

    const content = fs.readFileSync(diskPath, "utf8");
    sources[sourceName] = { content };

    const imports = extractImports(content).map((importPath) =>
      resolveImport(sourceName, importPath, remappings)
    );
    loadSourceGraph(repoRoot, imports, remappings, sources);
  }

  return sources;
}

function compileRepo(repoRoot, sourceNames) {
  const remappings = readRemappings(repoRoot);
  const normalizedSourceNames = sourceNames.map(normalizeSourceName);
  const input = {
    language: "Solidity",
    sources: loadSourceGraph(repoRoot, normalizedSourceNames, remappings),
    settings: {
      optimizer: {
        enabled: true,
        runs: 500
      },
      viaIR: true,
      evmVersion: "cancun",
      remappings,
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    const message = errors.map((entry) => entry.formattedMessage).join("\n");
    throw new Error(message);
  }

  const selected = {};
  for (const sourceName of normalizedSourceNames) {
    if (!output.contracts[sourceName]) {
      throw new Error(`Missing compiled source: ${sourceName}`);
    }
    selected[sourceName] = output.contracts[sourceName];
  }

  return { input, output, contracts: selected };
}

function getArtifact(compilation, sourceName, contractName) {
  const contract = compilation.output.contracts?.[sourceName]?.[contractName];
  if (!contract) {
    throw new Error(`Artifact not found for ${sourceName}:${contractName}`);
  }

  const bytecode = contract.evm?.bytecode?.object;
  if (!bytecode) {
    throw new Error(`No bytecode for ${sourceName}:${contractName}`);
  }

  return {
    abi: contract.abi,
    bytecode: `0x${bytecode}`
  };
}

module.exports = {
  compileRepo,
  getArtifact
};
