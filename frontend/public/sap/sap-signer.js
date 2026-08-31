(function (root) {
  "use strict";

  const CERTIFICATE_URL = "https://s.mzstatic.com/sap/setupCert.plist";
  const SETUP_URL = "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy";
  const DEFAULT_PROXY_URL = "http://xiaobai.com/";
  const SCRIPT_BASE_URL = (() => {
    const script = typeof document === "undefined" ? null : document.currentScript;
    const base = script && script.src
      ? script.src
      : (typeof document === "undefined" ? "./" : document.baseURI);
    return new URL(".", base).href;
  })();
  const NATIVE_MEMORY_SHIMS = new Set([
    "_malloc", "_malloc_good_size", "_calloc", "_free",
    "_memcpy", "_memmove", "_memset", "___bzero",
    "___memcpy_chk", "___memset_chk", "_strlen", "_pthread_once",
    "_pthread_mutex_lock", "_pthread_mutex_unlock",
    "_pthread_rwlock_init", "_pthread_rwlock_init$UNIX2003",
    "_pthread_rwlock_unlock", "_pthread_rwlock_unlock$UNIX2003",
    "_pthread_rwlock_wrlock", "_pthread_rwlock_wrlock$UNIX2003"
  ]);

  let runtimePromise = null;
  let defaultSignerPromise = null;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = resolve;
      script.onerror = () => reject(new Error("load script failed: " + url));
      document.head.appendChild(script);
    });
  }

  function bytesToBase64(bytes) {
    let text = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(text);
  }

  function textToBase64(value) {
    return bytesToBase64(new TextEncoder().encode(value));
  }

  function base64ToBytes(value) {
    const text = atob(value);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
  }

  function unsigned64(value) {
    return BigInt.asUintN(64, BigInt(value));
  }

  function installShimBridge() {
    const registered = new Map();
    const nativeEntries = new Set();
    root.sapWasmShimHandled = false;

    root.sapWasmRegisterShim = (address, name) => {
      const value = BigInt(address);
      registered.set(value, name);
      if (NATIVE_MEMORY_SHIMS.has(name)) nativeEntries.add(value);
    };

    root.sapWasmTrapHook = (handle, address) => {
      root.sapWasmShimHandled = false;
      const current = unsigned64(address);
      const name = registered.get(current);
      if (name && NATIVE_MEMORY_SHIMS.has(name)) return;
      if (!name) {
        for (const start of nativeEntries) {
          if (current > start && current < start + 64n) return;
        }
      }
      handle.emu_stop();
    };
  }

  async function initialize(options) {
    if (runtimePromise) return runtimePromise;

    runtimePromise = (async () => {
      const unicornURL = options.unicornURL || new URL("unicorn_x86.js", SCRIPT_BASE_URL).href;
      const wasmExecURL = options.wasmExecURL || new URL("wasm_exec.js", SCRIPT_BASE_URL).href;
      const wasmURL = options.wasmURL || new URL("sap.wasm", SCRIPT_BASE_URL).href;

      if (typeof root.MUnicorn !== "function") await loadScript(unicornURL);
      if (typeof root.MUnicorn !== "function") throw new Error("Unicorn.js factory is unavailable");
      root.unicornModule = await root.MUnicorn();
      if (!root.unicornModule) throw new Error("Unicorn.js initialization failed");

      installShimBridge();
      if (typeof root.Go !== "function") await loadScript(wasmExecURL);
      if (typeof root.Go !== "function") throw new Error("Go WASM runtime is unavailable");

      const response = await fetch(wasmURL, { cache: "no-store" });
      if (!response.ok) throw new Error("load SAP WASM failed: " + response.status);
      const bytes = await response.arrayBuffer();
      const go = new root.Go();
      const compiled = await WebAssembly.instantiate(bytes, go.importObject);
      go.run(compiled.instance);

      const deadline = Date.now() + 30000;
      while (!root.sapWasmSignerReady) {
        if (Date.now() >= deadline) throw new Error("SAP WASM initialization timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();

    try {
      await runtimePromise;
    } catch (error) {
      runtimePromise = null;
      throw error;
    }
  }

  function proxyURL(proxyBase, upstream) {
    const target = new URL(proxyBase, document.baseURI);
    target.search = "";
    target.searchParams.set("url", upstream);
    return target.href;
  }

  // fetchImpl 注入点：允许宿主环境（如 libcurl）接管跨域请求；
  // directFetch 为 true 时直接请求 Apple 原始 URL，不再包装代理。
  function upstreamTarget(proxyBase, upstream, direct) {
    if (direct) return upstream;
    return proxyURL(proxyBase, upstream);
  }

  async function requestCertificate(proxyBase, fetchImpl, direct) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch(upstreamTarget(proxyBase, CERTIFICATE_URL, direct), { cache: "no-store" });
    if (!response.ok) throw new Error("fetch SAP setup certificate failed: " + response.status);
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  async function exchangeSetup(proxyBase, requestBase64, fetchImpl, direct) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch(upstreamTarget(proxyBase, SETUP_URL, direct), {
      method: "POST",
      headers: { "Content-Type": "application/x-plist" },
      body: base64ToBytes(requestBase64)
    });
    if (!response.ok) throw new Error("SAP setup request failed: " + response.status);
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  async function loadSapSigner(options) {
    options = options || {};
    await initialize(options);
    const proxyBase = options.proxyURL || DEFAULT_PROXY_URL;
    let queue = Promise.resolve();

    function sign(xml, signOptions) {
      const operation = queue.then(async () => {
        if (typeof xml !== "string" || xml.length === 0) throw new TypeError("xml must be a non-empty string");
        const mergedOptions = Object.assign({}, options, signOptions || {});
        const requestProxy = mergedOptions.proxyURL || proxyBase;
        const fetchImpl = mergedOptions.fetchImpl;
        const direct = mergedOptions.directFetch === true;
        const certificate = await requestCertificate(requestProxy, fetchImpl, direct);
        // Pass explicit UTF-8 bytes across the JS/WASM boundary. SAP signs
        // the exact request body, so an implicit string conversion is unsafe.
        const bodyBase64 = textToBase64(xml);
        const preparation = JSON.parse(root.sapWasmPrepareSetup(bodyBase64, certificate));
        if (preparation.error) throw new Error(preparation.error);
        const reply = await exchangeSetup(requestProxy, preparation.requestBase64, fetchImpl, direct);
        const completion = JSON.parse(root.sapWasmFinishSetup(reply));
        if (completion.error) throw new Error(completion.error);
        if (typeof completion.signatureBase64 !== "string" || completion.signatureBase64.length === 0) {
          throw new Error("SAP signer returned an empty signature");
        }
        return completion.signatureBase64;
      });
      queue = operation.catch(() => {});
      return operation;
    }

    return { sign };
  }

 function sapSign(xml, options) {
    if (!defaultSignerPromise) defaultSignerPromise = loadSapSigner(options || {});
   
    return defaultSignerPromise.then(signer => signer.sign(xml, options || {}));
  }

  root.loadSapSigner = loadSapSigner;
  root.sapSign = sapSign;
})(typeof globalThis === "undefined" ? window : globalThis);
