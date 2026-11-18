/**
 * dsh-unread — Codex-style unread sessions for DeepSeek Harness (desktop).
 *
 * Host half:
 *  - a storage domain ("dsh-unread", layout single) holding per-session
 *    unread reasons: "done" (session completed), "attention" (approval /
 *    user-questions pending), "manual" (user marked unread in the GUI);
 *  - same-origin HTTP endpoints under /dsh-unread/* for the web UI;
 *  - the Windows taskbar overlay badge (lib/badge.js).
 *
 * The client half polls the state endpoint, renders an unread dot on session
 * rows and a mark-read/mark-unread entry in the session menu, and auto-marks
 * the currently open session (retainedBy.mainView) as read.
 */
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { sharedTaskbarBadge } from "./lib/badge.js";

const REASONS = ["done", "attention", "manual"];

const unreadRecord = z.object({
  reasons: z.array(z.enum(REASONS)),
  updatedAt: z.number(),
});

/**
 * Plain-object equivalent of defineDomain() from @deepseek-ai/dsh-storage-domain
 * (the helper is a validation/narrowing pass; the runtime only needs this shape).
 */
const domainSpec = {
  name: "dsh_unread", // UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/ — no hyphens
  version: 1,
  layout: "single",
  global: { schema: z.object({}), initial: {} },
  tables: { unread: { valueSchema: unreadRecord } },
};

const iconDir = fileURLToPath(new URL("./assets/", import.meta.url));

export function apply(ctx) {
  let domain = null;

  // Diagnostic event log: survives apply cycles (globalThis), exposed in
  // /state so we can see exactly which operations reached the host.
  const log = (g => {
    if (!g.__dshUnreadLog) g.__dshUnreadLog = { events: [] };
    return g.__dshUnreadLog;
  })(globalThis);
  const trace = (op, sessionId, detail) => {
    log.events.unshift({ t: Date.now(), op, sessionId, detail });
    if (log.events.length > 50) log.events.length = 50;
  };

  // SSE clients watching /dsh-unread/events. The web UI subscribes to these
  // instead of polling, so the dot/badge update the instant the host knows.
  const eventClients = new Set();
  const buildState = async () => {
    const list = [];
    let size = -1;
    await withTable((table) => {
      size = table.size;
      for (const [sessionId, value] of table.entries()) {
        list.push({
          sessionId,
          reasons: value.reasons,
          reasonsType: Array.isArray(value.reasons) ? "array" : typeof value.reasons,
          updatedAt: value.updatedAt,
        });
      }
    });
    return { unread: list, size, badge: badge.getState() };
  };
  const broadcast = async () => {
    if (eventClients.size === 0) return;
    try {
      const state = await buildState();
      const frame = `data: ${JSON.stringify(state)}\n\n`;
      for (const res of eventClients) {
        try { res.write(frame); } catch { eventClients.delete(res); }
      }
    } catch { /* state unreadable — skip this push */ }
  };

  const ensureDomain = async () => {
    if (domain) return domain;
    try {
      domain = await ctx.storageDomain.open(domainSpec);
    } catch (error) {
      // A re-apply cycle (bundle toggle) re-runs apply() while the domain
      // stays open process-wide; reuse the existing handle.
      if (/already.?open/i.test(String(error?.message ?? error))) {
        domain = ctx.storageDomain.get(domainSpec.name);
      } else {
        throw error;
      }
    }
    return domain;
  };
  const withTable = async (fn) => fn((await ensureDomain()).table("unread"));

  // koffi type names are process-global: share ONE badge bridge across
  // apply cycles instead of constructing (and re-registering) per apply.
  const badge = sharedTaskbarBadge(iconDir);
  badge.init();

  const refreshBadge = async () => {
    try {
      await withTable((table) => {
        const size = table.size;
        badge.setCount(size);
        trace("badge", "", `count=${size} mech=${badge.getState().mechanism} err=${badge.getState().lastError}`);
      });
    } catch (error) {
      trace("badge-error", "", error?.message ?? String(error));
      console.error("[dsh-unread] refreshBadge failed:", error?.message ?? error);
    }
  };

  async function markUnread(sessionId, reason) {
    try {
      // NOTE: table.put() returns the queued write promise; memory (and thus
      // table.size) only updates after backend durability. Await it before
      // refreshBadge reads the count, or the badge lags one write behind.
      await withTable((table) => {
        const cur = table.get(sessionId) ?? { reasons: [], updatedAt: 0 };
        if (!cur.reasons.includes(reason)) {
          return table.put(sessionId, { reasons: [...cur.reasons, reason], updatedAt: Date.now() });
        }
        return undefined;
      });
      trace("mark-unread", sessionId, reason);
    } catch (error) {
      trace("mark-unread-error", sessionId, error?.message ?? String(error));
      console.error("[dsh-unread] markUnread failed:", error?.message ?? error);
      return;
    }
    await refreshBadge();
    void broadcast();
  }

  async function clearReason(sessionId, reason) {
    try {
      await withTable((table) => {
        const cur = table.get(sessionId);
        if (!cur) return undefined;
        const reasons = cur.reasons.filter((r) => r !== reason);
        if (reasons.length === 0) return table.delete(sessionId);
        return table.put(sessionId, { reasons, updatedAt: Date.now() });
      });
    } catch (error) {
      console.error("[dsh-unread] clearReason failed:", error?.message ?? error);
      return;
    }
    await refreshBadge();
    void broadcast();
  }

  async function markRead(sessionId, source = "host") {
    try {
      await withTable((table) => table.delete(sessionId));
      trace("mark-read", sessionId, source);
    } catch (error) {
      trace("mark-read-error", sessionId, error?.message ?? String(error));
      console.error("[dsh-unread] markRead failed:", error?.message ?? error);
      return;
    }
    await refreshBadge();
    void broadcast();
  }

  // --- HTTP API for the web UI (same origin, no CORS needed) ---
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1e6) {
          reject(new Error("payload too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
      });
      req.on("error", reject);
    });
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };
  const sessionIdOf = (body) =>
    typeof body?.sessionId === "string" && body.sessionId ? body.sessionId : null;

  ctx.effect(() => {
    const disposeRoutes = [];
    const add = (route) => disposeRoutes.push(ctx.webServer.register(route));

    add({
      kind: "exact",
      path: "/dsh-unread/state",
      handler: async (_req, res) => {
        try {
          const state = await buildState();
          json(res, 200, { ...state, events: log.events.slice(0, 50) });
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    });

    // Server-Sent Events: the client opens this once and receives a fresh
    // state frame on every change (mark-unread/mark-read/completion), so the
    // UI reacts instantly instead of polling every 2s.
    add({
      kind: "exact",
      path: "/dsh-unread/events",
      handler: async (req, res) => {
        try {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          eventClients.add(res);
          const state = await buildState();
          res.write(`data: ${JSON.stringify(state)}\n\n`);
        } catch (error) {
          try { res.end(); } catch { /* ignore */ }
          eventClients.delete(res);
          return;
        }
        res.on("close", () => eventClients.delete(res));
      },
    });

    add({
      kind: "exact",
      path: "/dsh-unread/mark-read",
      handler: async (req, res) => {
        try {
          const body = await readJson(req);
          const sessionId = sessionIdOf(body);
          if (!sessionId) return json(res, 400, { error: "sessionId required" });
          await markRead(sessionId, body?.source ?? "client");
          json(res, 200, { ok: true });
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    });

    add({
      kind: "exact",
      path: "/dsh-unread/mark-unread",
      handler: async (req, res) => {
        try {
          const body = await readJson(req);
          const sessionId = sessionIdOf(body);
          if (!sessionId) return json(res, 400, { error: "sessionId required" });
          await markUnread(sessionId, "manual");
          json(res, 200, { ok: true });
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    });

    // Client-side diagnostics land in the same event ring so /state can
    // report what the web UI actually sees (open-session detection etc.).
    add({
      kind: "exact",
      path: "/dsh-unread/diag",
      handler: async (req, res) => {
        try {
          const body = await readJson(req);
          const detail = typeof body?.detail === "string" ? body.detail : "";
          if (detail) trace("client-diag", "", detail);
          json(res, 200, { ok: true });
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    });

    // Keep SSE connections alive through idle periods and proxies.
    const keepalive = setInterval(() => {
      for (const res of eventClients) {
        try { res.write(": keepalive\n\n"); } catch { eventClients.delete(res); }
      }
    }, 25000);
    keepalive.unref?.();

    return () => {
      clearInterval(keepalive);
      for (const dispose of disposeRoutes) dispose?.();
      for (const res of eventClients) { try { res.end(); } catch { /* ignore */ } }
      eventClients.clear();
    };
  });

  // --- Lifecycle events ---
  ctx.effect(() => {
    const offs = [];

    // Known sessions from the session controller (fires for restored sessions
    // as well as new ones). Subagent summaries carry origin === "subagent".
    const knownSessions = new Map(); // sessionId → SessionSummary
    // Run-state bookkeeping for completion detection (see below).
    const seenRunning = new Set();       // root sessions currently running
    const hasAssistantReply = new Set(); // saw a real reply during this run
    offs.push(ctx.on("api-session/added", (summary) => {
      if (!summary?.sessionId) return;
      knownSessions.set(summary.sessionId, summary);
      // Seed run state for sessions added mid-run (e.g. restored after an
      // app restart while their agent is still working).
      if (summary.running) seenRunning.add(summary.sessionId);
    }));

    // A subagent needing attention redirects to its parent session; a
    // subagent finishing is NOT a completion of a top-level conversation.
    const attentionTarget = (id) => {
      const summary = knownSessions.get(id);
      if (summary?.origin === "subagent" && summary.parentSessionId) return summary.parentSessionId;
      return id;
    };
    const isRoot = (id) => knownSessions.get(id)?.origin !== "subagent";

    // --- Completion detection --------------------------------------------
    // Codex semantics: the badge lights only when a WHOLE run finishes, and
    // only if that run produced at least one real assistant reply.
    // Two signals combined:
    //   1. api-session/status tracks run state (running ⇄ idle);
    //   2. session/event tells us when a contentful assistant reply was
    //      appended (streaming partials use surfaceOp "replace").
    // Intermediate messages DURING a run — progress notes, and subagent
    // output cross-posted into the parent session log — only set a flag;
    // they never light the badge. Stopped / cancelled / errored /
    // instant-idle runs produce no reply, so they never light it either
    // (this was the ghost-count bug).
    offs.push(ctx.on("api-session/status", (sessionId, running) => {
      const summary = knownSessions.get(sessionId);
      if (!summary || summary.origin === "subagent") return;
      if (running) {
        seenRunning.add(sessionId);
        return;
      }
      if (!seenRunning.delete(sessionId)) return; // idle without having run
      if (hasAssistantReply.delete(sessionId)) void markUnread(sessionId, "done");
    }));

    offs.push(ctx.on("session/event", (session, event) => {
      const id = session?.id;
      if (!id || !isRoot(id)) return;
      if (event?.type !== "assistant/message") return;
      if (event.surfaceOp !== "append") return;
      const content = event?.data?.message?.content;
      if (!Array.isArray(content) || content.length === 0) return;
      if (seenRunning.has(id)) {
        // Mid-run reply: remember it, light the badge at the run's end.
        hasAssistantReply.add(id);
        return;
      }
      // Reply committed while idle — the run-end ordering where the final
      // message lands after the status flip. Treat as completion.
      void markUnread(id, "done");
    }, { global: true }));

    offs.push(ctx.on("api-session/removed", (sessionId) => {
      if (sessionId) {
        knownSessions.delete(sessionId);
        seenRunning.delete(sessionId);
        hasAssistantReply.delete(sessionId);
      }
      void markRead(sessionId);
    }));

    // Waterfall listeners: always pass through next(); mark attention-unread
    // while the approval/user-question is pending, clear it once resolved.
    offs.push(ctx.on("approval/request", async function (req, next) {
      const id = attentionTarget(req?.agent?.id);
      if (id) await markUnread(id, "attention");
      try {
        return await next();
      } finally {
        if (id) await clearReason(id, "attention");
      }
    }));

    offs.push(ctx.on("user-questions/request", async function (req, next) {
      const id = attentionTarget(req?.agent?.id);
      if (id) await markUnread(id, "attention");
      try {
        return await next();
      } finally {
        if (id) await clearReason(id, "attention");
      }
    }));

    return () => { for (const off of offs) off?.(); };
  });

  // --- Initial badge sync ---
  ctx.effect(() => {
    void refreshBadge();
    // NOTE: the badge bridge is a process-wide singleton (sharedTaskbarBadge)
    // and is intentionally NOT disposed here — apply cycles must not tear it
    // down and re-register koffi types ("Duplicate type name").
  });
}

export const name = "dsh-unread";
export const inject = ["storageDomain", "webServer"];
export const reusable = true;
