window.__ModuleLoader__.load({
  id: "dsh-unread",
  factory(require) {
    const React = require("react");
    const { createElement: h } = React;

    // primitives are optional at load time: if the module table doesn't have
    // them (yet), fall back to plain markup instead of killing the bundle.
    let primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      console.error("[dsh-unread] primitives require failed:", error?.message ?? error);
    }
    const MenuItemButton = primitives?.MenuItemButton;
    const StateDot = primitives?.StateDot;
    const IconQueueOutlineRegular = primitives?.IconQueueOutlineRegular;

    const NS = "dsh-unread";

    window.__dshUnreadClientVersion = 12;
    console.info("[dsh-unread] client bundle v12 loaded");

    const dicts = {
      en: {
        "menu.markAsRead": "Mark as read",
        "menu.markAsUnread": "Mark as unread",
        "dot.title": "Unread",
      },
      zh: {
        "menu.markAsRead": "标记为已读",
        "menu.markAsUnread": "标记为未读",
        "dot.title": "未读",
      },
    };

    function apply(ctx) {
      window.__dshUnreadClientError = null;
      try {
        applyInner(ctx);
      } catch (error) {
        window.__dshUnreadClientError = String(error?.message ?? error);
        console.error("[dsh-unread] client apply failed:", error);
      }
    }

    function applyInner(ctx) {
      // ---- ALL mutable state FIRST (no TDZ exposure from effects) ----
      const listeners = new Set();
      let snapshot = { unread: new Map(), count: 0, loaded: false };
      let lastOpenId = null;
      let lastDiag = "";
      let lastPollDiagAt = 0;
      // Session currently rendered by the conversation header observer
      // (reliable open-session signal — see OpenSessionObserver).
      let observerSessionId = null;
      // DOM-probed open session (v11): the conversation body carries
      // data-conversation-session while a session is open in the main view.
      // Independent of slot mounting — the safety net if the observer slot
      // fails to mount after a page refresh.
      let domOpenSessionId = null;
      // Live event stream (v12): Server-Sent Events from /dsh-unread/events
      // replace the 2s poll; the slow poll below is only a fallback.
      let eventSource = null;

      console.info("[dsh-unread] ctx services:", Object.keys(ctx ?? {}).sort().join(","));
      console.info("[dsh-unread] sessions?", Boolean(ctx?.sessions), "effect?", typeof ctx?.effect);

      // Client → host diagnostics: what the client SEES goes into the host
      // event ring so it can be read back from /dsh-unread/state.
      const diag = (detail) => {
        if (detail === lastDiag) return;
        lastDiag = detail;
        fetch("/dsh-unread/diag", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detail }),
        }).catch(() => {});
      };

      const store = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const setSnapshot = (next) => {
        snapshot = next;
        for (const listener of listeners) listener();
      };
      const withSnapshot = (fn) => setSnapshot(fn(snapshot));

      // The session currently open in the main conversation view.
      const currentOpen = () => {
        try {
          const list = ctx.sessions.list.getSnapshot();
          return Object.values(list.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0);
        } catch { return null; }
      };

      const post = (url, body) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }).catch((error) => {
          console.error("[dsh-unread] POST failed:", url, error?.message ?? error);
        });

      // --- auto-read fallback (mainView-based; currently inert) ---
      // NOTE (v10): the primary auto-read is the OpenSessionObserver slot
      // occupant below. This mainView-based path was the original design but
      // retainedBy.mainView is not populated in this module's context (poll
      // diag showed mv=-), so it stays as a defensive fallback only.
      // Codex semantics (v10): viewing a session = read — ANY unread reason
      // while the session is open (manual included) is consumed at once.
      const autoRead = () => {
        const row = currentOpen();
        const openId = row?.sessionId ?? null;
        // Baseline before the first state lands: track the open session but do
        // NOT consume the transition or act — the unread map is still empty,
        // so acting here would swallow the null→X transition forever.
        if (!snapshot.loaded) {
          lastOpenId = openId;
          return;
        }
        const changed = openId !== lastOpenId;
        lastOpenId = openId;
        if (!openId) return;
        const entry = snapshot.unread.get(openId);
        if (!entry) return;
        const reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
        if (changed) {
          diag(`entered ${openId} reasons=${reasons.join("+")} v12`);
          markRead(openId, "auto");
        } else {
          // Completion/attention appeared while this session stays open.
          const fresh = reasons.some((r) => r === "done" || r === "attention");
          if (fresh) {
            diag(`open+new ${openId} reasons=${reasons.join("+")} v12`);
            markRead(openId, "auto");
          }
        }
      };

      // DOM-probe: the conversation body carries data-conversation-session
      // while a session is open in the main view — independent of slot
      // mounting, so it keeps working if the header-actions observer fails
      // to mount. Auto-reads the open session immediately.
      const probeDom = (unread) => {
        let domId = null;
        try {
          domId =
            document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session") ||
            null;
        } catch { domId = null; }
        domOpenSessionId = domId;
        if (domId && unread.has(domId)) {
          markRead(domId, "auto");
        }
      };

      // Apply a state payload (from SSE push or poll fallback).
      const applyState = (data) => {
        const unread = new Map((data?.unread ?? []).map((row) => [row.sessionId, row]));
        setSnapshot({ unread, count: unread.size, loaded: true });
        autoRead();
        probeDom(unread);
      };

      const refresh = async () => {
        try {
          const res = await fetch("/dsh-unread/state", { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          applyState(data);
          if (Date.now() - lastPollDiagAt > 10000) {
            lastPollDiagAt = Date.now();
            try {
              const list = ctx.sessions.list.getSnapshot();
              const rows = Object.values(list.byId ?? {});
              const mv = rows
                .filter((r) => (r.retainedBy?.mainView ?? 0) > 0)
                .map((r) => r.sessionId);
              diag(
                `poll v12 t=${Date.now() % 100000} rows=${rows.length} mv=${mv.join(",") || "-"} ` +
                  `unread=${snapshot.unread.size} open=${currentOpen()?.sessionId ?? "null"} ` +
                  `obs=${observerSessionId ?? "-"} dom=${domOpenSessionId ?? "-"} sse=${eventSource ? "on" : "off"}`,
              );
            } catch (error) {
              diag(`poll v12 list-error=${error?.message ?? error}`);
            }
          }
        } catch { /* host route not ready yet */ }
      };

      // Server-Sent Events: instant state pushes from the host. EventSource
      // reconnects on its own; the 15s poll stays as a silent fallback.
      const connectEvents = () => {
        if (eventSource || typeof EventSource !== "function") return;
        try {
          const es = new EventSource("/dsh-unread/events");
          eventSource = es;
          es.onmessage = (ev) => {
            try { applyState(JSON.parse(ev.data)); } catch { /* malformed frame */ }
          };
          es.onerror = () => { /* built-in reconnect handles it */ };
        } catch {
          eventSource = null;
        }
      };

      const markRead = (sessionId, source = "menu") => {
        // Optimistic: flip the local snapshot NOW (dot/menu label react
        // instantly); the host broadcast confirms within the same tick.
        withSnapshot((s) => {
          if (!s.unread.has(sessionId)) return s;
          const unread = new Map(s.unread);
          unread.delete(sessionId);
          return { ...s, unread, count: unread.size };
        });
        void post("/dsh-unread/mark-read", { sessionId, source: `${source}-v12` }).then(refresh);
      };

      const markUnread = (sessionId) => {
        // Optimistic insert so the dot appears instantly.
        withSnapshot((s) => {
          if (s.unread.has(sessionId)) return s;
          const unread = new Map(s.unread);
          unread.set(sessionId, { sessionId, reasons: ["manual"], updatedAt: Date.now() });
          return { ...s, unread, count: unread.size };
        });
        void post("/dsh-unread/mark-unread", { sessionId, source: "menu-v12" }).then(refresh);
      };

      // --- lifecycle: locale, polling, auto-read ---
      try {
        ctx.locale.register(NS, dicts);
      } catch (error) {
        console.error("[dsh-unread] locale.register failed:", error?.message ?? error);
      }

      ctx.effect(() => {
        console.info("[dsh-unread] poll effect registered");
        diag(
          `loaded v12 list=${Boolean(ctx?.sessions?.list)} ` +
            `snap=${typeof ctx?.sessions?.list?.getSnapshot === "function"} ` +
            `sub=${typeof ctx?.sessions?.list?.subscribe === "function"} ` +
            `slots=${typeof ctx?.slots?.inject === "function"}`,
        );
        // SSE first: instant pushes; the 15s poll is only a fallback for
        // environments where EventSource dies silently.
        connectEvents();
        const timer = window.setInterval(refresh, 15000);
        void refresh();
        const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
        document.addEventListener("visibilitychange", onVisible);

        // Auto-read on navigation (session-list changes) AND after every
        // state update — entering a session must flip it to read immediately.
        const unsubscribe = ctx.sessions.list.subscribe(autoRead);
        autoRead();
        void refresh().then(() => autoRead());

        return () => {
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
          unsubscribe?.();
          try { eventSource?.close(); } catch { /* ignore */ }
          eventSource = null;
        };
      });

      // --- slot: session row leading dot ---
      const injected = () => ({
        hooks: { unread: store },
        markRead,
        markUnread,
      });

      ctx.slots.inject("sidebar.session.row.leading", function* () {
        yield ctx.slots.register(
          { name: "sidebar.session.row.leading", id: "dsh-unread-dot", order: 20, locale: NS, inject: injected },
          UnreadDot,
        );
      });

      // --- slot: session "..." menu entry ---
      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register(
          { name: "sidebar.workspaces.session.menu.item", id: "dsh-unread", order: 425, locale: NS, inject: injected },
          MarkUnreadMenuItem,
        );
      });

      // --- slot: conversation observer (reliable open-session signal) ---
      // Mounted while the session's conversation view is on screen. The
      // session-list's retainedBy.mainView is NOT populated in this module's
      // context (verified: poll diag mv=-), so the open session is observed
      // here instead — the header actions slot renders only for the open
      // conversation, in every view variant (composer/activity).
      const observerInjected = (sessionId) => ({
        sessionId,
        markRead,
        setObserverSession: (id) => { observerSessionId = id; },
        clearObserverSession: (id) => {
          if (observerSessionId === id) observerSessionId = null;
        },
        hooks: { unread: store },
      });

      ctx.slots.inject("conversation.session.header.actions", function* () {
        yield ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "dsh-unread-observer",
            order: 90,
            inject: observerInjected,
          },
          OpenSessionObserver,
        );
      });
    }

    function QueueIcon(props) {
      if (IconQueueOutlineRegular) return h(IconQueueOutlineRegular, props);
      return h("span", { "aria-hidden": "true", style: { marginRight: "4px" } }, "\u{1F516}");
    }

    // Invisible occupant of conversation.session.header.actions: the ONLY
    // reliable "this session is being viewed" signal. Codex semantics:
    // viewing a session = it is read. ANY unread reason that exists while
    // the session is open — whether it was there on entry (done, attention,
    // manual) or appeared while open (fresh completion, manual mark) — is
    // consumed immediately: markRead fires and the badge count decreases.
    function OpenSessionObserver(props) {
      const {
        sessionId,
        useUnread,
        markRead,
        setObserverSession,
        clearObserverSession,
      } = props;
      const domRef = React.useRef(null);
      const [domSessionId, setDomSessionId] = React.useState(null);
      // Belt-and-braces: if the slot inject did not deliver a sessionId,
      // read it from the conversation panel's data attribute.
      React.useEffect(() => {
        const node = domRef.current?.closest?.("[data-conversation-session]");
        const id = node?.getAttribute?.("data-conversation-session") || null;
        if (id) setDomSessionId(id);
      }, []);
      const effectiveId = sessionId ?? domSessionId;
      const reasonsKey = useUnread((s) => {
        if (!effectiveId) return "";
        const entry = s.unread.get(effectiveId);
        if (!entry) return "";
        const reasons = entry.reasons;
        return Array.isArray(reasons) ? reasons.join("+") : String(reasons ?? "");
      });
      React.useEffect(() => {
        if (!effectiveId) return undefined;
        setObserverSession(effectiveId);
        return () => clearObserverSession(effectiveId);
      }, [effectiveId]);
      React.useEffect(() => {
        if (!reasonsKey) return;
        // Viewing the session: consume every unread reason at once.
        markRead(effectiveId, "auto");
      }, [reasonsKey]);
      return h("span", { ref: domRef, style: { display: "none" } });
    }

    function UnreadDot(props) {
      const { sessionId, useUnread, t } = props;
      const isUnread = useUnread((s) => s.unread.has(sessionId));
      if (!isUnread) return null;
      const label = t("dot.title");
      if (StateDot) {
        return h("span", { title: label, "aria-label": label }, h(StateDot, { state: "warning" }));
      }
      return h("span", {
        title: label,
        "aria-label": label,
        style: { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#f59e0b" },
      });
    }

    function MarkUnreadMenuItem(props) {
      const { sessionId, useMenuOpenState, useUnread, markRead, markUnread, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const isUnread = useUnread((s) => s.unread.has(sessionId));
      const body = {
        icon: h(QueueIcon, {}),
        onSelect: () => {
          setMenuOpen(false);
          if (isUnread) markRead(sessionId);
          else markUnread(sessionId);
        },
        children: t(isUnread ? "menu.markAsRead" : "menu.markAsUnread"),
      };
      if (MenuItemButton) return h(MenuItemButton, body);
      return h("button", {
        type: "button",
        role: "menuitem",
        style: {
          display: "flex", gap: "8px", alignItems: "center", width: "100%",
          padding: "6px 10px", background: "transparent", border: "none",
          color: "inherit", cursor: "pointer", fontSize: "inherit", textAlign: "left",
        },
        onClick: () => body.onSelect(),
      }, body.icon, h("span", null, body.children));
    }

    return {
      inject: ["slots", "locale", "sessions"],
      apply,
    };
  },
});
