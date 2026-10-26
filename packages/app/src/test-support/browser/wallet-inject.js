// Injected into the page BEFORE any app script, by the test-only proxy.
//
// This is a FAKE LOCAL WALLET. It is not MetaMask, not a browser extension, and
// not a real EIP-6963 wallet. It exists only so the portal's real discovery and
// transaction code can be exercised against a local anvil chain.
//
// It never holds a private key: every write is forwarded to anvil, which signs
// for its own unlocked dev accounts.
//
// Contract with the app (unchanged app code):
//   - `window.ethereum` is set for the injected-provider fallback path
//   - `eip6963:requestProvider` is answered with `eip6963:announceProvider`
//   - `eth_accounts` / `eth_requestAccounts` report the selected account
//   - every other method is forwarded verbatim to the local RPC

(() => {
  // Same-origin RPC path, proxied by the test-only inject proxy to local anvil.
  const RPC_PATH = "__RPC_PATH__";
  const ACCOUNTS = __ACCOUNTS__;
  const CHAIN_ID = __CHAIN_ID__;
  const WALLET_NAME = "Fake Local Wallet (test)";

  let selected = 0;
  let rejectNextConnect = false;
  let id = 0;
  const handlers = new Map();

  function emit(event, ...args) {
    const set = handlers.get(event);
    if (!set) return;
    set.forEach((fn) => {
      try {
        fn.apply(null, args);
      } catch (_) {}
    });
  }

  function rpc(method, params) {
    return fetch(RPC_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: method, params: params || [] }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) {
          const err = new Error(`${method}: ${json.error.message}`);
          err.code = json.error.code;
          err.data = json.error.data;
          throw err;
        }
        return json.result;
      });
  }

  const provider = {
    isFakeLocalWallet: true,
    request: (args) => {
      const method = args.method;
      if (method === "eth_accounts" || method === "eth_requestAccounts") {
        if (method === "eth_requestAccounts" && rejectNextConnect) {
          rejectNextConnect = false;
          const rejected = new Error("User rejected the request.");
          rejected.code = 4001;
          return Promise.reject(rejected);
        }
        return Promise.resolve([ACCOUNTS[selected]]);
      }
      if (method === "eth_chainId") return Promise.resolve(`0x${CHAIN_ID.toString(16)}`);
      if (method === "wallet_switchEthereumChain") {
        const target = args.params?.[0]?.chainId;
        if (target && parseInt(target, 16) !== CHAIN_ID) {
          const unsupported = new Error("Unsupported chain");
          unsupported.code = 4902;
          return Promise.reject(unsupported);
        }
        return Promise.resolve(null);
      }
      if (method === "wallet_addEthereumChain") return Promise.resolve(null);
      return rpc(method, args.params);
    },
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    removeListener: (event, fn) => {
      const set = handlers.get(event);
      if (set) set.delete(fn);
    },
  };

  window.ethereum = provider;

  // EIP-6963 discovery handshake.
  const detail = {
    info: { uuid: "fake-local-wallet-0001", name: WALLET_NAME, icon: "", rdns: "test.fake.local" },
    provider: provider,
  };
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: detail }));
  });
  // Announce once shortly after load as well, so a late listener still sees it.
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: detail }));
  }, 0);

  // Test control surface. Deliberately namespaced and obviously non-production.
  window.__fakeLocalWallet = {
    accounts: ACCOUNTS,
    selectAccount: (index) => {
      if (index < 0 || index >= ACCOUNTS.length) throw new RangeError("account index out of range");
      selected = index;
      emit("accountsChanged", [ACCOUNTS[selected]]);
    },
    rejectNextConnect: () => {
      rejectNextConnect = true;
    },
    /** Simulate a chain change away from the configured chain. */
    emitChainChanged: (chainIdHex) => {
      emit("chainChanged", chainIdHex);
    },
    emitDisconnect: () => {
      emit("disconnect", { code: 4900, message: "disconnected" });
    },
    selected: () => ACCOUNTS[selected],
  };
})();
