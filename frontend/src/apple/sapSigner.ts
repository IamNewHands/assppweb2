// 浏览器端 SAP 签名适配层
// 签名引擎（sap-signer.js + sap.wasm）作为静态资源放在 /sap/ 下，
// 运行时动态加载；跨域的 Apple SAP setup 请求复用 libcurl（绕过 CORS），
// 因此无需后端代理。
// 注意：libcurl 相关依赖延迟到真正发请求时才动态加载，
// 避免在 node/测试环境引入 wasm 包。

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

/** libcurl fetch 适配：输出 sap-signer 需要的 fetch-like Response。 */
async function libcurlFetch(url: string, init?: RequestInit): Promise<ResponseLike> {
  const { libcurl, initLibcurl } = await import("./libcurl-init");
  await initLibcurl();
  const resp = await (libcurl as any).fetch(url, init);
  const rawHeaders: [string, string][] = resp.raw_headers ?? [];
  const contentType =
    rawHeaders.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  let bytes: Uint8Array | null = null;
  const readBytes = async (): Promise<Uint8Array> => {
    if (bytes) return bytes;
    if (typeof resp.arrayBuffer === "function") {
      bytes = new Uint8Array(await resp.arrayBuffer());
    } else {
      bytes = new TextEncoder().encode(await resp.text());
    }
    return bytes;
  };
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    arrayBuffer: async () => (await readBytes()).slice().buffer,
  };
}

interface ResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
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
  // directFetch: 直接请求 Apple SAP 端点，由 libcurl 绕过 CORS，无需代理
  return w.sapSign(xml, { fetchImpl: libcurlFetch, directFetch: true });
}
