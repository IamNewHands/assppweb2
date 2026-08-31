// 浏览器端 SAP 签名适配层
// 签名引擎（sap-signer.js + sap.wasm）作为静态资源放在 /sap/ 下，运行时动态加载。
// Apple SAP setup 请求（setupCert.plist / signSapSetup/legacy）要求 TLS 1.3，
// 浏览器侧 wasm TLS（node-forge）不支持（curl 错误码 35），因此统一走
// backend 的 /api/sap 代理（Node 原生 HTTPS），由代理转发到 Apple。
// 注意：依赖延迟加载，避免 node/测试环境引入额外模块。

const SAP_BASE = "/sap/";
const SIGNER_SCRIPT = `${SAP_BASE}sap-signer.js`;

let scriptLoading: Promise<void> | null = null;
let engineReady = false;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** 动态加载签名引擎脚本（幂等）。 */
function loadSignerScript(): Promise<void> {
  if (typeof (window as any).sapSign === "function") return Promise.resolve();
  if (scriptLoading) return scriptLoading;
  scriptLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SIGNER_SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoading = null;
      reject(new Error("加载 SAP 签名引擎失败"));
    };
    document.head.appendChild(script);
  });
  return scriptLoading;
}

/** 通过 backend /api/sap 代理转发 Apple SAP setup 请求。 */
async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const { authHeaders } = await import("../api/client");
  const proxied = `/api/sap?url=${encodeURIComponent(url)}`;
  return fetch(proxied, {
    method: init?.method ?? "GET",
    headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeaders() },
    body: init?.body,
    cache: "no-store",
  });
}

/**
 * 对登录请求 XML 生成 SAP 签名（Base64）。
 * 非浏览器环境（如单元测试）返回空字符串，跳过签名。
 */
export async function signSap(xml: string): Promise<string> {
  if (!isBrowser()) return "";
  await loadSignerScript();
  const w = window as any;
  if (!engineReady) {
    await w.loadSapSigner({
      wasmURL: `${SAP_BASE}sap.wasm`,
      unicornURL: `${SAP_BASE}unicorn_x86.js`,
      wasmExecURL: `${SAP_BASE}wasm_exec.js`,
    });
    engineReady = true;
  }
  // directFetch: fetchImpl 收到 Apple 原始 URL，由 proxiedFetch 转发到 backend 代理
  return w.sapSign(xml, { fetchImpl: proxiedFetch, directFetch: true });
}
