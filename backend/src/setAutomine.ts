import { DEPLOYMENT } from "./config";

async function main() {
  const mode = process.argv[2];
  if (mode !== "on" && mode !== "off") {
    throw new Error("Usage: npm run automine:on or npm run automine:off");
  }

  const enabled = mode === "on";
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "evm_setAutomine",
    params: [enabled]
  };

  const response = await fetch(DEPLOYMENT.rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message ?? "Failed to set automine");
  }

  console.log(`Automine ${enabled ? "enabled" : "disabled"}.`);
  if (!enabled) {
    console.log("Transactions will remain pending until you mine manually or re-enable automine.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
