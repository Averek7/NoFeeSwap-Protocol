"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { compileRepo, getArtifact } = require("./lib/compiler");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(ROOT, "..");
const DEPLOYMENTS_DIR = path.join(ROOT, "deployments");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SAMPLE_KERNEL = [
  [0n, 0n],
  [5793624167011548n, 32768n]
];
const SAMPLE_CURVE = [
  9032182439343394724n,
  9037976063510406272n,
  9034475293004730351n
];
const SAMPLE_POOL_GROWTH_PORTION = 0x800000000000n;
const SAMPLE_UNSALTED_POOL_ID = 1n << 188n;
const SALT_ONE = ethers.toBeHex(1n, 32);
const SALT_TWO = ethers.toBeHex(2n, 32);

function resolveRepoDir(name) {
  const candidates = [
    path.join(ROOT, name),
    path.join(WORKSPACE, name)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "contracts"))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate '${name}' repository. Expected one of:\n` +
    candidates.map((entry) => `- ${entry}`).join("\n")
  );
}

function assertSubmodulesReady(repoRoot, repoName) {
  const expectedSources = [
    path.join(repoRoot, "lib", "openzeppelin-contracts", "contracts"),
    path.join(repoRoot, "lib", "solady", "src")
  ];

  const missing = expectedSources.filter((entry) => !fs.existsSync(entry));
  if (missing.length > 0) {
    throw new Error(
      `${repoName} submodules are not initialized.\n` +
      `Missing:\n${missing.map((entry) => `- ${entry}`).join("\n")}\n` +
      `Run:\n` +
      `  git -C ${repoRoot} submodule update --init --recursive`
    );
  }
}

async function waitForNode(provider, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await provider.getBlockNumber();
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Unable to reach local RPC at ${RPC_URL}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function encodeKernelCompact(kernel) {
  let bitLength = 0n;
  let packed = 0n;

  for (const [horizontal, vertical] of kernel.slice(1)) {
    packed <<= 16n;
    packed += BigInt(vertical);
    packed <<= 64n;
    packed += BigInt(horizontal);
    bitLength += 80n;
  }

  if (bitLength % 256n !== 0n) {
    const padding = 256n - (bitLength % 256n);
    packed <<= padding;
    bitLength += padding;
  }

  const words = [];
  let remaining = bitLength / 256n;
  while (remaining > 0n) {
    words.unshift(packed & ((1n << 256n) - 1n));
    packed >>= 256n;
    remaining -= 1n;
  }

  return words;
}

function encodeCurve(curve) {
  const result = new Array(Math.floor((curve.length + 3) / 4)).fill(0n);
  let shift = 192n;
  let index = 0;

  for (const point of curve) {
    result[Math.floor(index / 4)] += BigInt(point) << shift;
    shift = (shift - 64n + 256n) % 256n;
    index += 1;
  }

  return result;
}

function computePoolId(ownerAddress, unsaltedPoolId) {
  const packed = ethers.solidityPacked(["address", "uint256"], [ownerAddress, unsaltedPoolId]);
  const hash = BigInt(ethers.keccak256(packed));
  return (BigInt(unsaltedPoolId) + ((hash << 188n) & ((1n << 256n) - 1n))) & ((1n << 256n) - 1n);
}

async function deployContract(signer, artifact, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function normalizeAddressOrder(addressA, addressB) {
  return BigInt(addressA) < BigInt(addressB)
    ? [addressA, addressB]
    : [addressB, addressA];
}

function saveArtifacts(name, compilation) {
  ensureDir(ARTIFACTS_DIR);
  writeJson(path.join(ARTIFACTS_DIR, `${name}.json`), compilation.output);
}

async function main() {
  const CORE_ROOT = resolveRepoDir("core");
  const OPERATOR_ROOT = resolveRepoDir("operator");
  assertSubmodulesReady(CORE_ROOT, "core");
  assertSubmodulesReady(OPERATOR_ROOT, "operator");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  await waitForNode(provider);
  console.log("Connected to local RPC:", RPC_URL);

  const root = await provider.getSigner(0);
  const owner = await provider.getSigner(1);
  const other = await provider.getSigner(2);

  console.log("Compiling core contracts...");
  const coreCompilation = compileRepo(CORE_ROOT, [
    "contracts/Nofeeswap.sol",
    "contracts/NofeeswapDelegatee.sol",
    "contracts/helpers/Access.sol",
    "contracts/helpers/MockHook.sol",
    "contracts/helpers/ERC20FixedSupply.sol",
    "contracts/helpers/DeployerHelper.sol"
  ]);

  console.log("Compiling operator contracts...");
  const operatorCompilation = compileRepo(OPERATOR_ROOT, [
    "contracts/Operator.sol"
  ]);

  saveArtifacts("core", coreCompilation);
  saveArtifacts("operator", operatorCompilation);

  const deployerHelperArtifact = getArtifact(
    coreCompilation,
    "contracts/helpers/DeployerHelper.sol",
    "DeployerHelper"
  );
  const nofeeswapArtifact = getArtifact(
    coreCompilation,
    "contracts/Nofeeswap.sol",
    "Nofeeswap"
  );
  const delegateeArtifact = getArtifact(
    coreCompilation,
    "contracts/NofeeswapDelegatee.sol",
    "NofeeswapDelegatee"
  );
  const accessArtifact = getArtifact(
    coreCompilation,
    "contracts/helpers/Access.sol",
    "Access"
  );
  const mockHookArtifact = getArtifact(
    coreCompilation,
    "contracts/helpers/MockHook.sol",
    "MockHook"
  );
  const erc20Artifact = getArtifact(
    coreCompilation,
    "contracts/helpers/ERC20FixedSupply.sol",
    "ERC20FixedSupply"
  );
  const operatorArtifact = getArtifact(
    operatorCompilation,
    "contracts/Operator.sol",
    "Operator"
  );

  console.log("Deploying core contracts...");
  const deployer = await deployContract(root, deployerHelperArtifact, [await root.getAddress()]);
  const delegateeAddress = await deployer.addressOf(SALT_ONE);
  const nofeeswapAddress = await deployer.addressOf(SALT_TWO);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const delegateeInitCode =
    delegateeArtifact.bytecode +
    abiCoder.encode(["address"], [nofeeswapAddress]).slice(2);
  const nofeeswapInitCode =
    nofeeswapArtifact.bytecode +
    abiCoder.encode(["address", "address"], [delegateeAddress, await root.getAddress()]).slice(2);

  const tx1 = await deployer.create3(SALT_ONE, delegateeInitCode);
  await tx1.wait();
  const tx2 = await deployer.create3(SALT_TWO, nofeeswapInitCode);
  await tx2.wait();

  const delegatee = new ethers.Contract(delegateeAddress, delegateeArtifact.abi, root);
  const nofeeswap = new ethers.Contract(nofeeswapAddress, nofeeswapArtifact.abi, root);
  const access = await deployContract(root, accessArtifact);
  const hook = await deployContract(root, mockHookArtifact);
  const operator = await deployContract(root, operatorArtifact, [
    nofeeswapAddress,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    ZERO_ADDRESS
  ]);

  console.log("Deploying mock tokens...");
  const tokenSupply = 1n << 120n;
  const token0 = await deployContract(owner, erc20Artifact, [
    "ERC20_0",
    "ERC20_0",
    tokenSupply,
    await owner.getAddress()
  ]);
  const token1 = await deployContract(owner, erc20Artifact, [
    "ERC20_1",
    "ERC20_1",
    tokenSupply,
    await owner.getAddress()
  ]);

  await (await token0.connect(owner).approve(operator.target, tokenSupply)).wait();
  await (await token1.connect(owner).approve(operator.target, tokenSupply)).wait();
  await (await nofeeswap.connect(root).setOperator(operator.target, true)).wait();
  await (await nofeeswap.connect(owner).setOperator(operator.target, true)).wait();

  console.log("Configuring protocol and initializing sample pool...");
  const modifyProtocolValue =
    (123n << 208n) + (456n << 160n) + BigInt(await root.getAddress());
  await (
    await nofeeswap.dispatch(
      delegatee.interface.encodeFunctionData("modifyProtocol", [modifyProtocolValue])
    )
  ).wait();

  const [tag0Address, tag1Address] = normalizeAddressOrder(token0.target, token1.target);
  const encodedKernel = encodeKernelCompact(SAMPLE_KERNEL);
  const encodedCurve = encodeCurve(SAMPLE_CURVE);

  await (
    await nofeeswap.connect(owner).dispatch(
      delegatee.interface.encodeFunctionData("initialize", [
        SAMPLE_UNSALTED_POOL_ID,
        BigInt(tag0Address),
        BigInt(tag1Address),
        SAMPLE_POOL_GROWTH_PORTION,
        encodedKernel,
        encodedCurve,
        "0x"
      ])
    )
  ).wait();

  const ownerAddress = await owner.getAddress();
  const output = {
    rpcUrl: RPC_URL,
    chainId: Number((await provider.getNetwork()).chainId),
    deployer: {
      root: await root.getAddress(),
      owner: ownerAddress,
      other: await other.getAddress()
    },
    contracts: {
      deployerHelper: deployer.target,
      nofeeswap: nofeeswap.target,
      nofeeswapDelegatee: delegatee.target,
      operator: operator.target,
      access: access.target,
      hook: hook.target
    },
    mockTokens: {
      token0: token0.target,
      token1: token1.target,
      ownerBalanceToken0: (await token0.balanceOf(ownerAddress)).toString(),
      ownerBalanceToken1: (await token1.balanceOf(ownerAddress)).toString()
    },
    samplePool: {
      owner: ownerAddress,
      unsaltedPoolId: SAMPLE_UNSALTED_POOL_ID.toString(),
      poolId: computePoolId(ownerAddress, SAMPLE_UNSALTED_POOL_ID).toString(),
      token0Tag: BigInt(tag0Address).toString(),
      token1Tag: BigInt(tag1Address).toString(),
      poolGrowthPortion: SAMPLE_POOL_GROWTH_PORTION.toString(),
      kernelCompact: encodedKernel.map((value) => value.toString()),
      curve: SAMPLE_CURVE.map((value) => value.toString())
    }
  };

  writeJson(path.join(DEPLOYMENTS_DIR, "local.json"), output);

  console.log("Deployment complete.");
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
