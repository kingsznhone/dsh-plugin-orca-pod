/**
 * Orca Pod panel — DSH client bundle (§9.2).
 *
 * The file is served by the DSH web server as a same-origin classic script and
 * registers a lazy factory with `window.__ModuleLoader__`. Inside the factory we
 * may only `require` the platform module table (`react`, `ctx`, `host`, `styles`,
 * `console`); host code is reached through the same-origin `/orca-api` routes
 * registered by `src/plugin/web.ts`, not through `host.call`.
 *
 * UI rules: render inside a Slot, inherit theme tokens via `--dsw-alias-*`, never
 * touch `document.body`, and keep all DOM work inside React.
 */
window.__ModuleLoader__.load({
  id: "orca-pod",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    const POLL_MS = 2000;
    const NS = "orca-pod";

    /* Sidebar entry + floating panel share one open flag; the overlay slot is
     * frame-wide, and the sidebar footer action is the trigger. */
    let panelOpen = false;
    const openListeners = new Set();

    function setPanelOpen(next) {
      if (panelOpen === next) return;
      panelOpen = next;
      openListeners.forEach((listener) => listener());
    }

    function usePanelOpen() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        openListeners.add(listener);
        return () => openListeners.delete(listener);
      }, []);
      return panelOpen;
    }

    /** Styles shared by every table cell. */
    const CELL = {
      padding: "4px 10px 4px 0",
      fontSize: 12,
      verticalAlign: "top",
      color: "var(--dsw-alias-label-primary)",
      whiteSpace: "nowrap",
    };
    const MUTED = { ...CELL, color: "var(--dsw-alias-label-secondary)" };
    const SECTION = { marginTop: 18 };
    const H2 = {
      fontSize: 13,
      fontWeight: 600,
      margin: "0 0 6px",
      color: "var(--dsw-alias-label-primary)",
    };
    const BUTTON = {
      cursor: "pointer",
      borderRadius: 8,
      padding: "3px 10px",
      fontSize: 12,
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
    };
    const DANGER = { ...BUTTON, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" };

    const STATE_COLOR = {
      online: "var(--dsw-alias-state-success-primary)",
      suspect: "var(--dsw-alias-state-warn-primary)",
      unreachable: "var(--dsw-alias-state-warn-primary)",
      offline: "var(--dsw-alias-state-error-primary)",
      unknown: "var(--dsw-alias-state-idle-primary)",
    };

    function short(id) {
      return typeof id === "string" && id.length > 10 ? id.slice(0, 4) + "…" + id.slice(-4) : id;
    }

    function bytes(n) {
      if (typeof n !== "number") return "-";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
      return (n / 1024 / 1024).toFixed(1) + " MiB";
    }

    function age(iso) {
      if (typeof iso !== "string") return "-";
      const ms = Date.now() - Date.parse(iso);
      if (!Number.isFinite(ms) || ms < 0) return "-";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      if (s < 3600) return Math.round(s / 60) + "m";
      return Math.round(s / 3600) + "h";
    }

    async function api(path, init) {
      const response = await fetch(path, init);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body && body.error ? body.error : "HTTP " + response.status);
      return body;
    }

    function usePodState() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        let timer = 0;
        async function poll() {
          try {
            const next = await api("/orca-api/state");
            if (alive) {
              setState(next);
              setError(null);
            }
          } catch (err) {
            if (alive) setError(err instanceof Error ? err.message : String(err));
          }
          if (alive) timer = window.setTimeout(poll, POLL_MS);
        }
        poll();
        return () => {
          alive = false;
          window.clearTimeout(timer);
        };
      }, [tick]);

      async function act(path, payload) {
        setBusy(true);
        try {
          await api("/orca-api/" + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          setError(null);
          setTick((value) => value + 1);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }

      return { state, error, busy, act };
    }

    function Row(props) {
      return h("tr", null, props.children);
    }

    function stateBadge(value) {
      return h(
        "span",
        { style: { color: STATE_COLOR[value] || "var(--dsw-alias-label-secondary)", fontSize: 12 } },
        typeof value === "string" ? value : "-",
      );
    }

    function Members(props) {
      const members = props.members || [];
      if (members.length === 0) return h("div", { style: MUTED }, "no peers yet");
      return h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%" } },
        h(
          "thead",
          null,
          h("tr", null, ["node", "state", "busy", "endpoints", "os"].map((title) => h("th", { key: title, style: { ...MUTED, textAlign: "left", fontWeight: 500 } }, title))),
        ),
        h(
          "tbody",
          null,
          members.map((member) =>
            h(
              Row,
              { key: member.orca_node_id },
              h("td", { style: CELL }, member.display_name || short(member.orca_node_id)),
              h("td", { style: CELL }, stateBadge(member.state)),
              h("td", { style: CELL }, member.busy ? short(member.busy.task_id) : "-"),
              h("td", { style: MUTED }, (member.endpoints || []).join(", ") || "-"),
              h("td", { style: MUTED }, member.runtime && member.runtime.os ? member.runtime.os.name + " " + (member.runtime.os.version || "") : "-"),
            ),
          ),
        ),
      );
    }

    function Approvals(props) {
      const approvals = props.approvals || [];
      if (approvals.length === 0) return h("div", { style: MUTED }, "nothing waiting");
      return h(
        "div",
        null,
        approvals.map((item) =>
          h(
            "div",
            { key: item.task_id, style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
            h("span", { style: CELL }, short(item.task_id)),
            h("span", { style: MUTED }, item.request && item.request.tool ? item.request.tool : "tool"),
            h("span", { style: MUTED }, "from " + (item.request && item.request.requested_by ? short(item.request.requested_by) : "-")),
            h(
              "button",
              { style: BUTTON, disabled: props.busy, onClick: () => props.onAct("approve", { peer: item.peer, task_id: item.task_id }) },
              "approve",
            ),
            h(
              "button",
              { style: DANGER, disabled: props.busy, onClick: () => props.onAct("deny", { peer: item.peer, task_id: item.task_id }) },
              "deny",
            ),
          ),
        ),
      );
    }

    function Tasks(props) {
      const tasks = props.tasks || [];
      if (tasks.length === 0) return h("div", { style: MUTED }, "no tasks yet");
      return h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%" } },
        h(
          "thead",
          null,
          h("tr", null, ["task", "state", "origin", "age", "artifacts", ""].map((title) => h("th", { key: title, style: { ...MUTED, textAlign: "left", fontWeight: 500 } }, title))),
        ),
        h(
          "tbody",
          null,
          tasks.map((task) => {
            const running = task.status && (task.status.state === "working" || task.status.state === "submitted" || task.status.state === "input-required");
            const links = props.artifacts && props.artifacts[task.id] ? props.artifacts[task.id] : [];
            return h(
              Row,
              { key: task.id },
              h("td", { style: { ...CELL, fontFamily: "monospace" } }, short(task.id)),
              h("td", { style: CELL }, stateBadge(task.status ? task.status.state : "-")),
              h("td", { style: MUTED }, task.metadata && task.metadata.pod && task.metadata.pod.origin ? short(task.metadata.pod.origin) : "-"),
              h("td", { style: MUTED }, age(task.status ? task.status.timestamp : null)),
              h(
                "td",
                { style: CELL },
                links.map((link) =>
                  h("a", { key: link.blob_id, href: link.url || "#", target: "_blank", rel: "noreferrer", style: { color: "var(--dsw-alias-brand-primary)", marginRight: 8 } }, link.name),
                ),
              ),
              h(
                "td",
                { style: CELL },
                running
                  ? h(
                      "button",
                      { style: DANGER, disabled: props.busy, onClick: () => props.onCancel(task) },
                      "cancel",
                    )
                  : null,
              ),
            );
          }),
        ),
      );
    }

    function Workspace(props) {
      const workspace = props.workspace;
      if (!workspace) return h("div", { style: MUTED }, "workspace unavailable");
      return h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
        h("div", { style: { fontFamily: "monospace", wordBreak: "break-all" } }, workspace.root),
        h("div", { style: { marginTop: 4 } }, "notes: " + (workspace.notes_files.length > 0 ? workspace.notes_files.join(", ") : "empty")),
        h(
          "div",
          { style: { marginTop: 4 } },
          "inputs: " +
            (workspace.inputs_dirs.length > 0
              ? workspace.inputs_dirs.map((dir) => short(dir.task_id) + " (" + dir.files.length + ")").join(", ")
              : "empty"),
        ),
      );
    }

    function Panel() {
      const { state, error, busy, act } = usePodState();
      if (!state) {
        return h(
          "div",
          { style: { padding: 16, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } },
          error ? "orca-pod: " + error : "connecting to orca-pod…",
        );
      }
      const self = state.self;
      return h(
        "div",
        { style: { padding: "16px 20px", color: "var(--dsw-alias-label-primary)" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 10 } },
          h("div", { style: { fontSize: 16, fontWeight: 600 } }, "Orca Pod"),
          h("div", { style: { ...MUTED, fontFamily: "monospace" } }, self ? self.orca_node_id : "node not running"),
          self ? stateBadge(self.state) : null,
          h("div", { style: { flex: 1 } }),
          h("div", { style: MUTED }, "workgroup " + (self ? self.workgroup_id : "-")),
        ),
        error ? h("div", { style: { marginTop: 8, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } }, error) : null,
        h("div", { style: SECTION }, h("div", { style: H2 }, "Pending approvals"), h(Approvals, { approvals: state.approvals, busy, onAct: act })),
        h("div", { style: SECTION }, h("div", { style: H2 }, "Recent tasks"), h(Tasks, { tasks: state.tasks, artifacts: state.artifacts, busy, onCancel: (task) => task.metadata && task.metadata.pod && task.metadata.pod.origin ? act("cancel", { peer: task.metadata.pod.origin, task_id: task.id }) : null })),
        h("div", { style: SECTION }, h("div", { style: H2 }, "Members"), h(Members, { members: state.members })),
        h("div", { style: SECTION }, h("div", { style: H2 }, "Workspace"), h(Workspace, { workspace: state.workspace })),
        h("div", { style: SECTION }, h("div", { style: { ...MUTED, fontSize: 11 } }, "updated " + age(state.now) + " ago")),
      );
    }

    const CARD = {
      width: "min(720px, calc(100vw - 96px))",
      maxHeight: "78vh",
      overflow: "auto",
      borderRadius: 12,
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-layer-1)",
      boxShadow: "0 18px 48px rgba(0, 0, 0, 0.28)",
      color: "var(--dsw-alias-label-primary)",
    };
    const OVERLAY = {
      position: "fixed",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.35))",
      pointerEvents: "auto",
      zIndex: 900,
    };
    const ICON_BUTTON = {
      ...BUTTON,
      padding: "2px 8px",
      fontSize: 14,
      lineHeight: 1.2,
    };
    const FOOTER_ACTION = {
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      padding: "6px 8px",
      borderRadius: 8,
      border: "1px solid transparent",
      background: "transparent",
      color: "var(--dsw-alias-label-secondary)",
      fontSize: 13,
      textAlign: "left",
    };

    /** Sidebar-foot button: opens the floating Orca Pod panel. */
    function SidebarAction(props) {
      const wide = !props || props.wide !== false;
      return h(
        "button",
        {
          type: "button",
          style: FOOTER_ACTION,
          title: "Orca Pod",
          onClick: () => setPanelOpen(!panelOpen),
        },
        h("span", { style: { fontSize: 15, lineHeight: 1 } }, "◈"),
        wide ? h("span", null, "Orca Pod") : null,
      );
    }

    /** Frame-wide floating panel; closes on backdrop click or Escape. */
    function OverlayPanel() {
      const open = usePanelOpen();
      React.useEffect(() => {
        if (!open) return undefined;
        function onKey(event) {
          if (event.key === "Escape") setPanelOpen(false);
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);
      if (!open) return null;
      return h(
        "div",
        { style: OVERLAY, onClick: (event) => { if (event.target === event.currentTarget) setPanelOpen(false); } },
        h(
          "div",
          { style: CARD },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "8px 10px 0" } },
            h("button", { type: "button", style: ICON_BUTTON, title: "Close", onClick: () => setPanelOpen(false) }, "×"),
          ),
          h(Panel),
        ),
      );
    }

    /** Register the panel as one Settings page, a sidebar entry and a floating panel. */
    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({ name: "settings.section", id: NS, order: 60, label: "Orca Pod" }, Panel),
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: NS, order: 10, label: "Orca Pod" }, SidebarAction),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: NS + ".panel", order: 60 }, OverlayPanel),
      );
    }

    module.exports = { inject: ["slots"], apply };
    return module.exports;
  },
});
