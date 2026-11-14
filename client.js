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

    /** DSH design-platform typography: 14/22 body, 13/20 secondary, 12/18 hint. */
    const FONT_FAMILY = "var(--dsw-font-family)";
    const MONO_FONT = "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)";
    const CELL = {
      padding: "6px 14px 6px 0",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
      verticalAlign: "top",
      color: "var(--dsw-alias-label-primary)",
      whiteSpace: "nowrap",
    };
    const MUTED = { ...CELL, color: "var(--dsw-alias-label-secondary)" };
    const SECTION = { marginTop: 22 };
    const TITLE = { fontFamily: FONT_FAMILY, fontSize: 18, fontWeight: 600, lineHeight: "26px" };
    const H2 = {
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      fontWeight: 600,
      lineHeight: "22px",
      margin: "0 0 8px",
      color: "var(--dsw-alias-label-primary)",
    };
    const BUTTON = {
      cursor: "pointer",
      boxSizing: "border-box",
      height: 34,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "var(--dsw-radius-sm, 8px)",
      padding: "0 14px",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
    };
    const DANGER = { ...BUTTON, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" };
    const PRIMARY = {
      ...BUTTON,
      borderColor: "transparent",
      background: "var(--dsw-alias-brand-primary)",
      color: "var(--dsw-alias-bg-base)",
    };
    const INPUT = {
      width: "100%",
      boxSizing: "border-box",
      minHeight: 34,
      padding: "6px 10px",
      borderRadius: "var(--dsw-radius-sm, 8px)",
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-primary)",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
    };
    const FIELD = { marginBottom: 14 };
    const LABEL = {
      display: "block",
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: "20px",
      marginBottom: 4,
      color: "var(--dsw-alias-label-secondary)",
    };
    const HINT = { fontFamily: FONT_FAMILY, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", marginTop: 4 };
    const CARD = {
      position: "relative",
      pointerEvents: "auto",
      width: "min(720px, calc(100vw - 48px))",
      maxHeight: "min(78vh, 820px)",
      overflow: "auto",
      boxSizing: "border-box",
      padding: "24px 26px 22px",
      borderRadius: "var(--dsw-radius-lg, 16px)",
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-overlay)",
      boxShadow: "0 24px 64px rgba(0, 0, 0, 0.35)",
      color: "var(--dsw-alias-label-primary)",
    };
    const OVERLAY = {
      position: "fixed",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      zIndex: 1000,
      background: "rgba(0, 0, 0, 0.32)",
    };
    const CLOSE_BUTTON = {
      position: "absolute",
      top: 14,
      right: 14,
      width: 28,
      height: 28,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      border: "none",
      borderRadius: "var(--dsw-radius-sm, 8px)",
      background: "transparent",
      color: "var(--dsw-alias-label-secondary)",
      fontFamily: FONT_FAMILY,
      fontSize: 18,
      lineHeight: 1,
    };
    const ICON_BUTTON = {
      ...BUTTON,
      width: 32,
      padding: 0,
      fontSize: 16,
      lineHeight: 1,
    };
    const FOOTER_ACTION = {
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      padding: "8px 10px",
      borderRadius: "var(--dsw-radius-sm, 8px)",
      border: "1px solid transparent",
      background: "transparent",
      color: "var(--dsw-alias-label-secondary)",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
      textAlign: "left",
    };

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

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
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
            if (alive) setError(messageOf(err));
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
          const result = await api("/orca-api/" + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          setError(null);
          setTick((value) => value + 1);
          return result;
        } catch (err) {
          setError(messageOf(err));
          throw err;
        } finally {
          setBusy(false);
        }
      }

      const reload = () => setTick((value) => value + 1);
      return { state, error, busy, act, reload };
    }

    function Row(props) {
      return h("tr", null, props.children);
    }

    function stateBadge(value) {
      return h(
        "span",
        { style: { color: STATE_COLOR[value] || "var(--dsw-alias-label-secondary)", fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: "20px" } },
        typeof value === "string" ? value : "-",
      );
    }

    function Table(props) {
      return h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%" } },
        h(
          "thead",
          null,
          h("tr", null, props.columns.map((title) => h("th", { key: title, style: { ...MUTED, textAlign: "left", fontWeight: 500 } }, title))),
        ),
        h("tbody", null, props.children),
      );
    }

    function Members(props) {
      const members = props.members || [];
      if (members.length === 0) return h("div", { style: MUTED }, "no peers yet");
      return h(
        Table,
        { columns: ["node", "state", "busy", "endpoints", "os"] },
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
            h("button", { style: BUTTON, disabled: props.busy, onClick: () => props.onAct("approve", { peer: item.peer, task_id: item.task_id }) }, "approve"),
            h("button", { style: DANGER, disabled: props.busy, onClick: () => props.onAct("deny", { peer: item.peer, task_id: item.task_id }) }, "deny"),
          ),
        ),
      );
    }

    function Tasks(props) {
      const tasks = props.tasks || [];
      if (tasks.length === 0) return h("div", { style: MUTED }, "no tasks yet");
      return h(
        Table,
        { columns: ["task", "state", "origin", "age", "artifacts", ""] },
        tasks.map((task) => {
          const running = task.status && (task.status.state === "working" || task.status.state === "submitted" || task.status.state === "input-required");
          const links = props.artifacts && props.artifacts[task.id] ? props.artifacts[task.id] : [];
          return h(
            Row,
            { key: task.id },
            h("td", { style: { ...CELL, fontFamily: MONO_FONT } }, short(task.id)),
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
                    {
                      style: DANGER,
                      disabled: props.busy,
                      onClick: () =>
                        props.onCancel(task) &&
                        task.metadata &&
                        task.metadata.pod &&
                        task.metadata.pod.origin
                          ? props.onAct("cancel", { peer: task.metadata.pod.origin, task_id: task.id })
                          : null,
                    },
                    "cancel",
                  )
                : null,
            ),
          );
        }),
      );
    }

    function Workspace(props) {
      const workspace = props.workspace;
      if (!workspace) return h("div", { style: MUTED }, "workspace unavailable");
      return h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
        h("div", { style: { fontFamily: MONO_FONT, wordBreak: "break-all" } }, workspace.root),
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

    /* ----- config form ---------------------------------------------------- */

    function splitLines(text) {
      return String(text || "")
        .split(/[\n,]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    function ConfigForm(props) {
      const config = props.config || {};
      const wizard = props.wizard === true;
      const detected = Array.isArray(config.detected_endpoints) ? config.detected_endpoints : [];
      const advertised = Array.isArray(config.endpoints) ? config.endpoints : [];
      const suggested = advertised.length > 0 ? advertised.slice() : detected.slice();
      const [workgroupId, setWorkgroupId] = React.useState(config.workgroup_id || "workgroup");
      const [password, setPassword] = React.useState("");
      const [displayName, setDisplayName] = React.useState(config.display_name || "");
      const [port, setPort] = React.useState(String(config.port === undefined ? 11811 : config.port));
      const [endpoints, setEndpoints] = React.useState(suggested.length > 0 ? suggested : [""]);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      function updateEndpoint(index, value) {
        setEndpoints((rows) => rows.map((row, i) => (i === index ? value : row)));
      }

      function addEndpoint() {
        setEndpoints((rows) => rows.concat([""]));
      }

      function removeEndpoint(index) {
        setEndpoints((rows) => (rows.length === 1 ? [""] : rows.filter((_, i) => i !== index)));
      }

      async function save(event) {
        if (event) event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const patch = {
            workgroup_id: workgroupId.trim(),
            port: Number(port),
          };
          const name = displayName.trim();
          if (name.length > 0) patch.display_name = name;
          const addresses = endpoints.map((row) => row.trim()).filter((row) => row.length > 0);
          if (addresses.length > 0) patch.endpoints = addresses;
          if (wizard || password.length > 0) patch.workgroup_password = password;
          const next = await api("/orca-api/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          setPassword("");
          if (props.onSaved) props.onSaved(next);
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      }

      async function useExisting() {
        setBusy(true);
        setError(null);
        try {
          const next = await api("/orca-api/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          });
          if (props.onSaved) props.onSaved(next);
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      }

      return h(
        "form",
        { onSubmit: save, style: { paddingRight: 32 } },
        wizard
          ? h("div", { style: { ...MUTED, marginBottom: 12 } }, "首次启动：填写 workgroup 与密码，加入或创建一个 mesh。")
          : null,
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, "workgroup id"),
          h("input", { style: INPUT, value: workgroupId, onChange: (event) => setWorkgroupId(event.target.value), placeholder: "workgroup" }),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, "workgroup password"),
          h("input", {
            style: INPUT,
            type: "password",
            value: password,
            onChange: (event) => setPassword(event.target.value),
            placeholder: wizard ? "留空 = 开放 mesh（无密码）" : config.password_set ? "unchanged" : "留空 = 开放 mesh（无密码）",
          }),
          h("div", { style: HINT }, wizard ? "留空表示不设密码：同网段任何人都能加入。组内所有节点必须使用同一密码。" : config.password_set ? "留空表示保持原密码；换 workgroup 时必须填写（填留空即改为开放 mesh）。" : "留空表示不设密码（开放 mesh）。"),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, "display name"),
          h("input", { style: INPUT, value: displayName, onChange: (event) => setDisplayName(event.target.value), placeholder: "留空则使用节点 id" }),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, "listen port"),
          h("input", { style: INPUT, value: port, onChange: (event) => setPort(event.target.value), inputMode: "numeric" }),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, "advertised endpoints"),
          endpoints.map((row, index) =>
            h(
              "div",
              { key: "endpoint-" + index, style: { display: "flex", gap: 6, marginBottom: 6 } },
              h("input", {
                style: { ...INPUT, flex: 1, fontFamily: MONO_FONT },
                value: row,
                onChange: (event) => updateEndpoint(index, event.target.value),
                placeholder: "http://192.168.1.11:11811",
              }),
              h("button", { type: "button", style: BUTTON, disabled: busy, onClick: () => removeEndpoint(index) }, "移除"),
            ),
          ),
          h("button", { type: "button", style: BUTTON, disabled: busy, onClick: addEndpoint }, "添加地址"),
          h("div", { style: HINT }, "已自动识别本机 IPv4/IPv6 地址，可增删或改成公网域名；全部清空则由监听地址推导。"),
        ),
        error ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", marginBottom: 8 } }, error) : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
          h("button", { type: "submit", style: PRIMARY, disabled: busy }, wizard ? "开始" : "保存并重启"),
          wizard && props.config && props.config.running
            ? h("button", { type: "button", style: BUTTON, disabled: busy, onClick: useExisting }, "使用现有配置")
            : null,
          !wizard && props.onBack ? h("button", { type: "button", style: BUTTON, onClick: props.onBack }, "返回") : null,
          h("div", { style: { flex: 1 } }),
          h("span", { style: { ...MUTED, fontSize: 11 } }, props.config && props.config.running ? "running on " + (props.config.port || "-") : "not running"),
        ),
      );
    }

    /* ----- panel ---------------------------------------------------------- */

    function StatusPage(props) {
      const state = props.state;
      const self = state.self;
      const config = state.config || {};
      const [connectOpen, setConnectOpen] = React.useState(false);
      const [host, setHost] = React.useState("");
      const [peerPort, setPeerPort] = React.useState("11811");
      const [connectError, setConnectError] = React.useState(null);
      const peers = Array.isArray(config.peers) ? config.peers : [];
      const joined = peers.length > 0;

      function peerUrl() {
        const raw = host.trim();
        if (raw.length === 0) throw new Error("peer host is required");
        if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
        const portText = peerPort.trim().length === 0 ? "11811" : peerPort.trim();
        const hostname = raw.includes(":") && raw[0] !== "[" ? "[" + raw + "]" : raw;
        return "http://" + hostname + ":" + portText;
      }

      async function connect() {
        setConnectError(null);
        try {
          await props.onAct("connect", { peer: peerUrl() });
          setConnectOpen(false);
          setHost("");
        } catch (err) {
          setConnectError(messageOf(err));
        }
      }

      async function disconnect() {
        setConnectError(null);
        try {
          await props.onAct("disconnect", {});
        } catch (err) {
          setConnectError(messageOf(err));
        }
      }

      const connectionControl = joined
        ? h("button", { type: "button", style: BUTTON, disabled: props.busy, onClick: disconnect }, "断开")
        : h(
            "button",
            { type: "button", style: PRIMARY, disabled: props.busy, onClick: () => setConnectOpen(!connectOpen) },
            connectOpen ? "取消" : "连接",
          );

      return h(
        "div",
        null,
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12, paddingRight: 26 } },
          h("div", { style: TITLE }, "Orca Pod"),
          h("div", { style: { ...MUTED, fontFamily: MONO_FONT } }, self ? self.orca_node_id : "node not running"),
          self ? stateBadge(self.state) : null,
          h("div", { style: { flex: 1 } }),
          connectionControl,
          h("button", { type: "button", style: ICON_BUTTON, title: "设置", onClick: props.onOpenSettings }, "⚙"),
        ),
        h("div", { style: { ...MUTED, marginTop: 2 } }, "workgroup " + (config.workgroup_id || (self ? self.workgroup_id : "-"))),
        props.error ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, props.error) : null,
        connectError ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, connectError) : null,
        !joined
          ? h("div", { style: { ...MUTED, marginTop: 6 } }, "尚未连接 peer：点“连接”填写对端 host 与 port 加入 mesh。")
          : null,
        !joined && connectOpen
          ? h(
              "div",
              { style: SECTION },
              h("div", { style: H2 }, "连接 peer"),
              h(
                "div",
                { style: { ...FIELD, marginTop: 10 } },
                h("label", { style: LABEL }, "host"),
                h("input", { style: INPUT, value: host, onChange: (event) => setHost(event.target.value), placeholder: "192.168.1.12 / peer.example.com / [fd00::12]" }),
              ),
              h(
                "div",
                { style: FIELD },
                h("label", { style: LABEL }, "port"),
                h("input", { style: INPUT, value: peerPort, onChange: (event) => setPeerPort(event.target.value), inputMode: "numeric" }),
              ),
              h(
                "div",
                { style: { display: "flex", gap: 8 } },
                h("button", { type: "button", style: PRIMARY, disabled: props.busy, onClick: connect }, "连接"),
                h("button", { type: "button", style: BUTTON, disabled: props.busy, onClick: () => setConnectOpen(false) }, "取消"),
              ),
            )
          : null,
        h("div", { style: SECTION }, h("div", { style: H2 }, "Pending approvals"), h(Approvals, { approvals: state.approvals, busy: props.busy, onAct: props.onAct })),
        h("div", { style: SECTION }, h("div", { style: H2 }, "Recent tasks"), h(Tasks, { tasks: state.tasks, artifacts: state.artifacts, busy: props.busy, onCancel: () => true, onAct: props.onAct })),
        h("div", { style: SECTION }, h("div", { style: H2 }, "Members"), h(Members, { members: state.members })),
        h("div", { style: SECTION }, h("div", { style: H2 }, "Workspace"), h(Workspace, { workspace: state.workspace })),
        h("div", { style: { ...SECTION, color: "var(--dsw-alias-label-secondary)", fontFamily: FONT_FAMILY, fontSize: 12, lineHeight: "18px" } }, "updated " + age(state.now) + " ago"),
      );
    }

    function Panel() {
      const { state, error, busy, act, reload } = usePodState();
      const [view, setView] = React.useState("status");

      if (!state) {
        return h("div", { style: { padding: "4px 0", ...MUTED } }, error ? "orca-pod: " + error : "connecting to orca-pod…");
      }
      const config = state.config || {};
      const content = !config.configured
        ? h(ConfigForm, {
            config,
            wizard: true,
            onSaved: (next) => {
              reload();
              setView("status");
            },
          })
        : view === "settings"
          ? h(ConfigForm, {
              config,
              onSaved: () => {
                reload();
                setView("status");
              },
              onBack: () => setView("status"),
            })
          : h(StatusPage, { state, error, busy, onAct: act, onOpenSettings: () => setView("settings") });

      return h("div", { style: { minWidth: 0 } }, content);
    }

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
        h("span", { style: { fontSize: 16, lineHeight: 1 } }, "◈"),
        wide ? h("span", null, "Orca Pod") : null,
      );
    }

    /** Centered modal panel; Esc and a backdrop click close it. */
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
        {
          style: OVERLAY,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) setPanelOpen(false);
          },
        },
        h(
          "div",
          { style: CARD },
          h("button", { type: "button", style: CLOSE_BUTTON, title: "Close", onClick: () => setPanelOpen(false) }, "×"),
          h(Panel),
        ),
      );
    }

    /** Register a settings page, a sidebar entry and the floating panel. */
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
