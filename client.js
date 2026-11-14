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
 * touch `document.body`, and keep all DOM work inside React. Labels follow the
 * DSH desktop language through the `locale` service (`ctx.get("locale")`):
 * Chinese when the UI is Chinese, English otherwise.
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
    const DEFAULT_WORKGROUP = "WORKGROUP";

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

    /* ----- i18n ----------------------------------------------------------- */

    /** Locale face from the DSH client (`ctx.get("locale")`), set in apply(). */
    let localeFace = null;

    const TEXT = {
      en: {
        nav: "Orca Pod",
        close: "Close",
        settings: "Settings",
        connecting: "connecting to orca-pod…",
        nodeNotRunning: "node not running",
        workgroup: "workgroup",
        connect: "Connect",
        disconnect: "Disconnect",
        cancel: "Cancel",
        notJoined: "Not connected to a peer yet — click Connect and enter a peer host and port.",
        connectPeer: "Connect to a peer",
        host: "host",
        port: "port",
        peerHostRequired: "peer host is required",
        pendingApprovals: "Pending approvals",
        nothingWaiting: "nothing waiting",
        recentTasks: "Recent tasks",
        noTasks: "no tasks yet",
        members: "Members",
        noPeers: "no peers yet",
        workspace: "Workspace",
        workspaceUnavailable: "workspace unavailable",
        notes: "notes: ",
        inputs: "inputs: ",
        empty: "empty",
        updated: "updated ",
        updatedSuffix: " ago",
        approve: "approve",
        deny: "deny",
        from: "from ",
        tool: "tool",
        colNode: "node",
        colState: "state",
        colBusy: "busy",
        colEndpoints: "endpoints",
        colOs: "os",
        colTask: "task",
        colOrigin: "origin",
        colAge: "age",
        colArtifacts: "artifacts",
        stateOnline: "online",
        stateSuspect: "suspect",
        stateUnreachable: "unreachable",
        stateOffline: "offline",
        stateUnknown: "unknown",
        taskSubmitted: "submitted",
        taskWorking: "working",
        taskInputRequired: "input-required",
        taskCompleted: "completed",
        taskFailed: "failed",
        taskCanceled: "canceled",
        cfgWorkgroupId: "workgroup id",
        cfgWorkgroupIdHint: "Group ids are lowercase: WORKGROUP is saved as workgroup.",
        cfgPassword: "workgroup password",
        cfgPasswordOpen: "blank = open mesh (no password)",
        cfgPasswordKeep: "unchanged",
        cfgPasswordHintWizard: "Leave blank for no password: anyone on the same network can join. Every node in the group must use the same password.",
        cfgPasswordHintSet: "Leave blank to keep the current password; changing the workgroup requires a password (leave blank for an open mesh).",
        cfgPasswordHintNone: "Leave blank for no password (open mesh).",
        cfgDisplayName: "display name",
        cfgDisplayNamePlaceholder: "blank = node id",
        cfgListenPort: "listen port",
        cfgAdvertised: "advertised endpoints",
        cfgRemove: "Remove",
        cfgAddEndpoint: "Add address",
        cfgEndpointHint: "Detected this machine's IPv4/IPv6 addresses (avoid 127.0.0.1 — other machines cannot dial it). Add, remove or replace with a public hostname; leave empty to derive from the listen address.",
        cfgStart: "Start",
        cfgSave: "Save & restart",
        cfgUseExisting: "Use current configuration",
        cfgBack: "Back",
        cfgRunning: "running on ",
        cfgNotRunning: "not running",
        cfgWizardIntro: "First run: choose a workgroup and an optional password to join or create a mesh.",
        cfgResetIntro: "Full reset deletes the panel config (ui-config.json) and the node identity (config.json), returning to the first-run wizard. Tasks, blobs and workspace files are kept.",
        cfgReset: "Full reset",
        cfgResetConfirm: "Confirm reset (click again)",
      },
      zh: {
        nav: "Orca Pod",
        close: "关闭",
        settings: "设置",
        connecting: "正在连接 orca-pod…",
        nodeNotRunning: "节点未运行",
        workgroup: "工作组",
        connect: "连接",
        disconnect: "断开",
        cancel: "取消",
        notJoined: "尚未连接 peer：点“连接”，填写对端主机与端口加入 mesh。",
        connectPeer: "连接 peer",
        host: "主机",
        port: "端口",
        peerHostRequired: "必须填写 peer 主机",
        pendingApprovals: "待审批权限",
        nothingWaiting: "没有等待中的审批",
        recentTasks: "最近任务",
        noTasks: "暂无任务",
        members: "成员",
        noPeers: "还没有 peer",
        workspace: "工作区",
        workspaceUnavailable: "工作区不可用",
        notes: "notes：",
        inputs: "inputs：",
        empty: "空",
        updated: "更新于 ",
        updatedSuffix: " 前",
        approve: "允许",
        deny: "拒绝",
        from: "来自 ",
        tool: "工具",
        colNode: "节点",
        colState: "状态",
        colBusy: "忙碌",
        colEndpoints: "地址",
        colOs: "系统",
        colTask: "任务",
        colOrigin: "来源",
        colAge: "时间",
        colArtifacts: "产物",
        stateOnline: "在线",
        stateSuspect: "可疑",
        stateUnreachable: "不可达",
        stateOffline: "离线",
        stateUnknown: "未知",
        taskSubmitted: "已提交",
        taskWorking: "执行中",
        taskInputRequired: "等待输入",
        taskCompleted: "已完成",
        taskFailed: "失败",
        taskCanceled: "已取消",
        cfgWorkgroupId: "工作组 id",
        cfgWorkgroupIdHint: "组名会统一转为小写：WORKGROUP 实际保存为 workgroup。",
        cfgPassword: "工作组密码",
        cfgPasswordOpen: "留空 = 开放 mesh（无密码）",
        cfgPasswordKeep: "不修改",
        cfgPasswordHintWizard: "留空表示不设密码：同网段任何人都能加入。组内所有节点必须使用同一密码。",
        cfgPasswordHintSet: "留空表示保持原密码；换工作组时必须填写（留空即改为开放 mesh）。",
        cfgPasswordHintNone: "留空表示不设密码（开放 mesh）。",
        cfgDisplayName: "显示名称",
        cfgDisplayNamePlaceholder: "留空则使用节点 id",
        cfgListenPort: "监听端口",
        cfgAdvertised: "对外广播地址",
        cfgRemove: "移除",
        cfgAddEndpoint: "添加地址",
        cfgEndpointHint: "已自动识别本机 IPv4/IPv6 地址（默认不填 127.0.0.1，否则别的机器拨不到）；可增删或改成公网域名，全部清空则按监听地址自动识别。",
        cfgStart: "开始",
        cfgSave: "保存并重启",
        cfgUseExisting: "使用现有配置",
        cfgBack: "返回",
        cfgRunning: "运行中，端口 ",
        cfgNotRunning: "未运行",
        cfgWizardIntro: "首次启动：填写工作组与密码，加入或创建一个 mesh。",
        cfgResetIntro: "完全重置会删除面板配置（ui-config.json）与节点身份（config.json），回到首启向导；任务记录、blob 与工作区文件不受影响。",
        cfgReset: "完全重置",
        cfgResetConfirm: "确认重置（再次点击）",
      },
    };

    function activeLocaleId() {
      try {
        const snapshot = localeFace && typeof localeFace.getLocale === "function" ? localeFace.getLocale() : null;
        return snapshot && typeof snapshot.active === "string" ? snapshot.active : "en";
      } catch {
        return "en";
      }
    }

    /** Translate a key; Chinese for zh-* UI languages, English otherwise. */
    function t(key) {
      const lang = activeLocaleId().toLowerCase();
      const dict = lang.indexOf("zh") === 0 ? TEXT.zh : TEXT.en;
      if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
      return Object.prototype.hasOwnProperty.call(TEXT.en, key) ? TEXT.en[key] : key;
    }

    /** Re-render on locale switches (Chinese <-> English) while mounted. */
    function useLocaleTick() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        if (!localeFace || typeof localeFace.subscribe !== "function") return undefined;
        return localeFace.subscribe(() => bump((value) => value + 1));
      }, []);
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
      background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))",
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
      background: "var(--dsw-alias-bg-layer-1)",
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
      background: "var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32))",
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

    const STATE_KEY = {
      online: "stateOnline",
      suspect: "stateSuspect",
      unreachable: "stateUnreachable",
      offline: "stateOffline",
      unknown: "stateUnknown",
    };

    const TASK_STATE_KEY = {
      submitted: "taskSubmitted",
      working: "taskWorking",
      "input-required": "taskInputRequired",
      completed: "taskCompleted",
      failed: "taskFailed",
      canceled: "taskCanceled",
    };

    function stateLabel(value) {
      const key = STATE_KEY[value];
      return key ? t(key) : typeof value === "string" ? value : "-";
    }

    function taskStateLabel(value) {
      const key = TASK_STATE_KEY[value];
      return key ? t(key) : typeof value === "string" ? value : "-";
    }

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

    /** True for URLs that only dial this machine (useless as advertised endpoints). */
    function isLoopbackUrl(url) {
      try {
        const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return host === "localhost" || host === "::1" || host.startsWith("127.");
      } catch {
        return false;
      }
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
        stateLabel(value),
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
      if (members.length === 0) return h("div", { style: MUTED }, t("noPeers"));
      return h(
        Table,
        { columns: [t("colNode"), t("colState"), t("colBusy"), t("colEndpoints"), t("colOs")] },
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
      if (approvals.length === 0) return h("div", { style: MUTED }, t("nothingWaiting"));
      return h(
        "div",
        null,
        approvals.map((item) =>
          h(
            "div",
            { key: item.task_id, style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
            h("span", { style: CELL }, short(item.task_id)),
            h("span", { style: MUTED }, item.request && item.request.tool ? item.request.tool : t("tool")),
            h("span", { style: MUTED }, t("from") + (item.request && item.request.requested_by ? short(item.request.requested_by) : "-")),
            h("button", { style: BUTTON, disabled: props.busy, onClick: () => props.onAct("approve", { peer: item.peer, task_id: item.task_id }) }, t("approve")),
            h("button", { style: DANGER, disabled: props.busy, onClick: () => props.onAct("deny", { peer: item.peer, task_id: item.task_id }) }, t("deny")),
          ),
        ),
      );
    }

    function Tasks(props) {
      const tasks = props.tasks || [];
      if (tasks.length === 0) return h("div", { style: MUTED }, t("noTasks"));
      return h(
        Table,
        { columns: [t("colTask"), t("colState"), t("colOrigin"), t("colAge"), t("colArtifacts"), ""] },
        tasks.map((task) => {
          const running = task.status && (task.status.state === "working" || task.status.state === "submitted" || task.status.state === "input-required");
          const links = props.artifacts && props.artifacts[task.id] ? props.artifacts[task.id] : [];
          return h(
            Row,
            { key: task.id },
            h("td", { style: { ...CELL, fontFamily: MONO_FONT } }, short(task.id)),
            h("td", { style: CELL }, taskStateLabel(task.status ? task.status.state : "-")),
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
                    t("cancel"),
                  )
                : null,
            ),
          );
        }),
      );
    }

    function Workspace(props) {
      const workspace = props.workspace;
      if (!workspace) return h("div", { style: MUTED }, t("workspaceUnavailable"));
      return h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
        h("div", { style: { fontFamily: MONO_FONT, wordBreak: "break-all" } }, workspace.root),
        h("div", { style: { marginTop: 4 } }, t("notes") + (workspace.notes_files.length > 0 ? workspace.notes_files.join(", ") : t("empty"))),
        h(
          "div",
          { style: { marginTop: 4 } },
          t("inputs") +
            (workspace.inputs_dirs.length > 0
              ? workspace.inputs_dirs.map((dir) => short(dir.task_id) + " (" + dir.files.length + ")").join(", ")
              : t("empty")),
        ),
      );
    }

    /* ----- config form ---------------------------------------------------- */

    function ConfigForm(props) {
      const config = props.config || {};
      const wizard = props.wizard === true;
      const detected = Array.isArray(config.detected_endpoints) ? config.detected_endpoints : [];
      const advertised = Array.isArray(config.endpoints) ? config.endpoints : [];
      const usable = advertised.filter((url) => !isLoopbackUrl(url));
      const suggested = usable.length > 0 ? usable.slice() : detected.length > 0 ? detected.slice() : [""];
      const [workgroupId, setWorkgroupId] = React.useState(config.workgroup_id || DEFAULT_WORKGROUP);
      const [password, setPassword] = React.useState("");
      const [displayName, setDisplayName] = React.useState(config.display_name || "");
      const [port, setPort] = React.useState(String(config.port === undefined ? 11811 : config.port));
      const [endpoints, setEndpoints] = React.useState(suggested.length > 0 ? suggested : [""]);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [resetArmed, setResetArmed] = React.useState(false);

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
            workgroup_id: workgroupId.trim().toLowerCase(),
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

      async function resetAll() {
        setBusy(true);
        setError(null);
        try {
          const next = await api("/orca-api/reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          setResetArmed(false);
          if (props.onSaved) props.onSaved(next);
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      }

      const passwordPlaceholder = wizard
        ? t("cfgPasswordOpen")
        : config.password_set
          ? t("cfgPasswordKeep")
          : t("cfgPasswordOpen");

      return h(
        "form",
        { onSubmit: save, style: { paddingRight: 32 } },
        wizard ? h("div", { style: { ...MUTED, marginBottom: 12 } }, t("cfgWizardIntro")) : null,
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, t("cfgWorkgroupId")),
          h("input", { style: INPUT, value: workgroupId, onChange: (event) => setWorkgroupId(event.target.value), placeholder: DEFAULT_WORKGROUP }),
          h("div", { style: HINT }, t("cfgWorkgroupIdHint")),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, t("cfgPassword")),
          h("input", {
            style: INPUT,
            type: "password",
            value: password,
            onChange: (event) => setPassword(event.target.value),
            placeholder: passwordPlaceholder,
          }),
          h("div", { style: HINT }, wizard ? t("cfgPasswordHintWizard") : config.password_set ? t("cfgPasswordHintSet") : t("cfgPasswordHintNone")),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, t("cfgDisplayName")),
          h("input", { style: INPUT, value: displayName, onChange: (event) => setDisplayName(event.target.value), placeholder: t("cfgDisplayNamePlaceholder") }),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, t("cfgListenPort")),
          h("input", { style: INPUT, value: port, onChange: (event) => setPort(event.target.value), inputMode: "numeric" }),
        ),
        h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, t("cfgAdvertised")),
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
              h("button", { type: "button", style: BUTTON, disabled: busy, onClick: () => removeEndpoint(index) }, t("cfgRemove")),
            ),
          ),
          h("button", { type: "button", style: BUTTON, disabled: busy, onClick: addEndpoint }, t("cfgAddEndpoint")),
          h("div", { style: HINT }, t("cfgEndpointHint")),
        ),
        error ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", marginBottom: 8 } }, error) : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
          h("button", { type: "submit", style: PRIMARY, disabled: busy }, wizard ? t("cfgStart") : t("cfgSave")),
          wizard && props.config && props.config.running
            ? h("button", { type: "button", style: BUTTON, disabled: busy, onClick: useExisting }, t("cfgUseExisting"))
            : null,
          !wizard && props.onBack ? h("button", { type: "button", style: BUTTON, onClick: props.onBack }, t("cfgBack")) : null,
          h("div", { style: { flex: 1 } }),
          h(
            "span",
            { style: { ...MUTED, fontSize: 11 } },
            props.config && props.config.running ? t("cfgRunning") + (props.config.port || "-") : t("cfgNotRunning"),
          ),
        ),
        !wizard
          ? h(
              "div",
              { style: { marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--dsw-alias-border-l1)" } },
              h("div", { style: { ...HINT, marginBottom: 8 } }, t("cfgResetIntro")),
              h(
                "button",
                {
                  type: "button",
                  style: DANGER,
                  disabled: busy,
                  onClick: () => {
                    if (!resetArmed) {
                      setResetArmed(true);
                      return;
                    }
                    void resetAll();
                  },
                },
                resetArmed ? t("cfgResetConfirm") : t("cfgReset"),
              ),
            )
          : null,
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
        if (raw.length === 0) throw new Error(t("peerHostRequired"));
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
        ? h("button", { type: "button", style: BUTTON, disabled: props.busy, onClick: disconnect }, t("disconnect"))
        : h(
            "button",
            { type: "button", style: PRIMARY, disabled: props.busy, onClick: () => setConnectOpen(!connectOpen) },
            connectOpen ? t("cancel") : t("connect"),
          );

      return h(
        "div",
        null,
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12, paddingRight: 26 } },
          h("div", { style: TITLE }, t("nav")),
          h("div", { style: { ...MUTED, fontFamily: MONO_FONT } }, self ? self.orca_node_id : t("nodeNotRunning")),
          self ? stateBadge(self.state) : null,
          h("div", { style: { flex: 1 } }),
          connectionControl,
          h("button", { type: "button", style: ICON_BUTTON, title: t("settings"), onClick: props.onOpenSettings }, "⚙"),
        ),
        h("div", { style: { ...MUTED, marginTop: 2 } }, t("workgroup") + " " + (config.workgroup_id || (self ? self.workgroup_id : "-"))),
        props.error ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, props.error) : null,
        connectError ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, connectError) : null,
        !joined ? h("div", { style: { ...MUTED, marginTop: 6 } }, t("notJoined")) : null,
        !joined && connectOpen
          ? h(
              "div",
              { style: SECTION },
              h("div", { style: H2 }, t("connectPeer")),
              h(
                "div",
                { style: { ...FIELD, marginTop: 10 } },
                h("label", { style: LABEL }, t("host")),
                h("input", { style: INPUT, value: host, onChange: (event) => setHost(event.target.value), placeholder: "192.168.1.12 / peer.example.com / [fd00::12]" }),
              ),
              h(
                "div",
                { style: FIELD },
                h("label", { style: LABEL }, t("port")),
                h("input", { style: INPUT, value: peerPort, onChange: (event) => setPeerPort(event.target.value), inputMode: "numeric" }),
              ),
              h(
                "div",
                { style: { display: "flex", gap: 8 } },
                h("button", { type: "button", style: PRIMARY, disabled: props.busy, onClick: connect }, t("connect")),
                h("button", { type: "button", style: BUTTON, disabled: props.busy, onClick: () => setConnectOpen(false) }, t("cancel")),
              ),
            )
          : null,
        h("div", { style: SECTION }, h("div", { style: H2 }, t("pendingApprovals")), h(Approvals, { approvals: state.approvals, busy: props.busy, onAct: props.onAct })),
        h("div", { style: SECTION }, h("div", { style: H2 }, t("recentTasks")), h(Tasks, { tasks: state.tasks, artifacts: state.artifacts, busy: props.busy, onCancel: () => true, onAct: props.onAct })),
        h("div", { style: SECTION }, h("div", { style: H2 }, t("members")), h(Members, { members: state.members })),
        h("div", { style: SECTION }, h("div", { style: H2 }, t("workspace")), h(Workspace, { workspace: state.workspace })),
        h("div", { style: { ...SECTION, color: "var(--dsw-alias-label-secondary)", fontFamily: FONT_FAMILY, fontSize: 12, lineHeight: "18px" } }, t("updated") + age(state.now) + t("updatedSuffix")),
      );
    }

    function Panel() {
      useLocaleTick();
      const { state, error, busy, act, reload } = usePodState();
      const [view, setView] = React.useState("status");

      if (!state) {
        return h("div", { style: { padding: "4px 0", ...MUTED } }, error ? "orca-pod: " + error : t("connecting"));
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
          title: t("nav"),
          onClick: () => setPanelOpen(!panelOpen),
        },
        h("span", { style: { fontSize: 16, lineHeight: 1 } }, "◈"),
        wide ? h("span", null, t("nav")) : null,
      );
    }

    /** Centered modal panel; Esc and a backdrop click close it. */
    function OverlayPanel() {
      useLocaleTick();
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
          h("button", { type: "button", style: CLOSE_BUTTON, title: t("close"), onClick: () => setPanelOpen(false) }, "×"),
          h(Panel),
        ),
      );
    }

    /** Locale face used for Chinese/English selection (optional service). */
    function resolveLocaleFace(ctx) {
      try {
        if (ctx && typeof ctx.get === "function") {
          const value = ctx.get("locale");
          if (value) return value;
        }
      } catch {
        /* no locale service */
      }
      return null;
    }

    /** Register a settings page, a sidebar entry and the floating panel. */
    function apply(ctx) {
      localeFace = resolveLocaleFace(ctx);
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({ name: "settings.section", id: NS, order: 60, label: () => t("nav") }, Panel),
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: NS, order: 10, label: () => t("nav") }, SidebarAction),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: NS + ".panel", order: 60 }, OverlayPanel),
      );
    }

    module.exports = { inject: ["slots"], apply };
    return module.exports;
  },
});
