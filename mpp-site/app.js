import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseUnits,
  formatUnits,
  getAddress,
} from "https://esm.sh/viem@2.21.0";
import {
  avalanche,
  avalancheFuji,
} from "https://esm.sh/viem@2.21.0/chains";

// ─── Config ─────────────────────────────────────────────────

const API_BASE = window.location.origin; // service runs on same origin
const USDC_DECIMALS = 6;
const PRICE_PER_REQUEST = parseUnits("0.10", USDC_DECIMALS); // 100000

// Fuji testnet config (default)
const CHAIN = avalancheFuji;
const CHAIN_ID = 43113;
const STREAM_CHANNEL = "0x6e2DD66C1bfb66a2b579D291CdF6EA559E93619b";
const USDC_ADDRESS = "0x5425890298aed601595a70AB815c96711a31Bc65";

const streamChannelAbi = [
  { type: "function", name: "open", inputs: [{ name: "payee", type: "address" }, { name: "token", type: "address" }, { name: "deposit", type: "uint128" }, { name: "salt", type: "bytes32" }, { name: "authorizedSigner", type: "address" }], outputs: [{ name: "channelId", type: "bytes32" }], stateMutability: "nonpayable" },
  { type: "function", name: "settle", inputs: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint128" }, { name: "signature", type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "close", inputs: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint128" }, { name: "signature", type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getChannel", inputs: [{ name: "channelId", type: "bytes32" }], outputs: [{ name: "", type: "tuple", components: [{ name: "finalized", type: "bool" }, { name: "closeRequestedAt", type: "uint64" }, { name: "payer", type: "address" }, { name: "payee", type: "address" }, { name: "token", type: "address" }, { name: "authorizedSigner", type: "address" }, { name: "deposit", type: "uint128" }, { name: "settled", type: "uint128" }] }], stateMutability: "view" },
  { type: "function", name: "computeChannelId", inputs: [{ name: "payer", type: "address" }, { name: "payee", type: "address" }, { name: "token", type: "address" }, { name: "salt", type: "bytes32" }, { name: "authorizedSigner", type: "address" }], outputs: [{ name: "", type: "bytes32" }], stateMutability: "view" },
];

const erc20Abi = [
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
];

// ─── State ──────────────────────────────────────────────────

let walletClient = null;
let publicClient = null;
let account = null;
let channelId = null;
let payeeAddress = null;
let requestCount = 0;
let cumulativeAmount = 0n;

// ─── Logging ────────────────────────────────────────────────

function apiLog(label, content, type = "info") {
  const el = document.getElementById("api-log");
  const time = new Date().toLocaleTimeString();
  const colors = { req: "var(--blue)", res: "var(--green)", err: "var(--accent)", info: "var(--text-muted)" };
  const color = colors[type] || colors.info;

  el.innerHTML += `<div class="log-entry" style="margin-bottom:12px;">` +
    `<div style="color:${color}; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">[${time}] ${label}</div>` +
    `<pre style="margin:4px 0 0; padding:8px 12px; background:var(--bg-soft); border:1px solid var(--border); border-radius:6px; font-size:11px; white-space:pre-wrap; word-break:break-all;"><code>${content}</code></pre>` +
    `</div>`;
  el.scrollTop = el.scrollHeight;
}

// ─── Copy helper ────────────────────────────────────────────

window.copyText = function (text) {
  navigator.clipboard.writeText(text);
};

// ─── Tab switching ──────────────────────────────────────────

window.switchTab = function (e, tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  e.target.classList.add("active");
  document.getElementById(tabId).classList.add("active");
};

// ─── Custom query toggle ────────────────────────────────────

document.getElementById("api-query").addEventListener("change", (e) => {
  document.getElementById("custom-query-row").style.display =
    e.target.value === "custom" ? "block" : "none";
});

// ─── 1. Call without payment ────────────────────────────────

window.apiCallNoPay = async function () {
  apiLog("POST /api/data (no voucher)", `Request:\n  POST ${API_BASE}/api/data\n  Body: {"query": "AVAX price"}\n  (no MPP headers)`, "req");

  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "AVAX price" }),
    });
    const data = await res.json();
    apiLog(`${res.status} ${res.status === 402 ? "Payment Required" : "OK"}`,
      JSON.stringify(data, null, 2),
      res.status === 402 ? "err" : "res"
    );
  } catch (e) {
    apiLog("Error", `Service unreachable: ${e.message}\n\nMake sure the service is running:\n  cd mpp-example && npm run service`, "err");
  }
};

// ─── 2. Discover MPP pricing ────────────────────────────────

window.apiDiscoverMpp = async function () {
  apiLog("GET /.well-known/mpp", `Request:\n  GET ${API_BASE}/.well-known/mpp`, "req");

  try {
    const res = await fetch(`${API_BASE}/.well-known/mpp`);
    const data = await res.json();
    payeeAddress = data.payee;
    apiLog("200 OK — Payment terms", JSON.stringify(data, null, 2), "res");
  } catch (e) {
    apiLog("Error", `Service unreachable: ${e.message}`, "err");
  }
};

// ─── 3. Wallet + Channel ────────────────────────────────────

window.connectWallet = async function () {
  if (!window.ethereum) {
    apiLog("Error", "No wallet detected. Install MetaMask or Core Wallet.", "err");
    return;
  }

  try {
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = getAddress(addr);

    // Switch to Fuji
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xA869" }],
      });
    } catch (e) { /* ignore */ }

    walletClient = createWalletClient({
      account,
      chain: CHAIN,
      transport: custom(window.ethereum),
    });

    publicClient = createPublicClient({
      chain: CHAIN,
      transport: custom(window.ethereum),
    });

    window.ethereum.on("accountsChanged", (accounts) => {
      if (accounts.length === 0) return;
      account = getAddress(accounts[0]);
      walletClient = createWalletClient({ account, chain: CHAIN, transport: custom(window.ethereum) });
      publicClient = createPublicClient({ chain: CHAIN, transport: custom(window.ethereum) });
      refreshUI();
    });

    document.getElementById("wallet-dot").classList.add("connected");
    document.getElementById("connect-btn").textContent = "Connected";
    document.getElementById("connect-btn").disabled = true;
    document.getElementById("approve-btn").disabled = false;
    document.getElementById("open-btn").disabled = false;

    await refreshUI();
    apiLog("Wallet connected", `Address: ${account}\nChain: Avalanche Fuji (43113)`, "info");
  } catch (err) {
    apiLog("Connection failed", err.message, "err");
  }
};

async function refreshUI() {
  if (!account || !publicClient) return;
  document.getElementById("wallet-addr").textContent = account.slice(0, 6) + "..." + account.slice(-4);
  try {
    const bal = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account],
    });
    document.getElementById("wallet-bal").textContent = `${formatUnits(bal, USDC_DECIMALS)} USDC`;
  } catch (e) {
    document.getElementById("wallet-bal").textContent = "";
  }
}

window.approveToken = async function () {
  const amount = document.getElementById("deposit-amount").value || "1";
  const wei = parseUnits(amount, USDC_DECIMALS);

  apiLog("Approving USDC", `Amount: ${amount} USDC\nSpender: ${STREAM_CHANNEL}`, "info");

  try {
    const hash = await walletClient.writeContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve",
      args: [STREAM_CHANNEL, wei],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    apiLog("Approved", `tx: ${hash}`, "res");
  } catch (err) {
    apiLog("Approve failed", err.shortMessage || err.message, "err");
  }
};

window.openChannel = async function () {
  if (!payeeAddress) {
    apiLog("Error", "Run step 2 first to discover the service's payee address.", "err");
    return;
  }

  const deposit = document.getElementById("deposit-amount").value || "1";
  const wei = parseUnits(deposit, USDC_DECIMALS);

  // Pre-flight
  try {
    const balance = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account],
    });
    if (balance < wei) {
      apiLog("Insufficient balance", `Have: ${formatUnits(balance, USDC_DECIMALS)} USDC, Need: ${deposit}`, "err");
      return;
    }
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account, STREAM_CHANNEL],
    });
    if (allowance < wei) {
      apiLog("Insufficient allowance", `Approved: ${formatUnits(allowance, USDC_DECIMALS)}, Need: ${deposit}. Click Approve first.`, "err");
      return;
    }
  } catch (e) {
    apiLog("Pre-flight failed", `${e.shortMessage || e.message}\nIs your wallet on Fuji testnet?`, "err");
    return;
  }

  const salt = "0x" + Date.now().toString(16).padEnd(64, "0");

  apiLog("Opening channel", `Payee: ${payeeAddress}\nDeposit: ${deposit} USDC\nToken: USDC (${USDC_ADDRESS})`, "info");

  try {
    const hash = await walletClient.writeContract({
      address: STREAM_CHANNEL, abi: streamChannelAbi, functionName: "open",
      args: [payeeAddress, USDC_ADDRESS, wei, salt, "0x0000000000000000000000000000000000000000"],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    channelId = await publicClient.readContract({
      address: STREAM_CHANNEL, abi: streamChannelAbi, functionName: "computeChannelId",
      args: [account, payeeAddress, USDC_ADDRESS, salt, "0x0000000000000000000000000000000000000000"],
    });

    // Reset counters
    requestCount = 0;
    cumulativeAmount = 0n;

    // Show channel info
    document.getElementById("channel-info").style.display = "block";
    document.getElementById("active-channel-id").textContent = channelId;
    document.getElementById("paid-call-btn").disabled = false;
    document.getElementById("request-count").textContent = "0";
    document.getElementById("total-paid").textContent = "0.00 USDC";

    await refreshUI();
    apiLog("Channel opened", `Channel ID: ${channelId}\nDeposit: ${deposit} USDC escrowed\ntx: ${hash}`, "res");
  } catch (err) {
    apiLog("Open failed", err.shortMessage || err.message, "err");
  }
};

// ─── 4. Make paid API calls ─────────────────────────────────

window.apiCallWithPayment = async function () {
  if (!channelId || !walletClient) {
    apiLog("Error", "Open a channel first (step 3).", "err");
    return;
  }

  // Get query
  const querySelect = document.getElementById("api-query").value;
  const query = querySelect === "custom"
    ? document.getElementById("custom-query").value || "hello"
    : querySelect;

  // Bump cumulative amount
  cumulativeAmount += PRICE_PER_REQUEST;
  requestCount++;

  apiLog(`Signing voucher #${requestCount}`,
    `Cumulative: ${formatUnits(cumulativeAmount, USDC_DECIMALS)} USDC\nType: EIP-712 signTypedData\nGas cost: 0`,
    "info"
  );

  // Sign EIP-712 voucher
  let signature;
  try {
    signature = await walletClient.signTypedData({
      domain: {
        name: "Tempo Stream Channel",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: STREAM_CHANNEL,
      },
      types: {
        Voucher: [
          { name: "channelId", type: "bytes32" },
          { name: "cumulativeAmount", type: "uint128" },
        ],
      },
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount },
    });
  } catch (err) {
    cumulativeAmount -= PRICE_PER_REQUEST;
    requestCount--;
    apiLog("Signing rejected", err.message, "err");
    return;
  }

  // Send real request to the MPP service
  const headers = {
    "Content-Type": "application/json",
    "X-MPP-Channel-Id": channelId,
    "X-MPP-Cumulative-Amount": cumulativeAmount.toString(),
    "X-MPP-Voucher": signature,
  };

  apiLog(`POST /api/data (request #${requestCount})`,
    `Headers:\n  X-MPP-Channel-Id: ${channelId.slice(0, 22)}...\n  X-MPP-Cumulative-Amount: ${cumulativeAmount.toString()}\n  X-MPP-Voucher: ${signature.slice(0, 22)}...\n\nBody: {"query": "${query}"}`,
    "req"
  );

  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (res.ok) {
      apiLog(`200 OK — Data returned (paid ${formatUnits(cumulativeAmount, USDC_DECIMALS)} USDC)`,
        JSON.stringify(data, null, 2),
        "res"
      );
    } else {
      apiLog(`${res.status} Error`, JSON.stringify(data, null, 2), "err");
      // Revert counter on failure
      cumulativeAmount -= PRICE_PER_REQUEST;
      requestCount--;
    }
  } catch (e) {
    apiLog("Error", `Service unreachable: ${e.message}`, "err");
    cumulativeAmount -= PRICE_PER_REQUEST;
    requestCount--;
  }

  // Update UI counters
  document.getElementById("request-count").textContent = requestCount.toString();
  document.getElementById("total-paid").textContent = `${formatUnits(cumulativeAmount, USDC_DECIMALS)} USDC`;
};

// ─── Active nav tracking ────────────────────────────────────

const sections = document.querySelectorAll("section[id]");
const navLinks = document.querySelectorAll(".sidebar nav a");

window.addEventListener("scroll", () => {
  let current = "";
  sections.forEach((s) => {
    if (window.scrollY >= s.offsetTop - 100) current = s.id;
  });
  navLinks.forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === "#" + current);
  });
});

// ─── Init ───────────────────────────────────────────────────

document.getElementById("api-base-url").textContent = API_BASE;
