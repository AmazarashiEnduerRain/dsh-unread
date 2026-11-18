/**
 * dsh-unread — Windows unread badge bridge (koffi).
 *
 * Runs inside the dsh desktop HOST process (a plain Node process spawned by
 * the Electron main process; process.ppid = Electron main pid). The Electron
 * shell exposes no badge API, so we drive Windows natively:
 *
 *   1. PRIMARY — ITaskbarList3::SetOverlayIcon (vtable[18]) on the main
 *      window's taskbar button (Codex-style overlay, black circle + count).
 *   2. FALLBACK — Shell_NotifyIconW tray badge (NIM_ADD/MODIFY/DELETE) when
 *      the overlay is denied (0x80070005 E_ACCESSDENIED: window hidden to
 *      tray, elevated app, cross-process restriction, ...).
 *
 * A 16ms PeekMessageW pump keeps both mechanisms healthy (taskbar button
 * registration + tray callback delivery) without blocking the event loop.
 * All failures are logged, never thrown; the bridge degrades to a no-op.
 */

const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const CLSCTX_INPROC_SERVER = 1;
const E_ACCESSDENIED = -2147024891; // 0x80070005
const CLSID_TaskbarList = {
  data1: 0x56fdf344, data2: 0xfd6d, data3: 0x11d0,
  data4: [0x95, 0x8a, 0x00, 0x60, 0x97, 0xc9, 0xa0, 0x90],
};
const IID_ITaskbarList3 = {
  data1: 0xea1afb91, data2: 0x9e28, data3: 0x4b86,
  data4: [0x90, 0xe9, 0x9e, 0x9f, 0x8a, 0x5e, 0xef, 0xaf],
};
const VTBL_HRINIT = 3;          // ITaskbarList::HrInit
const VTBL_SET_OVERLAY_ICON = 18; // ITaskbarList3::SetOverlayIcon

const NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2;
const NIF_MESSAGE = 1, NIF_ICON = 2, NIF_TIP = 4;
const WM_APP = 0x8000;
const WM_LBUTTONUP = 0x202;
const SW_RESTORE = 9;

// koffi rejects JS strings for inline char16_t[N] fields — pass code-unit arrays.
const arr16 = (s, n) => {
  const a = [];
  for (const ch of String(s ?? "")) a.push(ch.charCodeAt(0));
  while (a.length < n) a.push(0);
  return a;
};

export class TaskbarBadge {
  #iconDir = null;
  #count = 0;
  #ready = false;
  #disposed = false;
  #initPromise = null;
  #k = null;
  #u = null; // user32
  #shell32 = null;
  #iface = null;
  #hicon = null;
  #trayIcon = null;
  #trayHwnd = null;
  #trayWndProc = null;
  #trayCallbackMessage = WM_APP + 1;
  #pumpTimer = null;
  #hwnd = null;
  #hwndAt = 0;
  #ptrSize = 0n;
  #callHrInit = null;
  #callSetOverlayIcon = null;
  #mechanism = "none"; // 'none' | 'overlay' | 'tray' | 'error'
  #lastError = null;
  #enumTypes = null; // lazily-registered EnumWindows proto/struct (register ONCE)
  #nidStruct = null; // lazily-registered NOTIFYICONDATAW struct (register ONCE)
  #notifyIcon = null; // bound Shell_NotifyIconW fn (bound ONCE with the struct)
  // koffi type/proto names are process-global AND non-retrievable; hot
  // re-applies import a fresh module, so give every instance unique names
  // instead of colliding with registrations from a previous instance.
  #tag = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  constructor(iconDir) {
    this.#iconDir = iconDir;
  }

  /** Diagnostic snapshot for the /state endpoint. */
  getState() {
    return {
      mechanism: this.#mechanism,
      lastError: this.#lastError,
      count: this.#count,
      hwnd: this.#hwnd ? String(this.#hwnd) : null,
      tray: Boolean(this.#trayIcon),
      ready: this.#ready,
    };
  }

  /** Kick off async setup; safe to call once. Errors are logged, not thrown. */
  async init() {
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = (async () => {
      if (process.platform !== "win32") return;
      try {
        const mod = await import("koffi");
        const k = mod.default ?? mod;
        if (!k || typeof k.load !== "function") throw new Error("koffi has no load()");
        this.#k = k;
        this.#ptrSize = process.arch === "x64" ? 8n : 4n;
        this.#u = k.load("user32.dll");
        this.#shell32 = k.load("shell32.dll");
        const ole32 = k.load("ole32.dll");

        // COM init: MTA first; RPC_E_CHANGED_MODE (-2147417850) means another
        // mode is set on this thread, which still works — just log it.
        const COINIT_MULTITHREADED = 0;
        const coInit = ole32.func("int32 __stdcall CoInitializeEx(void *reserved, uint32_t init)");
        const hrCoInit = coInit(null, COINIT_MULTITHREADED);
        if (hrCoInit !== 0 && hrCoInit !== 1 && hrCoInit !== -2147417850) {
          throw new Error(`CoInitializeEx failed: 0x${(hrCoInit >>> 0).toString(16)}`);
        }

        const GUID = k.struct(`DshUnreadGUID_${this.#tag}`, {
          data1: "uint32", data2: "uint16", data3: "uint16", data4: "uint8[8]",
        });
        // Out params write back only when declared with the MSDN `_Out_` qualifier;
        // a plain JS array receives the value.
        const create = ole32.func(
          `int32 __stdcall CoCreateInstance(DshUnreadGUID_${this.#tag} *clsid, void *outer, uint32_t context, DshUnreadGUID_${this.#tag} *iid, _Out_ void **ppv)`,
        );
        const ppv = [null];
        const hr = create(CLSID_TaskbarList, null, CLSCTX_INPROC_SERVER, IID_ITaskbarList3, ppv);
        if (hr !== 0) throw new Error(`CoCreateInstance failed: 0x${(hr >>> 0).toString(16)}`);
        const iface = ppv[0];
        if (!iface) throw new Error("CoCreateInstance returned NULL interface");
        this.#iface = iface;

        // vtable: first field of the COM object; slots are pointer-sized.
        // koffi.address() is the C "&" operator, NOT pointer arithmetic —
        // compute slot addresses with BigInt arithmetic.
        const vtbl = k.decode(iface, k.pointer("void"));
        if (!vtbl) throw new Error("COM object has NULL vtable");
        const slot = (n) => {
          const fnPtr = k.decode(vtbl + BigInt(n) * this.#ptrSize, k.pointer("void"));
          return fnPtr;
        };
        this.#callHrInit = k.decode(slot(VTBL_HRINIT), k.proto(`int32 __stdcall DshUnreadHrInit_${this.#tag}(void *self)`));
        this.#callSetOverlayIcon = k.decode(
          slot(VTBL_SET_OVERLAY_ICON),
          k.proto(`int32 __stdcall DshUnreadSetOverlayIcon_${this.#tag}(void *self, void *hwnd, void *hicon, str16 desc)`),
        );
        const hrHrInit = this.#callHrInit(iface);
        if (hrHrInit !== 0) throw new Error(`HrInit failed: 0x${(hrHrInit >>> 0).toString(16)}`);

        this.#ready = true;
        this.#startPump();
        await this.#apply();
      } catch (error) {
        this.#mechanism = "error";
        this.#lastError = String(error?.message ?? error);
        console.error("[dsh-unread] taskbar badge unavailable:", this.#lastError);
      }
    })();
    return this.#initPromise;
  }

  setCount(count) {
    this.#count = Math.max(0, count | 0);
    if (this.#ready) void this.#apply();
  }

  dispose() {
    this.#disposed = true;
    if (this.#pumpTimer) { clearInterval(this.#pumpTimer); this.#pumpTimer = null; }
    try {
      if (this.#hicon) { this.#u.func("bool __stdcall DestroyIcon(void *hicon)")(this.#hicon); this.#hicon = null; }
      if (this.#trayIcon) { this.#trayUpdate(NIM_DELETE, null); this.#trayIcon = null; }
      if (this.#callSetOverlayIcon && this.#hwnd) this.#callSetOverlayIcon(this.#iface, this.#hwnd, null, null);
      if (this.#trayHwnd) this.#u.func("bool __stdcall DestroyWindow(void *hwnd)")(this.#trayHwnd);
      if (this.#trayWndProc) { this.#k.unregister(this.#trayWndProc); this.#trayWndProc = null; }
    } catch { /* ignore */ }
  }

  #iconPath(count) {
    const name = count <= 0 ? "0" : count <= 99 ? String(count) : "99p";
    return `${this.#iconDir}dsh-unread-${name}.ico`;
  }

  #loadIcon(count) {
    if (this.#hicon) { this.#u.func("bool __stdcall DestroyIcon(void *hicon)")(this.#hicon); this.#hicon = null; }
    const hicon = this.#u.func(
      "void * __stdcall LoadImageW(void *hinst, str16 name, uint32_t type, int32 cx, int32 cy, uint32_t flags)",
    )(null, this.#iconPath(count), IMAGE_ICON, 0, 0, LR_LOADFROMFILE);
    if (!hicon) throw new Error(`LoadImageW failed: ${this.#iconPath(count)}`);
    this.#hicon = hicon;
    return hicon;
  }

  /** Refresh the cached main-window HWND at most once per 2s. */
  #mainHwnd() {
    const now = Date.now();
    if (this.#hwnd && now - this.#hwndAt < 2000) return this.#hwnd;
    this.#hwnd = this.#findMainWindow();
    this.#hwndAt = now;
    return this.#hwnd;
  }

  #windowVisible() {
    if (!this.#hwnd) return false;
    return Boolean(this.#u.func("bool __stdcall IsWindowVisible(void *hwnd)")(this.#hwnd));
  }

  async #apply() {
    if (!this.#ready || this.#disposed) return;
    const count = this.#count;
    try {
      const hwnd = this.#mainHwnd();
      if (count > 0) {
        const hicon = this.#loadIcon(count);
        if (hwnd && this.#windowVisible()) {
          const hr = this.#callSetOverlayIcon(this.#iface, hwnd, hicon, "dsh-unread");
          if (hr === 0) {
            this.#mechanism = "overlay";
            this.#lastError = null;
            this.#trayRemove(); // no double badge
            return;
          }
          this.#lastError = `SetOverlayIcon: 0x${(hr >>> 0).toString(16)}`;
          if (hr !== E_ACCESSDENIED) console.error("[dsh-unread] SetOverlayIcon failed:", this.#lastError);
        }
        // Fallback: tray badge.
        this.#trayUpdate(this.#trayIcon ? NIM_MODIFY : NIM_ADD, hicon);
        if (this.#trayIcon) {
          this.#mechanism = "tray";
          this.#lastError = null;
        } else {
          this.#mechanism = "error";
          this.#lastError = "Shell_NotifyIcon failed";
        }
      } else {
        if (hwnd) this.#callSetOverlayIcon(this.#iface, hwnd, null, null);
        this.#trayRemove();
        this.#mechanism = "none";
        this.#lastError = null;
      }
    } catch (error) {
      this.#lastError = String(error?.message ?? error);
      console.error("[dsh-unread] badge update failed:", this.#lastError);
    }
  }

  // --- Tray badge (Shell_NotifyIconW) ---

  #ensureTrayWindow() {
    if (this.#trayHwnd) return this.#trayHwnd;
    const k = this.#k;
    const u = this.#u;
    const kernel32 = k.load("kernel32.dll");
    const getModuleHandle = kernel32.func("void * __stdcall GetModuleHandleW(str16 name)");
    const wndProcProto = k.proto(`intptr_t __stdcall DshUnreadTrayWndProc_${this.#tag}(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)`);
    const defWndProc = u.func("intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)");
    const self = this;
    this.#trayWndProc = k.register((hwnd, msg, wparam, lparam) => {
      if (msg === self.#trayCallbackMessage && wparam === WM_LBUTTONUP) {
        try {
          const hwndMain = self.#mainHwnd();
          if (hwndMain) {
            u.func("bool __stdcall ShowWindow(void *hwnd, int32 cmd)")(hwndMain, SW_RESTORE);
            u.func("bool __stdcall SetForegroundWindow(void *hwnd)")(hwndMain);
          }
        } catch { /* ignore */ }
        return 0;
      }
      return defWndProc(hwnd, msg, wparam, lparam);
    }, k.pointer(wndProcProto));
    const WNDCLASSW = k.struct(`DshUnreadTrayWNDCLASSW_${this.#tag}`, {
      style: "uint32", lpfnWndProc: `DshUnreadTrayWndProc_${this.#tag} *`, cbClsExtra: "int32", cbWndExtra: "int32",
      hInstance: "void *", hIcon: "void *", hCursor: "void *", hbrBackground: "void *",
      lpszMenuName: "str16", lpszClassName: "str16",
    });
    const className = `DshUnreadTrayClass_${this.#tag}`;
    const wc = {
      style: 0, lpfnWndProc: this.#trayWndProc, cbClsExtra: 0, cbWndExtra: 0,
      hInstance: getModuleHandle(null), hIcon: null, hCursor: null, hbrBackground: null,
      lpszMenuName: null, lpszClassName: className,
    };
    u.func(`uint16_t __stdcall RegisterClassW(DshUnreadTrayWNDCLASSW_${this.#tag} *wc)`)(wc);
    // HWND_MESSAGE = -3: message-only window, never visible.
    const hwnd = u.func(
      "void * __stdcall CreateWindowExW(uint32_t ex, str16 cls, str16 title, uint32_t style, int32 x, int32 y, int32 w, int32 h, void *parent, void *menu, void *inst, void *param)",
    )(0, className, "", 0, 0, 0, 0, 0, -3n, null, wc.hInstance, null);
    if (!hwnd) throw new Error("tray message-only window creation failed");
    this.#trayHwnd = hwnd;
    return hwnd;
  }

  #trayUpdate(msg, hicon) {
    const k = this.#k;
    const hwnd = this.#ensureTrayWindow();
    // Register the struct once per instance (koffi names are process-global).
    if (!this.#nidStruct) {
      this.#nidStruct = k.struct(`DshUnreadTrayNID_${this.#tag}`, {
        cbSize: "uint32", hWnd: "void *", uID: "uint32", uFlags: "uint32",
        uCallbackMessage: "uint32", hIcon: "void *", szTip: "str16[128]",
        dwState: "uint32", dwStateMask: "uint32", szInfo: "str16[256]",
        uTimeoutOrVersion: "uint32", szInfoTitle: "str16[64]", dwInfoFlags: "uint32",
        guidItem: "uint8[16]", hBalloonIcon: "void *",
      });
      this.#notifyIcon = this.#shell32.func(`bool __stdcall Shell_NotifyIconW(uint32_t msg, DshUnreadTrayNID_${this.#tag} *data)`);
    }
    const NID = this.#nidStruct;
    const data = {
      cbSize: k.sizeof(NID), hWnd: hwnd, uID: 1,
      uFlags: NIF_MESSAGE | (hicon ? NIF_ICON : 0) | NIF_TIP,
      uCallbackMessage: this.#trayCallbackMessage, hIcon: hicon,
      szTip: arr16(`DeepSeek Harness — ${this.#count} unread`, 128),
      dwState: 0, dwStateMask: 0, szInfo: arr16("", 256),
      uTimeoutOrVersion: 0, szInfoTitle: arr16("", 64), dwInfoFlags: 0,
      guidItem: new Array(16).fill(0), hBalloonIcon: null,
    };
    const ok = this.#notifyIcon(msg, data);
    if (msg === NIM_ADD) this.#trayIcon = ok ? hwnd : null;
    if (msg === NIM_DELETE) this.#trayIcon = null;
    return ok;
  }

  #trayRemove() {
    if (this.#trayIcon) this.#trayUpdate(NIM_DELETE, null);
  }

  // --- Main-window discovery + message pump ---

  /**
   * Find the main-window HWND owned by the Electron main process (process.ppid).
   * Prefer the window with a non-empty title; fall back to the largest one.
   */
  #findMainWindow() {
    const k = this.#k;
    const u = this.#u;
    const targetPid = process.ppid;
    // koffi proto/struct names are process-global: register once per instance
    // (re-registering the same name throws "Duplicate type name").
    if (!this.#enumTypes) {
      const enumProto = k.proto(`int32 __stdcall DshUnreadEnumProc_${this.#tag}(void *hwnd, intptr_t lparam)`);
      const RECT = k.struct(`DshUnreadRECT_${this.#tag}`, { left: "int32", top: "int32", right: "int32", bottom: "int32" });
      this.#enumTypes = {
        enumProto,
        getPid: u.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)"),
        getTitleLen: u.func("int32 __stdcall GetWindowTextLengthW(void *hwnd)"),
        getRect: u.func(`bool __stdcall GetWindowRect(void *hwnd, _Out_ DshUnreadRECT_${this.#tag} *rect)`),
        enumWindows: u.func(`bool __stdcall EnumWindows(DshUnreadEnumProc_${this.#tag} *cb, intptr_t lparam)`),
      };
    }
    const { enumProto, getPid, getTitleLen, getRect, enumWindows } = this.#enumTypes;
    let titled = null;
    let largest = null;
    let largestArea = -1;
    const cb = k.register((hwnd) => {
      const pid = [0];
      getPid(hwnd, pid);
      if (pid[0] !== targetPid) return 1;
      if (getTitleLen(hwnd) > 0) { titled = titled ?? hwnd; }
      const rect = {};
      getRect(hwnd, rect);
      const area = (rect.right - rect.left) * (rect.bottom - rect.top);
      if (area > largestArea) { largestArea = area; largest = hwnd; }
      return 1;
    }, k.pointer(enumProto));
    try {
      enumWindows(cb, 0);
    } finally {
      k.unregister(cb);
    }
    return titled ?? largest;
  }

  /** 16ms PeekMessageW pump: keeps tray callbacks and taskbar integration alive. */
  #startPump() {
    if (this.#pumpTimer) return;
    const k = this.#k;
    const u = this.#u;
    const MSG = k.struct(`DshUnreadMSG_${this.#tag}`, {
      hwnd: "void *", message: "uint32_t", wParam: "uintptr_t", lParam: "intptr_t",
      time: "uint32_t", x: "int32", y: "int32",
    });
    const peekMsg = u.func(`bool __stdcall PeekMessageW(DshUnreadMSG_${this.#tag} *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)`);
    const translate = u.func(`bool __stdcall TranslateMessage(DshUnreadMSG_${this.#tag} *msg)`);
    const dispatch = u.func(`intptr_t __stdcall DispatchMessageW(DshUnreadMSG_${this.#tag} *msg)`);
    this.#pumpTimer = setInterval(() => {
      const msg = {};
      for (let i = 0; i < 32 && peekMsg(msg, null, 0, 0, 1 /* PM_REMOVE */); i++) {
        translate(msg);
        dispatch(msg);
      }
    }, 16);
    // Do not let the pump keep the process alive.
    this.#pumpTimer.unref?.();
  }
}

/**
 * Process-wide singleton. koffi type names (k.struct/k.proto) are registered
 * globally per PROCESS, and the runtime re-imports the plugin module on each
 * apply cycle (so a module-level `let` does NOT survive hot re-applies).
 * Keep the bridge on globalThis: one instance, one type registration.
 *
 * CODE_VERSION forces a fresh instance after badge.js code changes: an old
 * instance keeps OLD method code (private fields bind at construction), and
 * its type names stay registered forever, so dispose it and start over.
 * Bump CODE_VERSION whenever badge.js logic changes.
 */
const CODE_VERSION = 4;

export function sharedTaskbarBadge(iconDir) {
  const g = globalThis;
  const cur = g.__dshUnreadBadge;
  if (cur && cur.version === CODE_VERSION) return cur.instance;
  if (cur?.instance) { try { cur.instance.dispose(); } catch { /* ignore */ } }
  const instance = new TaskbarBadge(iconDir);
  g.__dshUnreadBadge = { instance, version: CODE_VERSION };
  return instance;
}
