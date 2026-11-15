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

    /* Permission prompts parked by an `orca_pod` approve call. The dock lives inside the
     * session the agent ran in, so it renders prompts for that session; every
     * other prompt (background session) shows as a frame-wide popup instead.
     * There is no timeout: the human answers whenever they show up (§7.12). */
    let activeSessionId = null;

    /* ----- i18n ----------------------------------------------------------- */

    /** Locale face from the DSH client (`ctx.locale`), set in apply(). */
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
        allTasks: "All tasks",
        details: "details",
        tasksLoading: "loading tasks…",
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
        apTitle: "Permission needed",
      apTitleNamed: "Node {name} requests permission",
        apChain: "path: ",
        apBackground: "A background task needs permission",
        apWants: "wants to run",
        apTask: "task",
        apAllow: "Allow once",
        apDeny: "Deny",
        apInPanel: "In the panel",
        from: "from ",
        tool: "tool",
        colNode: "node",
        colState: "state",
        colBusy: "busy",
        colModel: "model",
        colEndpoints: "endpoints",
        colOs: "os",
        ndOpen: "details",
        ndTitle: "Node details",
        ndId: "node id",
        ndLastSeen: "last seen",
        ndRuntime: "runtime",
        ndDefaultModel: "default model",
        ndModels: "available models",
        ndNoModels: "not advertised",
        ndBudget: "task budget",
        ndCores: "cores",
        ndMemory: "memory",
        colTask: "task",
        colOrigin: "origin",
        colAge: "age",
        colArtifacts: "artifacts",
        busy: "busy",
        idle: "idle",
        busyOrigin: "from ",
        dtTitle: "Task details",
        dtDispatch: "dispatch",
        dtDispatchNone: "no dispatch record",
        dtPeer: "peer",
        dtLastError: "error",
        dtArtifacts: "artifacts",
        dtArtifactsNone: "no artifacts",
        dtInputs: "inputs",
        dtInputsNone: "no inputs",
        dtUsage: "usage",
        dtReason: "reason",
        dtMessage: "message",
        dtOrigin: "origin",
        dtTimeline: "timeline",
        dtCreated: "created",
        dtContext: "context",
        dtUpdated: "updated",
        dtModel: "model",
        dtLoadFailed: "cannot load the task: ",
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
        cfgPasswordOpen: "required",
        cfgPasswordKeep: "unchanged",
        cfgPasswordHintWizard: "Required. Every node in this workgroup must use the same password; a passwordless open mesh is not supported.",
        cfgPasswordHintSet: "Leave blank to keep the current password; it is also reused when you switch workgroups.",
        cfgPasswordHintNone: "A password is required before this node can start.",
        cfgPasswordRequired: "Enter a workgroup password before saving.",
        cfgDisplayName: "display name",
        cfgDisplayNamePlaceholder: "blank = node id",
        cfgListenPort: "listen port",
        cfgAdvertised: "local node addresses",
        cfgAdvanced: "advanced settings",
        cfgAdvancedHint: "Local connection and timeout controls. Blank means \"use the default\"; saving restarts this orca node.",
        cfgTaskTimeout: "task timeout (s)",
        cfgTaskTimeoutHint: "Hard cap on how long one task may run on this node.",
        cfgApprovalTimeout: "approval timeout (s)",
        cfgApprovalTimeoutHint: "Auto-reject parked approvals after this long; blank waits forever.",
        cfgResultMaxBytes: "result summary cap (bytes)",
        cfgMaxInputFiles: "max input files per task",
        cfgMaxInputMiB: "max input size (MiB)",
        cfgAllowPublicPeers: "public candidate peers",
        cfgAllowLoopbackPeers: "loopback candidates",
        cfgPermissionMode: "local permission ceiling",
  cfgDefaultEffort: "default reasoning effort",
  cfgDefaultEffortHint: "used when a task does not ask for one; tasks may override it",
        cfgExecutor: "executor",
        cfgExecutorHint: "acp runs real DSH sessions; echo is the debug script machine.",
        cfgAdvancedInvalid: "must be a positive number",
        cfgDefaultOption: "default",
        cfgAllowOption: "allow",
        cfgDenyOption: "deny",
        cfgRemove: "Remove",
        cfgAddEndpoint: "Add address",
        cfgEndpointHint: "Detected this machine's IPv4/IPv6 addresses (avoid 127.0.0.1 — other machines cannot dial it). Add, remove or replace with a public hostname; leave empty to derive from the listen address.",
        cfgStart: "Start",
        cfgSave: "Save & restart",
        cfgUseExisting: "Use current configuration",
        cfgBack: "Back",
        cfgRunning: "running on ",
        cfgNotRunning: "not running",
        cfgWizardIntro: "First run: choose a workgroup and a password to join or create a mesh.",
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
        allTasks: "全部任务",
        details: "详情",
        tasksLoading: "正在加载任务…",
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
        apTitle: "需要权限决策",
      apTitleNamed: "节点 {name} 请求授权",
        apChain: "来源链：",
        apBackground: "后台任务请求权限",
        apWants: "请求执行",
        apTask: "任务",
        apAllow: "允许一次",
        apDeny: "拒绝",
        apInPanel: "在面板中处理",
        from: "来自 ",
        tool: "工具",
        colNode: "节点",
        colState: "状态",
        colBusy: "忙碌",
        colModel: "模型",
        colEndpoints: "地址",
        colOs: "系统",
        ndOpen: "详情",
        ndTitle: "节点详情",
        ndId: "节点 ID",
        ndLastSeen: "最近心跳",
        ndRuntime: "运行环境",
        ndDefaultModel: "默认模型",
        ndModels: "可用模型",
        ndNoModels: "未上报",
        ndBudget: "单任务预算",
        ndCores: "逻辑核心",
        ndMemory: "内存",
        colTask: "任务",
        colOrigin: "来源",
        colAge: "时间",
        colArtifacts: "产物",
        busy: "忙碌",
        idle: "空闲",
        busyOrigin: "来自 ",
        dtTitle: "任务详情",
        dtDispatch: "派发",
        dtDispatchNone: "无派发记录",
        dtPeer: "对端",
        dtLastError: "错误",
        dtArtifacts: "产物",
        dtArtifactsNone: "无产物",
        dtInputs: "输入",
        dtInputsNone: "无输入",
        dtUsage: "用量",
        dtReason: "原因",
        dtMessage: "消息",
        dtOrigin: "来源",
        dtTimeline: "时间线",
        dtCreated: "创建",
        dtContext: "上下文",
        dtUpdated: "更新时间",
        dtModel: "模型",
        dtLoadFailed: "读取任务失败：",
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
        cfgPasswordOpen: "必填",
        cfgPasswordKeep: "不修改",
        cfgPasswordHintWizard: "必填。组内所有节点必须使用同一密码；不支持无密码的开放 mesh。",
        cfgPasswordHintSet: "留空表示保持原密码；切换工作组时也会沿用原密码。",
        cfgPasswordHintNone: "启动节点前必须设置密码。",
        cfgPasswordRequired: "请先填写工作组密码再保存。",
        cfgDisplayName: "显示名称",
        cfgDisplayNamePlaceholder: "留空则使用节点 id",
        cfgListenPort: "监听端口",
        cfgAdvertised: "本地节点地址",
        cfgAdvanced: "高级设置",
        cfgAdvancedHint: "本地连接与超时控制。留空表示使用默认值；保存会重启本节点。",
        cfgTaskTimeout: "任务超时上限（秒）",
        cfgTaskTimeoutHint: "单个任务在本机最多运行多久。",
        cfgApprovalTimeout: "审批等待超时（秒）",
        cfgApprovalTimeoutHint: "超时后自动拒绝；留空表示永久等待。",
        cfgResultMaxBytes: "结果简报上限（字节）",
        cfgMaxInputFiles: "单任务输入文件数上限",
        cfgMaxInputMiB: "单任务输入总大小（MiB）",
        cfgAllowPublicPeers: "公网候选节点",
        cfgAllowLoopbackPeers: "回环候选节点",
        cfgPermissionMode: "本机权限上限",
  cfgDefaultEffort: "默认 reasoning effort",
  cfgDefaultEffortHint: "任务未显式指定时使用；任务可以覆盖",
        cfgExecutor: "执行器",
        cfgExecutorHint: "acp 跑真实的 DSH 会话；echo 是调试用脚本机。",
        cfgAdvancedInvalid: "必须是正数",
        cfgDefaultOption: "默认",
        cfgAllowOption: "允许",
        cfgDenyOption: "拒绝",
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
        if (snapshot && typeof snapshot.active === "string") return snapshot.active;
      } catch {
        /* fall through to the browser hint */
      }
      // No locale service (or it has not resolved yet): follow the page/browser.
      try {
        const documentLang = typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "";
        if (typeof documentLang === "string" && documentLang.length > 0) return documentLang;
        if (typeof navigator !== "undefined" && typeof navigator.language === "string" && navigator.language.length > 0) {
          return navigator.language;
        }
      } catch {
        /* no document/navigator (tests) */
      }
      return "en";
    }

    /** Translate a key; Chinese for zh-* UI languages, English otherwise. */
    function t(key) {
      const lang = activeLocaleId().toLowerCase();
      const dict = lang.indexOf("zh") === 0 ? TEXT.zh : TEXT.en;
      if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
      return Object.prototype.hasOwnProperty.call(TEXT.en, key) ? TEXT.en[key] : key;
    }

    /** Translate a key and substitute `{name}` placeholders. */
    function tFormat(key, vars) {
      let text = t(key);
      for (const [name, value] of Object.entries(vars)) text = text.split("{" + name + "}").join(String(value));
      return text;
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
    const APPROVAL_CARD = {
      pointerEvents: "auto",
      boxSizing: "border-box",
      width: "min(560px, calc(100vw - 32px))",
      padding: "14px 16px",
      borderRadius: "var(--dsw-radius-panel, 16px)",
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-layer-1)",
      boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
      color: "var(--dsw-alias-label-primary)",
    };
    const APPROVAL_ROW = { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" };
    // The dock card sits inline above the composer, so it spans the column and
    // drops the floating shadow; the popup keeps the floating treatment for
    // sessions that are not on screen.
    const APPROVAL_DOCK_CARD = {
      ...APPROVAL_CARD,
      width: "100%",
      // Same width axis as the input card: the composer card cap inside the
      // shared side clearance (both vars are published by ConversationRoot).
      maxWidth: "var(--dsh-composer-card-max-width, 952px)",
      padding: "12px 16px",
      margin: "0 auto",
      boxShadow: "none",
      // The composer column is the reference width; the card keeps a visible
      // border so the approval boundary is unambiguous.
      border: "1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1))",
    };
    const APPROVAL_POPUP_CARD = { ...APPROVAL_CARD, width: "min(380px, calc(100vw - 32px))" };
    const DOCK_WRAP = {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      boxSizing: "border-box",
      width: "100%",
      // Mirror the input bar's side padding so the card edges line up with it.
      padding: "0 var(--dsh-composer-side-clearance, 16px)",
    };
    const POPUP_WRAP = {
      position: "fixed",
      right: 16,
      bottom: 56,
      zIndex: 1001,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      pointerEvents: "none",
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

    /** Display name of a peer, looked up by orca node id or advertised endpoint. */
    function memberName(members, key) {
      if (typeof key !== "string" || key.length === 0) return null;
      const list = Array.isArray(members) ? members : [];
      const found = list.find(
        (member) => member.orca_node_id === key || (Array.isArray(member.endpoints) && member.endpoints.includes(key)),
      );
      if (found === undefined) return null;
      return found.display_name || short(found.orca_node_id);
    }

    /** Leaf-first display names for a permission request's requester chain. */
    function permissionChainNames(request, members) {
      if (!request) return [];
      const upstream = Array.isArray(request.upstream)
        ? request.upstream.filter((id) => typeof id === "string" && id.length > 0)
        : [];
      const requestedBy = typeof request.requested_by === "string" && request.requested_by.length > 0 ? request.requested_by : null;
      const ids = requestedBy === null ? upstream : [...upstream, requestedBy];
      const names = [];
      for (const id of ids) {
        const name = approvalsName(members, id);
        if (names.length === 0 || names[names.length - 1] !== name) names.push(name);
      }
      return names;
    }

    /** Panel approval row: display name when known, else a stable short id. */
    function approvalsName(members, key) {
      const name = memberName(members, key);
      if (name !== null) return name;
      if (typeof key !== "string" || key.length === 0) return "-";
      return short(key);
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

    /** Compact peer label for a dispatch row: the advertised host, not the whole URL. */
    function peerHost(peer) {
      if (typeof peer !== "string" || peer.length === 0) return "-";
      try {
        return new URL(peer).host;
      } catch {
        return peer;
      }
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
      return h(
        "tr",
        { onClick: props.onClick, style: props.onClick ? { cursor: "pointer", ...props.rowStyle } : props.rowStyle },
        props.children,
      );
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
      // Offline records are dropped from the roster view entirely (§3.3): the
      // list should read as "who I can act with right now". A suspect peer keeps
      // its row but flags itself amber.
      const visible = members.filter((member) => member.state !== "offline");
      if (visible.length === 0) return h("div", { style: MUTED }, t("noPeers"));
      return h(
        Table,
        { columns: [t("colNode"), t("colBusy"), t("colModel"), ""] },
        visible.map((member) =>
          h(
            Row,
            {
              key: member.orca_node_id,
              onClick: props.onOpen ? () => props.onOpen(member) : undefined,
              rowStyle: { cursor: props.onOpen ? "pointer" : undefined },
            },
            h(
              "td",
              {
                style: {
                  ...CELL,
                  color:
                    member.state === "suspect" || member.state === "unreachable"
                      ? STATE_COLOR[member.state]
                      : undefined,
                },
                title: member.orca_node_id + " · " + stateLabel(member.state),
              },
              member.display_name || short(member.orca_node_id),
            ),
            h(
              "td",
              {
                style: CELL,
                title: member.busy ? member.busy.task_id + " · " + (member.busy.origin_orca_node || "") : undefined,
              },
              member.busy ? short(member.busy.task_id) : "-",
            ),
            h(
              "td",
              {
                style: MUTED,
                title:
                  (member.models || []).length > 0
                    ? String((member.models || []).length) + " available"
                    : undefined,
              },
              member.default_model
                ? member.default_model.provider + "/" + member.default_model.model
                : "-",
            ),
            h(
              "td",
              { style: { ...CELL, textAlign: "right" } },
              h(
                "button",
                {
                  type: "button",
                  style: BUTTON,
                  onClick: (event) => {
                    event.stopPropagation();
                    if (props.onOpen) props.onOpen(member);
                  },
                },
                t("ndOpen"),
              ),
            ),
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
        approvals.map((item) => {
          const chain = permissionChainNames(item.request, props.members);
          const leaf = chain.length > 0 ? chain[0] : approvalsName(props.members, item.request && item.request.requested_by);
          const chainLine = chain.length > 1 ? " · " + t("apChain") + chain.join(" → ") : "";
          return h(
            "div",
            { key: item.task_id, style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
            h("span", { style: CELL }, short(item.task_id)),
            h("span", { style: MUTED }, item.request && item.request.tool ? item.request.tool : t("tool")),
            h("span", { style: MUTED }, t("from") + leaf + chainLine),
            h("button", { style: BUTTON, disabled: props.busy, onClick: () => props.onAct("approve", { peer: item.peer, task_id: item.task_id }) }, t("approve")),
            h("button", { style: DANGER, disabled: props.busy, onClick: () => props.onAct("deny", { peer: item.peer, task_id: item.task_id }) }, t("deny")),
          );
        }),
      );
    }

    function Tasks(props) {
      const tasks = props.tasks || [];
      const dispatches = props.dispatches || [];
      const localIds = new Set(tasks.map((task) => task.id));
      // "Recent tasks" is what the human did from this panel: both tasks this
      // node runs locally and the tasks it dispatched to peers (the origin log).
      const entries = [
        ...tasks.map((task) => ({ kind: "local", id: task.id, at: task.status ? task.status.timestamp : null, task })),
        ...dispatches
          .filter((dispatch) => !localIds.has(dispatch.task_id))
          .map((dispatch) => ({ kind: "dispatch", id: dispatch.task_id, at: dispatch.updated_at, dispatch })),
      ].sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
      const visible = props.limit && props.limit > 0 ? entries.slice(0, props.limit) : entries;
      const showArtifacts = props.showArtifacts !== false;
      if (visible.length === 0) return h("div", { style: MUTED }, t("noTasks"));
      return h(
        Table,
        {
          columns: [
            t("colTask"),
            t("colState"),
            t("colOrigin"),
            t("colAge"),
            ...(showArtifacts ? [t("colArtifacts")] : []),
            "",
          ],
        },
        visible.map((entry) => {
          if (entry.kind === "dispatch") {
            const dispatch = entry.dispatch;
            const running =
              dispatch.state === "working" || dispatch.state === "submitted" || dispatch.state === "input-required";
            return h(
              Row,
              {
                key: "dispatch-" + entry.id,
                onClick: props.onOpenDispatch ? () => props.onOpenDispatch(dispatch) : undefined,
              },
              h("td", { style: { ...CELL, fontFamily: MONO_FONT } }, short(entry.id)),
              h("td", { style: CELL }, taskStateLabel(dispatch.state || "-")),
              h("td", { style: MUTED, title: dispatch.peer }, memberName(props.members || [], dispatch.peer) || peerHost(dispatch.peer)),
              h("td", { style: MUTED }, age(dispatch.updated_at)),
              showArtifacts ? h("td", { style: CELL }, "-") : null,
              h(
                "td",
                { style: CELL },
                h(
                  "div",
                  { style: { display: "flex", gap: 6, alignItems: "center" } },
                  h(
                    "button",
                    {
                      type: "button",
                      style: BUTTON,
                      onClick: (event) => {
                        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                        return props.onOpenDispatch ? props.onOpenDispatch(dispatch) : undefined;
                      },
                    },
                    t("details"),
                  ),
                  running
                    ? h(
                        "button",
                        {
                          style: DANGER,
                          disabled: props.busy,
                          onClick: (event) => {
                            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                            return props.onAct("cancel", { peer: dispatch.peer, task_id: dispatch.task_id });
                          },
                        },
                        t("cancel"),
                      )
                    : null,
                ),
              ),
            );
          }
          const task = entry.task;
          const running = task.status && (task.status.state === "working" || task.status.state === "submitted" || task.status.state === "input-required");
          const links = props.artifacts && props.artifacts[task.id] ? props.artifacts[task.id] : [];
          return h(
            Row,
            { key: task.id, onClick: props.onOpen ? () => props.onOpen(task) : undefined },
            h("td", { style: { ...CELL, fontFamily: MONO_FONT } }, short(task.id)),
            h("td", { style: CELL }, taskStateLabel(task.status ? task.status.state : "-")),
            h("td", { style: MUTED }, task.metadata && task.metadata.pod && task.metadata.pod.origin ? short(task.metadata.pod.origin) : "-"),
            h("td", { style: MUTED }, age(task.status ? task.status.timestamp : null)),
            showArtifacts
              ? h(
                  "td",
                  { style: CELL },
                  links.map((link) =>
                    h("a", { key: link.blob_id, href: link.url || "#", target: "_blank", rel: "noreferrer", style: { color: "var(--dsw-alias-brand-primary)", marginRight: 8 } }, link.name),
                  ),
                )
              : null,
            h(
              "td",
              { style: CELL },
              h(
                "div",
                { style: { display: "flex", gap: 6, alignItems: "center" } },
                h(
                  "button",
                  {
                    type: "button",
                    style: BUTTON,
                    onClick: (event) => {
                      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                      return props.onOpen ? props.onOpen(task) : undefined;
                    },
                  },
                  t("details"),
                ),
                running
                  ? h(
                      "button",
                      {
                        style: DANGER,
                        disabled: props.busy,
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                          const peer = task.metadata && task.metadata.pod ? task.metadata.pod.origin : null;
                          if (!props.onCancel(task) || !peer) return;
                          return props.onAct("cancel", { peer, task_id: task.id });
                        },
                      },
                      t("cancel"),
                    )
                  : null,
              ),
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

    /** Task detail modal: the state snapshot already carries everything we
     * show, so opening a row costs no extra RPC round-trip. */
    function TaskDetail(props) {
      const detail = props.detail;
      const task = detail.task;
      const members = props.members || [];
      const status = task.status || {};
      const pod = task.metadata && task.metadata.pod ? task.metadata.pod : {};
      React.useEffect(() => {
        function onKey(event) {
          if (event.key === "Escape") props.onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [props]);
      function field(label, value, key) {
        return h(
          "div",
          { key: key || label, style: { display: "flex", gap: 10, marginTop: 6, alignItems: "baseline" } },
          h("div", { style: { ...MUTED, minWidth: 72 } }, label),
          h("div", { style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, value),
        );
      }
      const dispatchRows = detail.dispatch
        ? [
            field(t("dtPeer"), detail.dispatch.peer || "-"),
            field(t("colState"), detail.dispatch.state || "-"),
            field(t("dtCreated"), detail.dispatch.created_at || "-"),
            field(t("dtUpdated"), detail.dispatch.updated_at || "-"),
            detail.dispatch.parent_local_task_id
              ? field(t("dtTimeline"), short(detail.dispatch.parent_local_task_id), "dt-parent")
              : null,
            detail.dispatch.last_error ? field(t("dtLastError"), String(detail.dispatch.last_error)) : null,
          ].filter(Boolean)
        : [h("div", { key: "none", style: MUTED }, t("dtDispatchNone"))];
      const artifacts =
        detail.artifacts.length > 0
          ? detail.artifacts.map((link) =>
              link.url
                ? h(
                    "a",
                    {
                      key: link.blob_id,
                      href: link.url,
                      target: "_blank",
                      rel: "noreferrer",
                      style: { display: "inline-block", marginRight: 10, color: "var(--dsw-alias-brand-primary)" },
                    },
                    link.name,
                  )
                : h(
                    "span",
                    { key: link.blob_id, style: { ...MUTED, display: "inline-block", marginRight: 10 } },
                    link.name,
                  ),
            )
          : [h("span", { key: "none", style: MUTED }, t("dtArtifactsNone"))];
      const inputs =
        detail.inputs.length > 0
          ? detail.inputs.map((name) => h("span", { key: name, style: { ...MUTED, marginRight: 10, fontFamily: MONO_FONT } }, name))
          : [h("span", { key: "none", style: MUTED }, t("dtInputsNone"))];
      const messageText = (() => {
        const parts = status.message && Array.isArray(status.message.parts) ? status.message.parts : [];
        return parts
          .map((part) => (part && typeof part.text === "string" ? part.text : ""))
          .filter(Boolean)
          .join("\n");
      })();
      const usage = task.usage
        ? t("dtUsage") +
          ": in " +
          String(task.usage.input_tokens) +
          " · out " +
          String(task.usage.output_tokens) +
          " · cache " +
          String(task.usage.cache_read_tokens)
        : null;
      return h(
        "div",
        {
          style: OVERLAY,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          "div",
          { style: { ...CARD, width: "min(680px, calc(100vw - 40px))", maxHeight: "min(82vh, 860px)" } },
          h("button", { type: "button", style: CLOSE_BUTTON, title: t("close"), onClick: props.onClose }, "×"),
          h("div", { style: { ...H2, marginBottom: 6 } }, t("dtTitle")),
          h("div", { style: { ...MUTED, fontFamily: MONO_FONT, wordBreak: "break-all", marginBottom: 8 } }, task.id),
          field(t("colState"), taskStateLabel(status.state)),
          field(t("dtOrigin"), pod.origin ? approvalsName(members, pod.origin) : "-"),
          field(t("dtContext"), task.contextId || "-"),
          field(t("dtUpdated"), status.timestamp ? status.timestamp : "-"),
          status.reason ? field(t("dtReason"), String(status.reason)) : null,
          pod.model
            ? field(
                t("dtModel"),
                pod.model.provider +
                  "/" +
                  pod.model.model +
                  (pod.model.reasoning_effort ? " · " + pod.model.reasoning_effort : ""),
                "dt-model",
              )
            : null,
          pod.hop !== undefined
            ? field(t("dtTimeline"), "hop " + String(pod.hop) + (pod.root ? " · root " + short(pod.root) : ""), "dt-hop")
            : null,
          usage ? h("div", { style: { ...MUTED, marginTop: 6 } }, usage) : null,
          messageText ? field(t("dtMessage"), messageText) : null,
          h("div", { style: { ...H2, marginTop: 16 } }, t("dtDispatch")),
          ...dispatchRows,
          h("div", { style: { ...H2, marginTop: 16 } }, t("dtArtifacts")),
          h("div", { style: { marginTop: 6 } }, artifacts),
          h("div", { style: { ...H2, marginTop: 16 } }, t("dtInputs")),
          h("div", { style: { marginTop: 6 } }, inputs),
        ),
      );
    }

    /* ----- all tasks ------------------------------------------------------ */

    function AllTasks(props) {
      const data = props.data;
      React.useEffect(() => {
        function onKey(event) {
          if (event.key === "Escape") props.onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [props]);
      const body =
        data === null
          ? h("div", { key: "loading", style: MUTED }, t("tasksLoading"))
          : h(Tasks, {
              tasks: data.tasks,
              dispatches: data.dispatches,
              artifacts: data.artifacts,
              members: props.members,
              busy: props.busy,
              onAct: props.onAct,
              onOpen: props.onOpenTask,
              onOpenDispatch: props.onOpenDispatch,
            });
      return h(
        "div",
        {
          style: OVERLAY,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          "div",
          { style: { ...CARD, width: "min(1040px, calc(100vw - 40px))", maxHeight: "min(84vh, 880px)", overflowY: "auto" } },
          h("button", { type: "button", style: CLOSE_BUTTON, title: t("close"), onClick: props.onClose }, "×"),
          h("div", { style: { ...H2, marginBottom: 10 } }, t("allTasks")),
          props.error
            ? h("div", { style: { marginBottom: 10, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } }, props.error)
            : null,
          body,
        ),
      );
    }

    /* ----- node detail ---------------------------------------------------- */

    function NodeDetail(props) {
      const member = props.detail;
      const runtime = member.runtime || null;
      const models = Array.isArray(member.models) ? member.models : [];
      const endpoints = Array.isArray(member.endpoints) ? member.endpoints : [];
      React.useEffect(() => {
        function onKey(event) {
          if (event.key === "Escape") props.onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [props]);
      function field(label, value, key) {
        return h(
          "div",
          { key: key || label, style: { display: "flex", gap: 10, marginTop: 6, alignItems: "baseline" } },
          h("div", { style: { ...MUTED, minWidth: 72 } }, label),
          h("div", { style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, value),
        );
      }
      const osText =
        runtime && runtime.os
          ? [runtime.os.name, runtime.os.version].filter(Boolean).join(" ") + (runtime.os.family ? " · " + runtime.os.family : "")
          : "-";
      const cpuText =
        runtime && runtime.cpu ? runtime.cpu.model + " · " + String(runtime.cpu.logical_cores) + " " + t("ndCores") : "-";
      const memoryText =
        runtime && runtime.memory && runtime.memory.total_bytes > 0
          ? (runtime.memory.total_bytes / 1073741824).toFixed(1) + " GiB"
          : "-";
      const nodeText = runtime && runtime.node ? "node " + runtime.node.version + (runtime.arch ? " · " + runtime.arch : "") : "-";
      const defaultModel = member.default_model
        ? member.default_model.provider +
          "/" +
          member.default_model.model +
          (member.default_model.reasoning_effort ? " · " + member.default_model.reasoning_effort : "")
        : "-";
      const modelRows =
        models.length === 0
          ? [h("div", { key: "none", style: MUTED }, t("ndNoModels"))]
          : models.map((model) =>
              h(
                "div",
                { key: model.provider + "/" + model.model, style: { marginTop: 6 } },
                h("div", { style: { fontFamily: MONO_FONT } }, model.provider + "/" + model.model),
                model.name || model.description
                  ? h("div", { style: { ...MUTED, fontSize: 12 } }, [model.name, model.description].filter(Boolean).join(" · "))
                  : null,
              ),
            );
      return h(
        "div",
        {
          style: OVERLAY,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          "div",
          { style: { ...CARD, width: "min(620px, calc(100vw - 40px))", maxHeight: "min(82vh, 860px)" } },
          h("button", { type: "button", style: CLOSE_BUTTON, title: t("close"), onClick: props.onClose }, "×"),
          h("div", { style: { ...H2, marginBottom: 6 } }, t("ndTitle")),
          field(t("colNode"), member.display_name || short(member.orca_node_id)),
          field(t("ndId"), member.orca_node_id, "nd-id"),
          field(t("colState"), stateLabel(member.state)),
          field(
            t("colBusy"),
            member.busy
              ? short(member.busy.task_id) + " · " + t("busyOrigin") + approvalsName(props.members || [], member.busy.origin_orca_node)
              : t("idle"),
            "nd-busy",
          ),
          field(t("ndLastSeen"), member.last_recv_at ? age(member.last_recv_at) + t("updatedSuffix") : "-"),
          field(t("ndBudget"), member.max_task_ttl_s ? String(member.max_task_ttl_s) + " s" : "-"),
          h("div", { style: { ...H2, marginTop: 16 } }, t("ndRuntime")),
          field(t("colOs"), osText),
          field("cpu", cpuText, "nd-cpu"),
          field(t("ndMemory"), memoryText, "nd-memory"),
          field("node", nodeText, "nd-node"),
          h("div", { style: { ...H2, marginTop: 16 } }, t("ndModels")),
          field(t("ndDefaultModel"), defaultModel),
          ...modelRows,
          h("div", { style: { ...H2, marginTop: 16 } }, t("colEndpoints")),
          endpoints.length === 0
            ? h("div", { style: MUTED }, "-")
            : endpoints.map((url) => h("div", { key: url, style: { fontFamily: MONO_FONT, wordBreak: "break-all", marginTop: 4, fontSize: 12 } }, url)),
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
      /* First-run wizard starts from this node's own id; a configured install
       * keeps whatever display name was saved (both default to the node id). */
      const [displayName, setDisplayName] = React.useState(wizard ? config.node_id || "" : config.display_name || "");
      const [port, setPort] = React.useState(String(config.port === undefined ? 11811 : config.port));
      const [endpoints, setEndpoints] = React.useState(suggested.length > 0 ? suggested : [""]);
      const advanced = config.advanced || {};
      const [advancedOpen, setAdvancedOpen] = React.useState(false);
      const textOf = (value) => (value === null || value === undefined ? "" : String(value));
      const [taskTimeout, setTaskTimeout] = React.useState(textOf(advanced.task_timeout_s));
      const [approvalTimeout, setApprovalTimeout] = React.useState(textOf(advanced.approval_timeout_s));
      const [resultMaxBytes, setResultMaxBytes] = React.useState(textOf(advanced.result_max_bytes));
      const [maxInputFiles, setMaxInputFiles] = React.useState(textOf(advanced.max_input_files));
      const [maxInputMiB, setMaxInputMiB] = React.useState(
        typeof advanced.max_input_bytes === "number" && advanced.max_input_bytes > 0 ? String(Math.round(advanced.max_input_bytes / 1048576)) : "",
      );
      const [publicPeers, setPublicPeers] = React.useState(
        advanced.allow_public_peers === true ? "allow" : advanced.allow_public_peers === false ? "deny" : "",
      );
      const [loopbackPeers, setLoopbackPeers] = React.useState(
        advanced.allow_loopback_peers === true ? "allow" : advanced.allow_loopback_peers === false ? "deny" : "",
      );
      const [permissionMode, setPermissionMode] = React.useState(advanced.permission_mode || "");
      const [defaultEffort, setDefaultEffort] = React.useState(advanced.default_reasoning_effort || "");
      const [executor, setExecutor] = React.useState(advanced.executor || "");
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
        setError(null);
        const needsPassword = password.length === 0 && (wizard || !config.password_set);
        if (needsPassword) {
          setError(t("cfgPasswordRequired"));
          return;
        }
        setBusy(true);
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
          const number = (label, raw, integer) => {
            const trimmed = raw.trim();
            if (trimmed.length === 0) return null;
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
              throw new Error(label + " " + t("cfgAdvancedInvalid"));
            }
            return parsed;
          };
          patch.task_timeout_s = number(t("cfgTaskTimeout"), taskTimeout, false);
          patch.approval_timeout_s = number(t("cfgApprovalTimeout"), approvalTimeout, false);
          patch.result_max_bytes = number(t("cfgResultMaxBytes"), resultMaxBytes, true);
          patch.max_input_files = number(t("cfgMaxInputFiles"), maxInputFiles, true);
          const mib = number(t("cfgMaxInputMiB"), maxInputMiB, false);
          patch.max_input_bytes = mib === null ? null : Math.round(mib * 1048576);
          patch.allow_public_peers = publicPeers.length === 0 ? null : publicPeers === "allow";
          patch.allow_loopback_peers = loopbackPeers.length === 0 ? null : loopbackPeers === "allow";
          patch.permission_mode = permissionMode.length === 0 ? null : permissionMode;
          patch.default_reasoning_effort = defaultEffort.length === 0 ? null : defaultEffort;
          patch.executor = executor.length === 0 ? null : executor;
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

      function advancedField(label, value, onChange, hint) {
        return h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, label),
          h("input", {
            style: INPUT,
            value: value,
            inputMode: "numeric",
            onChange: (event) => onChange(event.target.value),
          }),
          hint ? h("div", { style: HINT }, hint) : null,
        );
      }

      function advancedSelect(label, value, onChange, options) {
        return h(
          "div",
          { style: FIELD },
          h("label", { style: LABEL }, label),
          h(
            "select",
            { style: INPUT, value: value, onChange: (event) => onChange(event.target.value) },
            options.map((option) => h("option", { key: option.value, value: option.value }, option.label)),
          ),
        );
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
        h(
          "details",
          {
            style: { marginTop: 6, marginBottom: 14 },
            open: advancedOpen,
            onToggle: (event) => setAdvancedOpen(event.currentTarget.open),
          },
          h(
            "summary",
            {
              style: {
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--dsw-alias-label-primary)",
              },
            },
            t("cfgAdvanced"),
          ),
          h("div", { style: { ...HINT, marginBottom: 10 } }, t("cfgAdvancedHint")),
          h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12 } },
            advancedField(t("cfgTaskTimeout"), taskTimeout, setTaskTimeout, t("cfgTaskTimeoutHint")),
            advancedField(t("cfgApprovalTimeout"), approvalTimeout, setApprovalTimeout, t("cfgApprovalTimeoutHint")),
            advancedField(t("cfgResultMaxBytes"), resultMaxBytes, setResultMaxBytes, null),
            advancedField(t("cfgMaxInputFiles"), maxInputFiles, setMaxInputFiles, null),
            advancedField(t("cfgMaxInputMiB"), maxInputMiB, setMaxInputMiB, null),
            advancedSelect(t("cfgPermissionMode"), permissionMode, setPermissionMode, [
              { value: "", label: t("cfgDefaultOption") },
              { value: "read-only", label: "read-only" },
              { value: "workspace-write", label: "workspace-write" },
              { value: "danger-full-access", label: "danger-full-access" },
            ]),
            advancedSelect(t("cfgAllowPublicPeers"), publicPeers, setPublicPeers, [
              { value: "", label: t("cfgDefaultOption") },
              { value: "allow", label: t("cfgAllowOption") },
              { value: "deny", label: t("cfgDenyOption") },
            ]),
            advancedSelect(t("cfgAllowLoopbackPeers"), loopbackPeers, setLoopbackPeers, [
              { value: "", label: t("cfgDefaultOption") },
              { value: "allow", label: t("cfgAllowOption") },
              { value: "deny", label: t("cfgDenyOption") },
            ]),
            advancedSelect(t("cfgDefaultEffort"), defaultEffort, setDefaultEffort, [
              { value: "", label: t("cfgDefaultOption") },
              { value: "off", label: "off" },
              { value: "low", label: "low" },
              { value: "high", label: "high" },
              { value: "max", label: "max" },
            ]),
            advancedSelect(t("cfgExecutor"), executor, setExecutor, [
              { value: "", label: t("cfgDefaultOption") },
              { value: "acp", label: "acp" },
              { value: "echo", label: "echo" },
            ]),
          ),
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
      const [connectError, setConnectError] = React.useState(null);
      const members = Array.isArray(state.members) ? state.members : [];
      // The header button reflects the live mesh, not the remembered peer list:
      // saved peers that stop answering must read as "Connect", not "Disconnect".
      const joined = members.some((member) => member.state !== "offline");
      const dispatches = Array.isArray(state.dispatches) ? state.dispatches : [];
      const inputsDirs = state.workspace && Array.isArray(state.workspace.inputs_dirs) ? state.workspace.inputs_dirs : [];
      const [detail, setDetail] = React.useState(null);
      const [nodeDetail, setNodeDetail] = React.useState(null);
      const [detailError, setDetailError] = React.useState(null);
      const [allOpen, setAllOpen] = React.useState(false);
      const [allData, setAllData] = React.useState(null);
      const [allError, setAllError] = React.useState(null);

      function openDetail(task) {
        const artifacts = state.artifacts && Array.isArray(state.artifacts[task.id]) ? state.artifacts[task.id] : [];
        const dispatch = dispatches.find((entry) => entry.task_id === task.id) || null;
        const inputsDir = inputsDirs.find((dir) => dir.task_id === task.id);
        setDetailError(null);
        setDetail({ task, artifacts, dispatch, inputs: inputsDir ? inputsDir.files : [] });
      }

      // A task this node dispatched lives on the peer: fetch it on demand; the
      // origin only keeps its own dispatch record. When the row sits inside the
      // all-tasks modal, report failures there instead of on the page behind it.
      async function openDispatch(dispatch, inModal = false) {
        if (inModal) setAllError(null);
        else setDetailError(null);
        try {
          const fetched = await api(
            "/orca-api/task?peer=" + encodeURIComponent(dispatch.peer) + "&task=" + encodeURIComponent(dispatch.task_id),
          );
          setDetail({
            task: fetched.task,
            artifacts: Array.isArray(fetched.artifacts) ? fetched.artifacts : [],
            dispatch,
            inputs: [],
          });
        } catch (err) {
          const message = t("dtLoadFailed") + messageOf(err);
          if (inModal) setAllError(message);
          else setDetailError(message);
        }
      }

      async function openAllTasks() {
        setDetailError(null);
        setAllError(null);
        setAllData(null);
        setAllOpen(true);
        try {
          const fetched = await api("/orca-api/tasks?limit=500");
          setAllData({
            tasks: Array.isArray(fetched.tasks) ? fetched.tasks : [],
            dispatches: Array.isArray(fetched.dispatches) ? fetched.dispatches : [],
            artifacts: fetched.artifacts && typeof fetched.artifacts === "object" ? fetched.artifacts : {},
          });
        } catch (err) {
          // Older host builds do not expose /orca-api/tasks yet; the polled
          // snapshot still carries the newest local tasks and dispatches.
          const snapshotTasks = Array.isArray(state.tasks) ? state.tasks : [];
          const snapshotDispatches = Array.isArray(dispatches) ? dispatches : [];
          if (snapshotTasks.length > 0 || snapshotDispatches.length > 0) {
            setAllData({
              tasks: snapshotTasks,
              dispatches: snapshotDispatches,
              artifacts: state.artifacts && typeof state.artifacts === "object" ? state.artifacts : {},
            });
            return;
          }
          setAllError(t("dtLoadFailed") + messageOf(err));
        }
      }

      function openAllTask(task) {
        const artifacts =
          allData && allData.artifacts && Array.isArray(allData.artifacts[task.id]) ? allData.artifacts[task.id] : [];
        const dispatch =
          allData && Array.isArray(allData.dispatches)
            ? allData.dispatches.find((entry) => entry.task_id === task.id) || null
            : null;
        setDetailError(null);
        setDetail({ task, artifacts, dispatch, inputs: [] });
      }

      // Accepts a bare host/IP, host:port, or a full http(s) URL.
      // The Host half normalizes the address and applies the default port.
      function peerUrl() {
        const raw = host.trim();
        if (raw.length === 0) throw new Error(t("peerHostRequired"));
        return raw;
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
          h("div", { style: { flex: 1 } }),
          connectionControl,
          h("button", { type: "button", style: ICON_BUTTON, title: t("settings"), onClick: props.onOpenSettings }, "⚙"),
        ),
        h(
          "div",
          { style: { ...MUTED, marginTop: 2 }, title: self ? self.orca_node_id : undefined },
          (self ? self.display_name || short(self.orca_node_id) : t("nodeNotRunning")) +
            " @ " +
            (config.workgroup_id || (self ? self.workgroup_id : "-")),
        ),
        self && self.busy
          ? h(
              "div",
              { style: { ...MUTED, marginTop: 2, color: "var(--dsw-alias-brand-primary)" }, title: self.busy.task_id },
              t("busy") +
                " · " +
                short(self.busy.task_id) +
                " · " +
                t("busyOrigin") +
                approvalsName(members, self.busy.origin_orca_node),
            )
          : null,
        props.error ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, props.error) : null,
        connectError ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, connectError) : null,
        detailError ? h("div", { style: { marginTop: 8, ...MUTED, color: "var(--dsw-alias-state-error-primary)" } }, detailError) : null,
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
                h("input", { style: INPUT, value: host, onChange: (event) => setHost(event.target.value), placeholder: "192.168.1.12 / peer.example.com / http://host:11811" }),
              ),

              h(
                "div",
                { style: { display: "flex", gap: 8 } },
                h("button", { type: "button", style: PRIMARY, disabled: props.busy, onClick: connect }, t("connect")),
                h("button", { type: "button", style: BUTTON, disabled: props.busy, onClick: () => setConnectOpen(false) }, t("cancel")),
              ),
            )
          : null,
        h("div", { style: SECTION }, h("div", { style: H2 }, t("pendingApprovals")), h(Approvals, { approvals: state.approvals, members: state.members, busy: props.busy, onAct: props.onAct })),
        h(
          "div",
          { style: SECTION },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 10 } },
            h("div", { style: H2 }, t("recentTasks")),
            h("div", { style: { flex: 1 } }),
            h("button", { type: "button", style: BUTTON, onClick: openAllTasks }, t("allTasks")),
          ),
          h(Tasks, { tasks: state.tasks, dispatches: dispatches, artifacts: state.artifacts, members, showArtifacts: false, limit: 5, busy: props.busy, onCancel: () => true, onAct: props.onAct, onOpen: openDetail, onOpenDispatch: openDispatch }),
        ),
        h("div", { style: SECTION }, h("div", { style: H2 }, t("members")), h(Members, { members: state.members, onOpen: setNodeDetail })),
        h("div", { style: SECTION }, h("div", { style: H2 }, t("workspace")), h(Workspace, { workspace: state.workspace })),
        h("div", { style: { ...SECTION, color: "var(--dsw-alias-label-secondary)", fontFamily: FONT_FAMILY, fontSize: 12, lineHeight: "18px" } }, t("updated") + age(state.now) + t("updatedSuffix")),
        allOpen ? h(AllTasks, { data: allData, error: allError, members, busy: props.busy, onAct: props.onAct, onOpenTask: openAllTask, onOpenDispatch: (dispatch) => openDispatch(dispatch, true), onClose: () => setAllOpen(false) }) : null,
        detail ? h(TaskDetail, { detail, members: self ? [self].concat(members) : members, onClose: () => setDetail(null) }) : null,
        nodeDetail ? h(NodeDetail, { detail: nodeDetail, members, onClose: () => setNodeDetail(null) }) : null,
      );
    }

    /** Short JSON preview of the tool arguments a remote node wants to run. */
    function describeRequested(value) {
      if (value === null || value === undefined) return "";
      let text;
      try {
        text = typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        text = String(value);
      }
      if (typeof text !== "string") return "";
      return text.length > 160 ? text.slice(0, 157) + "…" : text;
    }

    /** One parked approve prompt; the dock and the popup share it. */
    function PromptCard(props) {
      const prompt = props.prompt;
      const request = prompt.request || {};
      const tool = request.tool || prompt.tool || "";
      const requested = describeRequested(request.requested);
      const meta = prompt.peer + " · " + t("apTask") + " " + prompt.task_id;
      // Relayed requests carry the leaf-first requester chain in upstream; prefer
      // the leaf so the human sees who actually needs the permission, not just the
      // hop that forwarded it (§7.12).
      const chainNames = permissionChainNames(request, props.members);
      const leafName = chainNames.length === 0 ? null : chainNames[0];
      const chainLine = chainNames.length > 1 ? t("apChain") + chainNames.join(" → ") : null;
      const title = props.background ? t("apBackground") : leafName === null ? t("apTitle") : tFormat("apTitleNamed", { name: leafName });
      return h(
        "div",
        { style: props.background ? APPROVAL_POPUP_CARD : APPROVAL_DOCK_CARD },
        h(
          "div",
          { style: { fontFamily: FONT_FAMILY, fontSize: 14, fontWeight: 600, lineHeight: "22px" } },
          title,
        ),
        h("div", { style: { ...MUTED, padding: 0, whiteSpace: "normal" } }, meta),
        chainLine === null ? null : h("div", { style: { ...MUTED, padding: 0, whiteSpace: "normal" } }, chainLine),
        h(
          "div",
          { style: { fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: "20px", marginTop: 4, whiteSpace: "normal" } },
          tool ? t("apWants") + " " + t("tool") + " " + tool : t("apWants"),
          requested ? h("div", { style: { ...MUTED, padding: 0, whiteSpace: "normal", fontFamily: MONO_FONT, fontSize: 12, lineHeight: "18px" } }, requested) : null,
        ),
        h(
          "div",
          { style: APPROVAL_ROW },
          h(
            "button",
            {
              type: "button",
              style: PRIMARY,
              disabled: props.busy,
              onClick: () => props.onAct("approve", { peer: prompt.peer, task_id: prompt.task_id }),
            },
            t("apAllow"),
          ),
          h(
            "button",
            {
              type: "button",
              style: DANGER,
              disabled: props.busy,
              onClick: () => props.onAct("deny", { peer: prompt.peer, task_id: prompt.task_id, reason: "denied in the Orca Pod UI" }),
            },
            t("apDeny"),
          ),
          h("button", { type: "button", style: BUTTON, onClick: () => setPanelOpen(true) }, t("apInPanel")),
        ),
      );
    }

    /** Chat card: prompts parked by an `orca_pod` approve call in this session. */
    function ApprovalDock(props) {
      useLocaleTick();
      const sessionId = props && typeof props.sessionId === "string" ? props.sessionId : null;
      React.useEffect(() => {
        if (!sessionId) return undefined;
        activeSessionId = sessionId;
        return () => {
          if (activeSessionId === sessionId) activeSessionId = null;
        };
      }, [sessionId]);
      const { state, busy, act } = usePodState();
      const prompts = (state && state.prompts) || [];
      const mine = sessionId ? prompts.filter((prompt) => prompt.agent_id === sessionId) : [];
      if (mine.length === 0) return null;
      return h("div", { style: DOCK_WRAP }, mine.map((prompt) => h(PromptCard, { key: prompt.id, prompt, members: state && state.members, busy, onAct: act })));
    }

    /** Frame-wide popup: prompts parked by sessions that are not on screen. */
    function ApprovalPopup() {
      useLocaleTick();
      const { state, busy, act } = usePodState();
      const prompts = (state && state.prompts) || [];
      const background = prompts.filter((prompt) => !activeSessionId || prompt.agent_id !== activeSessionId);
      if (background.length === 0) return null;
      return h(
        "div",
        { style: POPUP_WRAP },
        background.map((prompt) => h(PromptCard, { key: prompt.id, prompt, members: state && state.members, busy, onAct: act, background: true })),
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
      useLocaleTick();
      const wide = !props || props.wide !== false;
      // The footer item is the always-visible status light (§9.2): green while
      // the mesh has peers, amber while a human decision is waiting, grey otherwise.
      const { state } = usePodState();
      const members = state && Array.isArray(state.members) ? state.members : [];
      // Only reachable peers count as "connected": offline records stay in the
      // roster snapshot but must not keep the light green.
      const reachable = members.filter((member) => member.state !== "offline");
      const approvals = state && Array.isArray(state.approvals) ? state.approvals : [];
      const prompts = state && Array.isArray(state.prompts) ? state.prompts : [];
      const pending = approvals.length + prompts.length;
      const color =
        pending > 0
          ? "var(--dsw-alias-state-warn-primary)"
          : reachable.length > 0
            ? "var(--dsw-alias-state-success-primary)"
            : "var(--dsw-alias-label-secondary)";
      const title = pending > 0 ? t("nav") + " · " + pending + " " + t("pendingApprovals") : t("nav");
      return h(
        "button",
        {
          type: "button",
          style: { ...FOOTER_ACTION, color },
          title,
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

    /** Locale face used for Chinese/English selection (hard `locale` dependency). */
    function resolveLocaleFace(ctx) {
      try {
        if (ctx && ctx.locale) return ctx.locale;
      } catch {
        /* injected locale is unavailable */
      }
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
      // Permission prompts: a chat card inside the session that dispatched the
      // task, plus a frame-wide popup for sessions that are not on screen.
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register({ name: "conversation.input.dock", id: NS + ".approval-dock", order: 60 }, ApprovalDock),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: NS + ".approval-popup", order: 61 }, ApprovalPopup),
      );
    }

    module.exports = { inject: ["slots", "locale"], apply };
    return module.exports;
  },
});
