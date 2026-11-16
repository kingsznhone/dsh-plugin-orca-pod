/**
 * Orca Pod panel — DSH client bundle (§9.2).
 *
 * The file is served by the DSH web server as a same-origin classic script and
 * registers a lazy factory with `window.__ModuleLoader__`. Inside the factory we
 * may only `require` the platform module table (`react`, `ctx`, `host`, `styles`,
 * `console`); host code is reached through the same-origin `/orca-api` routes
 * registered by `src/plugin/web.ts`, not through `host.call`.
 *
 * The host sends ready-to-render data (names, labels, links, what is
 * cancellable); this file only draws it and posts the user's actions back.
 *
 * Layout, top to bottom:
 *   1. i18n          dictionary, `t`, `useLocale`
 *   2. styles        theme-token style objects
 *   3. store         the one shared snapshot and its single poll timer
 *   4. primitives    Modal, Button, Table, Fact, Field, Updated
 *   5. approvals     ChainBadge, PromptCard, ApprovalList, dock and popup
 *   6. tasks         TaskTable, TaskDetail, AllTasks
 *   7. members       Members, NodeDetail, Workspace
 *   8. settings      ConfigForm and its sections
 *   9. panel         StatusPage, Panel, sidebar action, overlay
 *  10. slots         `apply`
 *
 * UI rules: render inside a Slot, inherit theme tokens via `--dsw-alias-*`, never
 * touch `document.body`, and keep all DOM work inside React.
 */
window.__ModuleLoader__.load({
  id: "orca-pod",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NS = "orca-pod";
    const POLL_MS = 2000;
    const DEFAULT_WORKGROUP = "WORKGROUP";
    const MIB = 1048576;
    const GIB = 1073741824;

    /* ===== 1. i18n ========================================================= */

    const TEXT = {
      en: {
        nav: "Orca Pod",
        close: "Close",
        settings: "Settings",
        connecting: "connecting to orca-pod…",
        nodeNotRunning: "node not running",
        connect: "Connect",
        disconnect: "Disconnect",
        cancel: "Cancel",
        notJoined: "Not connected to a peer yet — click Connect and enter a peer host and port.",
        connectPeer: "Connect to a peer",
        host: "host",
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
        apTitleTask: "Task {task} requests permission",
        apChain: "path: ",
        apChainTag: "approval path",
        apChainHint: "hover or click to see the approval path",
        apSelf: "this node",
        apBackground: "A background task needs permission",
        apWants: "wants to run",
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
        cfgPasswordHintWizard:
          "Required. Every node in this workgroup must use the same password; a passwordless open mesh is not supported.",
        cfgPasswordHintSet: "Leave blank to keep the current password; it is also reused when you switch workgroups.",
        cfgPasswordHintNone: "A password is required before this node can start.",
        cfgPasswordRequired: "Enter a workgroup password before saving.",
        cfgDisplayName: "display name",
        cfgDisplayNamePlaceholder: "blank = node id",
        cfgListenAddress: "listen address",
        cfgListenAddressHint:
          "127.0.0.1 keeps this node local; pick a LAN address (or :: for all interfaces) to accept peers.",
        cfgListenLoopback: "127.0.0.1 (this machine only)",
        cfgListenAll: ":: (all interfaces)",
        cfgListenPort: "listen port",
        cfgAdvertised: "local node addresses",
        cfgAdvanced: "advanced settings",
        cfgAdvancedHint:
          'Local connection and timeout controls. Blank means "use the default"; saving restarts this orca node.',
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
        cfgEndpointHint:
          "Detected this machine's IPv4/IPv6 addresses (avoid 127.0.0.1 — other machines cannot dial it). Add, remove or replace with a public hostname; leave empty to derive from the listen address.",
        cfgStart: "Start",
        cfgSave: "Save & restart",
        cfgUseExisting: "Use current configuration",
        cfgBack: "Back",
        cfgRunning: "running on ",
        cfgNotRunning: "not running",
        cfgWizardIntro: "First run: choose a workgroup and a password to join or create a mesh.",
        cfgResetIntro:
          "Full reset deletes the panel config (ui-config.json) and the node identity (config.json), returning to the first-run wizard. Tasks, blobs and workspace files are kept.",
        cfgReset: "Full reset",
        cfgResetConfirm: "Confirm reset (click again)",
        cfgPortInvalid: "must be an integer between 0 and 65535",
        cfgMaxWorkspaceGiB: "workspace size limit (GiB)",
        cfgMaxWorkspaceHint: "New tasks are refused while the workgroup workspace holds more than this.",
        cfgMaxWorkspaceFiles: "workspace file limit",
        cfgMaxBlobGiB: "blob store size limit (GiB)",
        cfgMaxBlobHint: "Uploads that would pass this size are refused.",
      },
      zh: {
        nav: "Orca Pod",
        close: "关闭",
        settings: "设置",
        connecting: "正在连接 orca-pod…",
        nodeNotRunning: "节点未运行",
        connect: "连接",
        disconnect: "断开",
        cancel: "取消",
        notJoined: "尚未连接 peer：点“连接”，填写对端主机与端口加入 mesh。",
        connectPeer: "连接 peer",
        host: "主机",
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
        apTitleTask: "任务 {task} 请求授权",
        apChain: "来源链：",
        apChainTag: "申请链路",
        apChainHint: "悬浮或点击查看申请链路",
        apSelf: "本机",
        apBackground: "后台任务请求权限",
        apWants: "请求执行",
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
        cfgListenAddress: "监听地址",
        cfgListenAddressHint:
          "127.0.0.1 只允许本机访问；要接受其他节点的任务，请选择局域网地址（或 :: 监听全部网卡）。",
        cfgListenLoopback: "127.0.0.1（仅本机）",
        cfgListenAll: "::（全部网卡）",
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
        cfgEndpointHint:
          "已自动识别本机 IPv4/IPv6 地址（默认不填 127.0.0.1，否则别的机器拨不到）；可增删或改成公网域名，全部清空则按监听地址自动识别。",
        cfgStart: "开始",
        cfgSave: "保存并重启",
        cfgUseExisting: "使用现有配置",
        cfgBack: "返回",
        cfgRunning: "运行中，端口 ",
        cfgNotRunning: "未运行",
        cfgWizardIntro: "首次启动：填写工作组与密码，加入或创建一个 mesh。",
        cfgResetIntro:
          "完全重置会删除面板配置（ui-config.json）与节点身份（config.json），回到首启向导；任务记录、blob 与工作区文件不受影响。",
        cfgReset: "完全重置",
        cfgResetConfirm: "确认重置（再次点击）",
        cfgPortInvalid: "必须是 0–65535 之间的整数",
        cfgMaxWorkspaceGiB: "工作区大小上限（GiB）",
        cfgMaxWorkspaceHint: "工作区超过该大小时拒绝新任务。",
        cfgMaxWorkspaceFiles: "工作区文件数上限",
        cfgMaxBlobGiB: "blob 存储大小上限（GiB）",
        cfgMaxBlobHint: "上传会使总量超过该值时被拒绝。",
      },
    };

    /** Translate a key; Chinese for zh-* UI languages, English otherwise. */
    function t(key) {
      const dict = activeLocale().toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en;
      return dict[key] ?? key;
    }

    /** Re-render on locale switches while mounted; call it in every slot root. */
    const subscribeLocale = (listener) => store.locale.subscribe(listener);
    const activeLocale = () => store.locale.getLocale().active;
    const useLocale = () => React.useSyncExternalStore(subscribeLocale, activeLocale);

    /* ===== 2. styles ======================================================= */

    /** DSH design-platform typography: 14/22 body, 13/20 secondary, 12/18 hint. */
    const FONT_FAMILY = "var(--dsw-font-family)";
    const MONO_FONT = "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)";
    const BORDER = "1px solid var(--dsw-alias-border-l1)";
    const FIELD_BORDER = "1px solid var(--dsw-alias-border-l2)";
    const RADIUS = "var(--dsw-radius-sm, 8px)";
    const Z_MODAL = 1000;
    const Z_POPUP = 1001;

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
    const ERROR = { ...MUTED, color: "var(--dsw-alias-state-error-primary)", whiteSpace: "normal" };
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
      borderRadius: RADIUS,
      padding: "0 14px",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
      border: FIELD_BORDER,
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
    };
    const DANGER = {
      ...BUTTON,
      borderColor: "var(--dsw-alias-state-error-primary)",
      color: "var(--dsw-alias-state-error-primary)",
    };
    const PRIMARY = {
      ...BUTTON,
      borderColor: "transparent",
      background: "var(--dsw-alias-brand-primary)",
      color: "var(--dsw-alias-bg-base)",
    };
    const ICON_BUTTON = { ...BUTTON, width: 32, padding: 0, fontSize: 16, lineHeight: 1 };
    const INPUT = {
      width: "100%",
      boxSizing: "border-box",
      minHeight: 34,
      padding: "6px 10px",
      borderRadius: RADIUS,
      border: FIELD_BORDER,
      background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))",
      color: "var(--dsw-alias-label-primary)",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
    };
    const FIELD = { display: "block", marginBottom: 14 };
    const LABEL = {
      display: "block",
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: "20px",
      marginBottom: 4,
      color: "var(--dsw-alias-label-secondary)",
    };
    const HINT = {
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      lineHeight: "18px",
      color: "var(--dsw-alias-label-secondary)",
      marginTop: 4,
    };
    const FACT = { display: "flex", gap: 10, marginTop: 6, alignItems: "baseline" };
    const LINK = { display: "inline-block", marginRight: 10, color: "var(--dsw-alias-brand-primary)" };
    const OVERLAY = {
      position: "fixed",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      zIndex: Z_MODAL,
      pointerEvents: "auto",
      background: "var(--dsw-alias-bg-mask-1)",
    };
    const CARD = {
      position: "relative",
      boxSizing: "border-box",
      maxHeight: "min(84vh, 880px)",
      overflow: "auto",
      padding: "24px 26px 22px",
      borderRadius: "var(--dsw-radius-lg, 16px)",
      border: BORDER,
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
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
      borderRadius: RADIUS,
      background: "transparent",
      color: "var(--dsw-alias-label-secondary)",
      fontFamily: FONT_FAMILY,
      fontSize: 18,
      lineHeight: 1,
    };
    const PROMPT_CARD = {
      pointerEvents: "auto",
      boxSizing: "border-box",
      padding: "12px 16px",
      borderRadius: "var(--dsw-radius-panel, 16px)",
      border: FIELD_BORDER,
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
    };
    /* The dock card sits inline above the composer, on the composer's width axis. */
    const DOCK_CARD = {
      ...PROMPT_CARD,
      width: "100%",
      maxWidth: "var(--dsh-composer-card-max-width, 952px)",
      margin: "0 auto",
    };
    const POPUP_CARD = { ...PROMPT_CARD, width: "min(380px, calc(100vw - 32px))" };
    const GROUP = { display: "flex", flexDirection: "column", gap: 8 };
    const DOCK_GROUP = {
      ...GROUP,
      boxSizing: "border-box",
      width: "100%",
      padding: "0 var(--dsh-composer-side-clearance, 16px)",
    };
    const POPUP_GROUP = { ...GROUP, position: "fixed", right: 16, bottom: 56, zIndex: Z_POPUP, pointerEvents: "none" };
    const FOOTER_ACTION = {
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      padding: "8px 10px",
      borderRadius: RADIUS,
      border: "1px solid transparent",
      background: "transparent",
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      lineHeight: "22px",
      textAlign: "left",
    };
    const CHAIN_TAG = {
      ...MUTED,
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "1px 8px",
      border: BORDER,
      borderRadius: 999,
      background: "var(--dsw-alias-bg-layer-1)",
      cursor: "pointer",
      fontFamily: "inherit",
      fontSize: 12,
      lineHeight: "18px",
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
      submitted: "taskSubmitted",
      working: "taskWorking",
      "input-required": "taskInputRequired",
      completed: "taskCompleted",
      failed: "taskFailed",
      canceled: "taskCanceled",
    };

    const stateLabel = (value) => t(STATE_KEY[value]);
    const short = (id) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

    function ageOf(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.round(s / 60)}m`;
      return `${Math.round(s / 3600)}h`;
    }
    const age = (iso) => ageOf(Date.parse(iso));

    /* ===== 3. store ======================================================== */

    async function api(path, body) {
      const init =
        body === undefined
          ? { headers: { "x-orca-pod": "1" } }
          : {
              method: "POST",
              headers: { "x-orca-pod": "1", "content-type": "application/json" },
              body: JSON.stringify(body),
            };
      const response = await fetch(`/orca-api/${path}`, init);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    }

    const messageOf = (error) => (error instanceof Error ? error.message : String(error));

    /**
     * The one shared snapshot every slot component reads. A single timer polls
     * `/state` while anything is subscribed and stops with the last subscriber;
     * an action refreshes the snapshot for everyone, and an unchanged payload
     * leaves it (and every component) untouched.
     */
    function createStore() {
      let snap = { state: null, error: null, actionError: null, busy: false, panelOpen: false, docked: [] };
      let payload = "";
      let polledAt = 0;
      let loop = 0;
      let timer = 0;
      const listeners = new Set();

      function set(patch) {
        snap = { ...snap, ...patch };
        for (const listener of listeners) listener();
      }

      async function refresh() {
        try {
          const next = await api("state");
          polledAt = Date.now();
          const text = JSON.stringify(next);
          if (text !== payload) {
            payload = text;
            set({ state: next, error: null });
          } else if (snap.error !== null) {
            set({ error: null });
          }
        } catch (err) {
          if (snap.error !== messageOf(err)) set({ error: messageOf(err) });
        }
      }

      /** POST one action and refresh; resolves false (error kept in `actionError`) when the host refused. */
      async function act(path, body) {
        set({ busy: true, actionError: null });
        try {
          await api(path, body);
          await refresh();
          return true;
        } catch (err) {
          set({ actionError: messageOf(err) });
          return false;
        } finally {
          set({ busy: false });
        }
      }

      function start() {
        const id = ++loop;
        (async function tick() {
          await refresh();
          if (id === loop) timer = window.setTimeout(tick, POLL_MS);
        })();
      }

      function subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) start();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            loop += 1;
            window.clearTimeout(timer);
          }
        };
      }

      /** Mark a session as showing its own approval dock, so the popup skips its prompts. */
      function dock(sessionId) {
        set({ docked: [...snap.docked, sessionId] });
        return () => set({ docked: snap.docked.filter((id) => id !== sessionId) });
      }

      return {
        /** Client locale service, bound once by `apply`. */
        locale: null,
        get: () => snap,
        polledAt: () => polledAt,
        subscribe,
        act,
        dock,
        setPanelOpen: (panelOpen) => set({ panelOpen }),
      };
    }

    const store = createStore();
    const useStore = () => React.useSyncExternalStore(store.subscribe, store.get);

    /** Fetch one read-only route on mount (and when `version` changes). */
    function useApi(path, version = 0) {
      const [result, setResult] = React.useState({ data: null, error: null });
      React.useEffect(() => {
        let live = true;
        api(path).then(
          (data) => live && setResult({ data, error: null }),
          (err) => live && setResult({ data: null, error: messageOf(err) }),
        );
        return () => {
          live = false;
        };
      }, [path, version]);
      return result;
    }

    /* ===== 4. primitives ==================================================== */

    const Button = ({ style = BUTTON, ...props }) => h("button", { type: "button", style, ...props });

    /** Centered dialog: role, Escape, backdrop click, initial focus and focus return. */
    function Modal({ label, width = "min(720px, calc(100vw - 48px))", onClose, children }) {
      const card = React.useRef(null);
      React.useEffect(() => {
        const opener = document.activeElement;
        card.current.focus();
        return () => opener.focus?.();
      }, []);
      return h(
        "div",
        { style: OVERLAY, onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          "div",
          {
            ref: card,
            role: "dialog",
            "aria-modal": "true",
            "aria-label": label,
            tabIndex: -1,
            style: { ...CARD, width, outline: "none" },
            onKeyDown: (event) => event.key === "Escape" && onClose(),
          },
          h(Button, { style: CLOSE_BUTTON, title: t("close"), "aria-label": t("close"), onClick: onClose }, "×"),
          children,
        ),
      );
    }

    function Table({ columns, children }) {
      return h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%" } },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            columns.map((title, index) =>
              h("th", { key: index, scope: "col", style: { ...MUTED, textAlign: "left", fontWeight: 500 } }, title),
            ),
          ),
        ),
        h("tbody", null, children),
      );
    }

    /** Clickable table row; buttons inside stop the click from reaching it. */
    const Row = ({ onClick, children }) =>
      h("tr", { onClick, style: onClick ? { cursor: "pointer" } : undefined }, children);
    const stop = (handler) => (event) => {
      event.stopPropagation();
      handler();
    };

    /** One label/value line of a detail dialog. */
    const Fact = ({ label, children }) =>
      h(
        "div",
        { style: FACT },
        h("div", { style: { ...MUTED, minWidth: 72 } }, label),
        h("div", { style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, children),
      );

    /** One labelled form control (a `<label>` unless it holds several controls). */
    const Field = ({ label, hint, group, children }) =>
      h(
        group ? "div" : "label",
        { style: FIELD },
        h("span", { style: LABEL }, label),
        children,
        hint ? h("div", { style: HINT }, hint) : null,
      );

    const Section = ({ title, action, children }) =>
      h(
        "div",
        { style: SECTION },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10 } },
          h("div", { style: H2 }, title),
          h("div", { style: { flex: 1 } }),
          action,
        ),
        children,
      );

    /** "updated Ns ago", measured from the last successful poll and ticking every second. */
    function Updated() {
      const [, tick] = React.useState(0);
      React.useEffect(() => {
        const id = window.setInterval(() => tick((n) => n + 1), 1000);
        return () => window.clearInterval(id);
      }, []);
      return h(
        "div",
        { style: { ...HINT, marginTop: 22 } },
        t("updated") + ageOf(store.polledAt()) + t("updatedSuffix"),
      );
    }

    /* ===== 5. approvals ==================================================== */

    /** Root-to-leaf approval path as a vertical stack. */
    function ChainFlow({ chain }) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4, paddingLeft: 4 } },
        chain.map((entry, index) => {
          const last = index === chain.length - 1;
          return h(
            "div",
            { key: index, style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", {
              style: {
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "0 0 auto",
                background: last ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)",
              },
            }),
            h(
              "span",
              { style: { fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: "18px", fontWeight: last ? 600 : 400 } },
              entry.name,
            ),
            entry.self ? h("span", { style: { ...MUTED, padding: 0, fontSize: 11 } }, t("apSelf")) : null,
            !last
              ? h(
                  "span",
                  { "aria-hidden": "true", style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
                  "↓",
                )
              : null,
          );
        }),
      );
    }

    /** Compact tag for the approval path; hover or click opens the hops. */
    function ChainBadge({ chain }) {
      const [hover, setHover] = React.useState(false);
      const [pinned, setPinned] = React.useState(false);
      if (chain.length < 2) return null;
      const open = hover || pinned;
      return h(
        "span",
        {
          style: { position: "relative", display: "inline-flex", minWidth: 0 },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          Button,
          { style: CHAIN_TAG, title: t("apChainHint"), "aria-expanded": open, onClick: stop(() => setPinned(!pinned)) },
          t("apChainTag"),
          h("span", { style: { fontSize: 10, lineHeight: "10px" } }, "▾"),
        ),
        open
          ? h(
              "div",
              {
                style: { position: "absolute", top: "100%", left: 0, paddingTop: 6, zIndex: 2 },
                onClick: (event) => event.stopPropagation(),
              },
              h(
                "div",
                {
                  style: {
                    minWidth: 200,
                    padding: "10px 12px",
                    background: "var(--dsw-alias-bg-layer-1)",
                    border: BORDER,
                    borderRadius: "var(--dsw-radius-md, 10px)",
                  },
                },
                h("div", { style: { ...MUTED, padding: 0, fontSize: 11, marginBottom: 6 } }, t("apChain")),
                h(ChainFlow, { chain }),
              ),
            )
          : null,
      );
    }

    const answer = (kind, approval) => store.act(kind, { peer: approval.peer, task_id: approval.task_id });

    /** One waiting permission request as a card; the dock and the popup share it. */
    function PromptCard({ approval, background, busy }) {
      const title = background ? t("apBackground") : t("apTitleTask").replace("{task}", short(approval.task_id));
      return h(
        "div",
        { role: "group", "aria-label": title, style: background ? POPUP_CARD : DOCK_CARD },
        h("div", { style: { fontFamily: FONT_FAMILY, fontSize: 14, fontWeight: 600, lineHeight: "22px" } }, title),
        h(
          "div",
          {
            style: {
              ...MUTED,
              padding: 0,
              whiteSpace: "normal",
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexWrap: "wrap",
            },
          },
          t("from") + approval.from,
          h(ChainBadge, { chain: approval.chain }),
        ),
        h(
          "div",
          { style: { fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: "20px", marginTop: 4, whiteSpace: "normal" } },
          `${t("apWants")} ${t("tool")} ${approval.tool}`,
          approval.requested
            ? h(
                "div",
                {
                  style: {
                    ...MUTED,
                    padding: 0,
                    whiteSpace: "normal",
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    lineHeight: "18px",
                  },
                },
                approval.requested,
              )
            : null,
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" } },
          h(Button, { style: PRIMARY, disabled: busy, onClick: () => answer("approve", approval) }, t("apAllow")),
          h(Button, { style: DANGER, disabled: busy, onClick: () => answer("deny", approval) }, t("apDeny")),
          h(Button, { onClick: () => store.setPanelOpen(true) }, t("apInPanel")),
        ),
      );
    }

    /** Approvals the human can answer from chat: one card each, plus the last action error. */
    function PromptGroup({ approvals, background, style }) {
      const { busy, actionError } = useStore();
      if (approvals.length === 0) return null;
      return h(
        "div",
        { style },
        approvals.map((approval) => h(PromptCard, { key: approval.id, approval, background, busy })),
        actionError ? h("div", { style: ERROR }, actionError) : null,
      );
    }

    /** Chat card: the prompts of the session this dock sits in. */
    function ApprovalDock({ sessionId }) {
      useLocale();
      const { state } = useStore();
      React.useEffect(() => store.dock(sessionId), [sessionId]);
      const mine = state === null ? [] : state.approvals.filter((approval) => approval.agent_id === sessionId);
      return h(PromptGroup, { approvals: mine, style: DOCK_GROUP });
    }

    /** Frame-wide popup: prompts of sessions that are not on screen. */
    function ApprovalPopup() {
      useLocale();
      const { state, docked } = useStore();
      const away =
        state === null
          ? []
          : state.approvals.filter((approval) => approval.agent_id !== null && !docked.includes(approval.agent_id));
      return h(PromptGroup, { approvals: away, background: true, style: POPUP_GROUP });
    }

    /** Panel list of the same requests, answerable in place. */
    function ApprovalList({ approvals, busy }) {
      if (approvals.length === 0) return h("div", { style: MUTED }, t("nothingWaiting"));
      return approvals.map((approval) =>
        h(
          "div",
          { key: approval.id, style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
          h("span", { style: CELL }, short(approval.task_id)),
          h("span", { style: MUTED }, approval.tool),
          h(
            "span",
            { style: { ...MUTED, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 } },
            t("from") + approval.from,
            h(ChainBadge, { chain: approval.chain }),
          ),
          h(Button, { disabled: busy, onClick: () => answer("approve", approval) }, t("approve")),
          h(Button, { style: DANGER, disabled: busy, onClick: () => answer("deny", approval) }, t("deny")),
        ),
      );
    }

    /* ===== 6. tasks ======================================================== */

    /** Recent or all tasks: rows arrive merged, sorted and labelled by the host. */
    function TaskTable({ rows, showArtifacts, busy, onOpen, onCancel }) {
      if (rows.length === 0) return h("div", { style: MUTED }, t("noTasks"));
      const columns = [
        t("colTask"),
        t("colState"),
        t("colOrigin"),
        t("colAge"),
        ...(showArtifacts ? [t("colArtifacts")] : []),
        "",
      ];
      return h(
        Table,
        { columns },
        rows.map((row) =>
          h(
            Row,
            { key: row.id, onClick: () => onOpen(row) },
            h("td", { style: { ...CELL, fontFamily: MONO_FONT } }, short(row.id)),
            h("td", { style: CELL }, stateLabel(row.state)),
            h("td", { style: MUTED, title: row.who_title }, row.who),
            h("td", { style: MUTED }, age(row.at)),
            showArtifacts
              ? h(
                  "td",
                  { style: CELL, onClick: (event) => event.stopPropagation() },
                  row.artifacts.map((link) =>
                    link.url
                      ? h(
                          "a",
                          { key: link.blob_id, href: link.url, target: "_blank", rel: "noreferrer", style: LINK },
                          link.name,
                        )
                      : h("span", { key: link.blob_id, style: { ...MUTED, marginRight: 10 } }, link.name),
                  ),
                )
              : null,
            h(
              "td",
              { style: CELL },
              h(
                "div",
                { style: { display: "flex", gap: 6, alignItems: "center" } },
                h(Button, { onClick: stop(() => onOpen(row)) }, t("details")),
                row.cancellable
                  ? h(Button, { style: DANGER, disabled: busy, onClick: stop(() => onCancel(row)) }, t("cancel"))
                  : null,
              ),
            ),
          ),
        ),
      );
    }

    /** Task detail: one `/task` call returns the task, its dispatch record, artifacts and inputs. */
    function TaskDetail({ peer, taskId, onClose }) {
      const { data, error } = useApi(`task?peer=${encodeURIComponent(peer)}&task=${encodeURIComponent(taskId)}`);
      let body = h("div", { style: MUTED }, t("tasksLoading"));
      if (error !== null) body = h("div", { style: ERROR }, t("dtLoadFailed") + error);
      if (data !== null) {
        const { task, origin, dispatch, artifacts, inputs } = data;
        const pod = task.metadata?.pod ?? {};
        const message = (task.status.message?.parts ?? [])
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n");
        body = [
          h(Fact, { key: "state", label: t("colState") }, stateLabel(task.status.state)),
          h(Fact, { key: "origin", label: t("dtOrigin") }, origin),
          h(Fact, { key: "context", label: t("dtContext") }, task.contextId),
          h(Fact, { key: "updated", label: t("dtUpdated") }, task.status.timestamp),
          task.status.reason ? h(Fact, { key: "reason", label: t("dtReason") }, task.status.reason) : null,
          pod.model
            ? h(
                Fact,
                { key: "model", label: t("dtModel") },
                pod.model.provider +
                  "/" +
                  pod.model.model +
                  (pod.model.reasoning_effort ? ` · ${pod.model.reasoning_effort}` : ""),
              )
            : null,
          pod.hop === undefined
            ? null
            : h(
                Fact,
                { key: "hop", label: t("dtTimeline") },
                `hop ${pod.hop}${pod.root ? ` · root ${short(pod.root)}` : ""}`,
              ),
          message ? h(Fact, { key: "message", label: t("dtMessage") }, message) : null,
          h("div", { key: "dispatch-title", style: { ...H2, marginTop: 16 } }, t("dtDispatch")),
          dispatch === null
            ? h("div", { key: "dispatch", style: MUTED }, t("dtDispatchNone"))
            : h(
                React.Fragment,
                { key: "dispatch" },
                h(Fact, { label: t("dtPeer") }, dispatch.peer),
                h(Fact, { label: t("colState") }, stateLabel(dispatch.state)),
                h(Fact, { label: t("dtCreated") }, dispatch.created_at),
                h(Fact, { label: t("dtUpdated") }, dispatch.updated_at),
                dispatch.parent_local_task_id
                  ? h(Fact, { label: t("dtTimeline") }, short(dispatch.parent_local_task_id))
                  : null,
                dispatch.last_error ? h(Fact, { label: t("dtLastError") }, dispatch.last_error) : null,
              ),
          h("div", { key: "artifacts-title", style: { ...H2, marginTop: 16 } }, t("dtArtifacts")),
          h(
            "div",
            { key: "artifacts", style: { marginTop: 6 } },
            artifacts.length === 0
              ? h("span", { style: MUTED }, t("dtArtifactsNone"))
              : artifacts.map((link) =>
                  link.url
                    ? h(
                        "a",
                        { key: link.blob_id, href: link.url, target: "_blank", rel: "noreferrer", style: LINK },
                        link.name,
                      )
                    : h(
                        "span",
                        { key: link.blob_id, style: { ...MUTED, display: "inline-block", marginRight: 10 } },
                        link.name,
                      ),
                ),
          ),
          h("div", { key: "inputs-title", style: { ...H2, marginTop: 16 } }, t("dtInputs")),
          h(
            "div",
            { key: "inputs", style: { marginTop: 6 } },
            inputs.length === 0
              ? h("span", { style: MUTED }, t("dtInputsNone"))
              : inputs.map((name) =>
                  h("span", { key: name, style: { ...MUTED, marginRight: 10, fontFamily: MONO_FONT } }, name),
                ),
          ),
        ];
      }
      return h(
        Modal,
        { label: t("dtTitle"), width: "min(680px, calc(100vw - 40px))", onClose },
        h("div", { style: { ...H2, marginBottom: 6 } }, t("dtTitle")),
        h("div", { style: { ...MUTED, fontFamily: MONO_FONT, wordBreak: "break-all", marginBottom: 8 } }, taskId),
        body,
      );
    }

    function AllTasks({ onOpen, onClose }) {
      const { busy } = useStore();
      const [version, setVersion] = React.useState(0);
      const { data, error } = useApi("tasks?limit=500", version);
      async function cancel(row) {
        if (await store.act("cancel", { peer: row.peer, task_id: row.id })) setVersion(version + 1);
      }
      let body = h("div", { style: MUTED }, t("tasksLoading"));
      if (error !== null) body = h("div", { style: ERROR }, t("dtLoadFailed") + error);
      if (data !== null)
        body = h(TaskTable, { rows: data.recent, showArtifacts: true, busy, onOpen, onCancel: cancel });
      return h(
        Modal,
        { label: t("allTasks"), width: "min(1040px, calc(100vw - 40px))", onClose },
        h("div", { style: { ...H2, marginBottom: 10 } }, t("allTasks")),
        body,
      );
    }

    /* ===== 7. members ====================================================== */

    function Members({ members, onOpen }) {
      if (members.length === 0) return h("div", { style: MUTED }, t("noPeers"));
      return h(
        Table,
        { columns: [t("colNode"), t("colBusy"), t("colModel"), ""] },
        members.map((member) =>
          h(
            Row,
            { key: member.orca_node_id, onClick: () => onOpen(member) },
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
                title: `${member.orca_node_id} · ${stateLabel(member.state)}`,
              },
              member.display_name,
            ),
            h(
              "td",
              { style: CELL, title: member.busy ? `${member.busy.task_id} · ${member.busy_from}` : undefined },
              member.busy ? short(member.busy.task_id) : "-",
            ),
            h(
              "td",
              { style: MUTED },
              member.default_model ? `${member.default_model.provider}/${member.default_model.model}` : "-",
            ),
            h(
              "td",
              { style: { ...CELL, textAlign: "right" } },
              h(Button, { onClick: stop(() => onOpen(member)) }, t("ndOpen")),
            ),
          ),
        ),
      );
    }

    const modelText = (model) =>
      `${model.provider}/${model.model}${model.reasoning_effort ? ` · ${model.reasoning_effort}` : ""}`;

    function NodeDetail({ member, onClose }) {
      const { runtime } = member;
      const models = member.models ?? [];
      return h(
        Modal,
        { label: t("ndTitle"), width: "min(620px, calc(100vw - 40px))", onClose },
        h("div", { style: { ...H2, marginBottom: 6 } }, t("ndTitle")),
        h(Fact, { label: t("colNode") }, member.display_name),
        h(Fact, { label: t("ndId") }, member.orca_node_id),
        h(Fact, { label: t("colState") }, stateLabel(member.state)),
        h(
          Fact,
          { label: t("colBusy") },
          member.busy ? `${short(member.busy.task_id)} · ${t("busyOrigin")}${member.busy_from}` : t("idle"),
        ),
        h(Fact, { label: t("ndLastSeen") }, member.last_recv_at ? age(member.last_recv_at) + t("updatedSuffix") : "-"),
        h(Fact, { label: t("ndBudget") }, member.max_task_ttl_s ? `${member.max_task_ttl_s} s` : "-"),
        h("div", { style: { ...H2, marginTop: 16 } }, t("ndRuntime")),
        runtime === null
          ? h("div", { style: MUTED }, "-")
          : [
              h(
                Fact,
                { key: "os", label: t("colOs") },
                `${[runtime.os.name, runtime.os.version].join(" ")} · ${runtime.os.family}`,
              ),
              h(
                Fact,
                { key: "cpu", label: "cpu" },
                `${runtime.cpu.model} · ${runtime.cpu.logical_cores} ${t("ndCores")}`,
              ),
              h(Fact, { key: "memory", label: t("ndMemory") }, `${(runtime.memory.total_bytes / GIB).toFixed(1)} GiB`),
              h(Fact, { key: "node", label: "node" }, `node ${runtime.node.version} · ${runtime.arch}`),
            ],
        h("div", { style: { ...H2, marginTop: 16 } }, t("ndModels")),
        h(Fact, { label: t("ndDefaultModel") }, member.default_model ? modelText(member.default_model) : "-"),
        models.length === 0
          ? h("div", { style: MUTED }, t("ndNoModels"))
          : models.map((model) =>
              h(
                "div",
                { key: `${model.provider}/${model.model}`, style: { marginTop: 6 } },
                h("div", { style: { fontFamily: MONO_FONT } }, `${model.provider}/${model.model}`),
                model.name || model.description
                  ? h(
                      "div",
                      { style: { ...MUTED, fontSize: 12 } },
                      [model.name, model.description].filter(Boolean).join(" · "),
                    )
                  : null,
              ),
            ),
        h("div", { style: { ...H2, marginTop: 16 } }, t("colEndpoints")),
        member.endpoints.map((url) =>
          h(
            "div",
            { key: url, style: { fontFamily: MONO_FONT, wordBreak: "break-all", marginTop: 4, fontSize: 12 } },
            url,
          ),
        ),
      );
    }

    function Workspace({ workspace }) {
      if (workspace === null) return h("div", { style: MUTED }, t("workspaceUnavailable"));
      const inputs = workspace.inputs_dirs.map((dir) => `${short(dir.task_id)} (${dir.files})`);
      return h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
        h("div", { style: { fontFamily: MONO_FONT, wordBreak: "break-all" } }, workspace.root),
        h("div", { style: { marginTop: 4 } }, t("notes") + (workspace.notes_files.join(", ") || t("empty"))),
        h("div", { style: { marginTop: 4 } }, t("inputs") + (inputs.join(", ") || t("empty"))),
      );
    }

    /* ===== 8. settings ===================================================== */

    /** Numeric limits; `unit` converts the displayed MiB/GiB to the bytes the host stores. */
    const LIMITS = [
      { key: "task_timeout_s", label: "cfgTaskTimeout", hint: "cfgTaskTimeoutHint" },
      { key: "approval_timeout_s", label: "cfgApprovalTimeout", hint: "cfgApprovalTimeoutHint" },
      { key: "result_max_bytes", label: "cfgResultMaxBytes", integer: true },
      { key: "max_input_files", label: "cfgMaxInputFiles", integer: true },
      { key: "max_input_bytes", label: "cfgMaxInputMiB", unit: MIB },
      { key: "max_workspace_bytes", label: "cfgMaxWorkspaceGiB", hint: "cfgMaxWorkspaceHint", unit: GIB },
      { key: "max_workspace_files", label: "cfgMaxWorkspaceFiles", integer: true },
      { key: "max_blob_store_bytes", label: "cfgMaxBlobGiB", hint: "cfgMaxBlobHint", unit: GIB },
    ];
    const BOOLEANS = ["allow_public_peers", "allow_loopback_peers"];

    function selectFields() {
      const tri = [
        ["", t("cfgDefaultOption")],
        ["allow", t("cfgAllowOption")],
        ["deny", t("cfgDenyOption")],
      ];
      const literal = (...values) => [["", t("cfgDefaultOption")], ...values.map((value) => [value, value])];
      return [
        ["permission_mode", "cfgPermissionMode", literal("read-only", "workspace-write", "danger-full-access")],
        ["allow_public_peers", "cfgAllowPublicPeers", tri],
        ["allow_loopback_peers", "cfgAllowLoopbackPeers", tri],
        ["default_reasoning_effort", "cfgDefaultEffort", literal("off", "low", "high", "max"), "cfgDefaultEffortHint"],
        ["executor", "cfgExecutor", literal("acp", "echo"), "cfgExecutorHint"],
      ];
    }

    const unitText = (value, unit = 1) => (value === null ? "" : String(+(value / unit).toFixed(3)));

    function initialForm(config, wizard) {
      const { advanced } = config;
      const form = {
        workgroup_id: config.workgroup_id || DEFAULT_WORKGROUP,
        password: "",
        /* The first run starts from this node's own id; a configured install keeps its saved name. */
        display_name: (wizard ? config.node_id : config.display_name) ?? "",
        bind_host: config.bind_host,
        port: String(config.port),
        endpoints: config.suggested_endpoints.length > 0 ? config.suggested_endpoints : [""],
      };
      for (const limit of LIMITS) form[limit.key] = unitText(advanced[limit.key], limit.unit);
      for (const [key] of selectFields()) {
        const value = advanced[key];
        form[key] = BOOLEANS.includes(key) ? (value === null ? "" : value ? "allow" : "deny") : (value ?? "");
      }
      return form;
    }

    /** Form text to the patch the host validates; `null` clears a field. Returns `{ error }` for input it cannot convert. */
    function buildPatch(form, config, wizard) {
      const port = Number(form.port);
      if (form.port.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535)
        return { error: `${t("cfgListenPort")} ${t("cfgPortInvalid")}` };
      if (form.password.length === 0 && (wizard || !config.password_set)) return { error: t("cfgPasswordRequired") };
      const addresses = form.endpoints.map((row) => row.trim()).filter(Boolean);
      const patch = {
        workgroup_id: form.workgroup_id.trim().toLowerCase(),
        display_name: form.display_name.trim() || null,
        bind_host: form.bind_host,
        port,
        endpoints: addresses.length > 0 ? addresses : null,
      };
      if (form.password.length > 0) patch.workgroup_password = form.password;
      for (const { key, label, integer, unit } of LIMITS) {
        const text = form[key].trim();
        const value = Number(text);
        if (text === "") {
          patch[key] = null;
        } else if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
          return { error: `${t(label)} ${t("cfgAdvancedInvalid")}` };
        } else if (unit === undefined) {
          patch[key] = value;
        } else {
          /* An untouched field keeps its exact byte count instead of the rounded display. */
          const original = config.advanced[key];
          patch[key] = text === unitText(original, unit) ? original : Math.round(value * unit);
        }
      }
      for (const [key] of selectFields()) {
        patch[key] = BOOLEANS.includes(key) ? (form[key] === "" ? null : form[key] === "allow") : form[key] || null;
      }
      return { patch };
    }

    function IdentitySection({ bind, wizard, config }) {
      const placeholder = wizard || !config.password_set ? t("cfgPasswordOpen") : t("cfgPasswordKeep");
      const hint = wizard
        ? t("cfgPasswordHintWizard")
        : config.password_set
          ? t("cfgPasswordHintSet")
          : t("cfgPasswordHintNone");
      return [
        h(
          Field,
          { key: "id", label: t("cfgWorkgroupId"), hint: t("cfgWorkgroupIdHint") },
          h("input", { style: INPUT, placeholder: DEFAULT_WORKGROUP, ...bind("workgroup_id") }),
        ),
        h(
          Field,
          { key: "password", label: t("cfgPassword"), hint },
          h("input", { style: INPUT, type: "password", placeholder, ...bind("password") }),
        ),
        h(
          Field,
          { key: "name", label: t("cfgDisplayName") },
          h("input", { style: INPUT, placeholder: t("cfgDisplayNamePlaceholder"), ...bind("display_name") }),
        ),
      ];
    }

    function NetworkSection({ form, set, bind, config, busy }) {
      const rows = form.endpoints;
      const edit = (index, value) =>
        set(
          "endpoints",
          rows.map((row, i) => (i === index ? value : row)),
        );
      const remove = (index) => set("endpoints", rows.length === 1 ? [""] : rows.filter((_, i) => i !== index));
      const bindLabel = (host) =>
        host === "127.0.0.1" ? t("cfgListenLoopback") : host === "::" ? t("cfgListenAll") : host;
      return [
        h(
          Field,
          { key: "bind", label: t("cfgListenAddress"), hint: t("cfgListenAddressHint") },
          h(
            "select",
            { style: INPUT, ...bind("bind_host") },
            config.bind_choices.map((host) => h("option", { key: host, value: host }, bindLabel(host))),
          ),
        ),
        h(
          Field,
          { key: "port", label: t("cfgListenPort") },
          h("input", { style: INPUT, inputMode: "numeric", ...bind("port") }),
        ),
        h(
          Field,
          { key: "endpoints", group: true, label: t("cfgAdvertised"), hint: t("cfgEndpointHint") },
          rows.map((row, index) =>
            h(
              "div",
              { key: index, style: { display: "flex", gap: 6, marginBottom: 6 } },
              h("input", {
                style: { ...INPUT, flex: 1, fontFamily: MONO_FONT },
                value: row,
                onChange: (event) => edit(index, event.target.value),
                placeholder: "http://192.168.1.11:11811",
              }),
              h(Button, { disabled: busy, onClick: () => remove(index) }, t("cfgRemove")),
            ),
          ),
          h(Button, { disabled: busy, onClick: () => set("endpoints", [...rows, ""]) }, t("cfgAddEndpoint")),
        ),
      ];
    }

    function AdvancedSection({ bind }) {
      const [open, setOpen] = React.useState(false);
      return h(
        "details",
        { style: { marginTop: 6, marginBottom: 14 }, open, onToggle: (event) => setOpen(event.currentTarget.open) },
        h(
          "summary",
          { style: { cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
          t("cfgAdvanced"),
        ),
        h("div", { style: { ...HINT, marginBottom: 10 } }, t("cfgAdvancedHint")),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12 } },
          LIMITS.map((limit) =>
            h(
              Field,
              { key: limit.key, label: t(limit.label), hint: limit.hint && t(limit.hint) },
              h("input", { style: INPUT, inputMode: "decimal", ...bind(limit.key) }),
            ),
          ),
          selectFields().map(([key, label, options, hint]) =>
            h(
              Field,
              { key, label: t(label), hint: hint && t(hint) },
              h(
                "select",
                { style: INPUT, ...bind(key) },
                options.map(([value, text]) => h("option", { key: value, value }, text)),
              ),
            ),
          ),
        ),
      );
    }

    function ConfigForm({ config, wizard, onDone }) {
      const { busy, actionError } = useStore();
      const [form, setForm] = React.useState(() => initialForm(config, wizard));
      const [error, setError] = React.useState(null);
      const [resetArmed, setResetArmed] = React.useState(false);
      const set = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
      const bind = (key) => ({ value: form[key], onChange: (event) => set(key, event.target.value) });

      /** Run one action; leave the form when the host accepted it. */
      async function run(path, body) {
        setError(null);
        if (await store.act(path, body)) onDone();
      }

      function save(event) {
        event.preventDefault();
        const { patch, error: invalid } = buildPatch(form, config, wizard);
        if (invalid) setError(invalid);
        else run("config", patch);
      }

      return h(
        "form",
        { onSubmit: save, style: { paddingRight: 32 } },
        wizard ? h("div", { style: { ...MUTED, marginBottom: 12 } }, t("cfgWizardIntro")) : null,
        h(IdentitySection, { bind, wizard, config }),
        h(NetworkSection, { form, set, bind, config, busy }),
        h(AdvancedSection, { bind }),
        (error ?? actionError)
          ? h(
              "div",
              { style: { ...HINT, color: "var(--dsw-alias-state-error-primary)", marginBottom: 8 } },
              error ?? actionError,
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
          h(Button, { type: "submit", style: PRIMARY, disabled: busy }, wizard ? t("cfgStart") : t("cfgSave")),
          wizard && config.running
            ? h(Button, { disabled: busy, onClick: () => run("config", {}) }, t("cfgUseExisting"))
            : null,
          wizard ? null : h(Button, { onClick: onDone }, t("cfgBack")),
          h("div", { style: { flex: 1 } }),
          h(
            "span",
            { style: { ...MUTED, fontSize: 11 } },
            config.running ? t("cfgRunning") + config.port : t("cfgNotRunning"),
          ),
        ),
        wizard
          ? null
          : h(
              "div",
              { style: { marginTop: 20, paddingTop: 14, borderTop: BORDER } },
              h("div", { style: { ...HINT, marginBottom: 8 } }, t("cfgResetIntro")),
              h(
                Button,
                { style: DANGER, disabled: busy, onClick: () => (resetArmed ? run("reset", {}) : setResetArmed(true)) },
                resetArmed ? t("cfgResetConfirm") : t("cfgReset"),
              ),
            ),
      );
    }

    /* ===== 9. panel ======================================================== */

    function StatusPage({ snap, onOpenSettings }) {
      const { state, busy } = snap;
      const { self, config, members, mesh, approvals, recent, workspace } = state;
      const [connectOpen, setConnectOpen] = React.useState(false);
      const [host, setHost] = React.useState("");
      const [task, setTask] = React.useState(null);
      const [node, setNode] = React.useState(null);
      const [allOpen, setAllOpen] = React.useState(false);
      // The header button reflects the live mesh, not the remembered peer list.
      const joined = mesh.reachable > 0;
      const error = snap.error ?? snap.actionError ?? config.error;
      const cancel = (row) => store.act("cancel", { peer: row.peer, task_id: row.id });

      async function connect() {
        if (await store.act("connect", { peer: host.trim() })) {
          setConnectOpen(false);
          setHost("");
        }
      }

      return h(
        "div",
        null,
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12, paddingRight: 26 } },
          h("div", { style: TITLE }, t("nav")),
          h("div", { style: { flex: 1 } }),
          joined
            ? h(Button, { disabled: busy, onClick: () => store.act("disconnect", {}) }, t("disconnect"))
            : h(
                Button,
                { style: PRIMARY, disabled: busy, onClick: () => setConnectOpen(!connectOpen) },
                connectOpen ? t("cancel") : t("connect"),
              ),
          h(
            Button,
            { style: ICON_BUTTON, title: t("settings"), "aria-label": t("settings"), onClick: onOpenSettings },
            "⚙",
          ),
        ),
        h(
          "div",
          { style: { ...MUTED, marginTop: 2 }, title: self ? self.orca_node_id : undefined },
          `${self ? self.display_name : t("nodeNotRunning")} @ ${config.workgroup_id || "-"}`,
        ),
        self?.busy
          ? h(
              "div",
              { style: { ...MUTED, marginTop: 2, color: "var(--dsw-alias-brand-primary)" }, title: self.busy.task_id },
              `${t("busy")} · ${short(self.busy.task_id)} · ${t("busyOrigin")}${self.busy_from}`,
            )
          : null,
        error ? h("div", { style: { ...ERROR, marginTop: 8 } }, error) : null,
        joined ? null : h("div", { style: { ...MUTED, marginTop: 6 } }, t("notJoined")),
        !joined && connectOpen
          ? h(
              "div",
              { style: SECTION },
              h("div", { style: H2 }, t("connectPeer")),
              h(
                Field,
                { label: t("host") },
                h("input", {
                  style: INPUT,
                  value: host,
                  onChange: (event) => setHost(event.target.value),
                  placeholder: "192.168.1.12 / peer.example.com / http://host:11811",
                }),
              ),
              h(
                "div",
                { style: { display: "flex", gap: 8 } },
                h(Button, { style: PRIMARY, disabled: busy || host.trim() === "", onClick: connect }, t("connect")),
                h(Button, { disabled: busy, onClick: () => setConnectOpen(false) }, t("cancel")),
              ),
            )
          : null,
        h(Section, { title: t("pendingApprovals") }, h(ApprovalList, { approvals, busy })),
        h(
          Section,
          { title: t("recentTasks"), action: h(Button, { onClick: () => setAllOpen(true) }, t("allTasks")) },
          h(TaskTable, { rows: recent, showArtifacts: false, busy, onOpen: setTask, onCancel: cancel }),
        ),
        h(Section, { title: t("members") }, h(Members, { members, onOpen: setNode })),
        h(Section, { title: t("workspace") }, h(Workspace, { workspace })),
        h(Updated),
        allOpen ? h(AllTasks, { onOpen: setTask, onClose: () => setAllOpen(false) }) : null,
        task ? h(TaskDetail, { peer: task.peer, taskId: task.id, onClose: () => setTask(null) }) : null,
        node ? h(NodeDetail, { member: node, onClose: () => setNode(null) }) : null,
      );
    }

    /** The panel body: first-run wizard, status page or settings form. */
    function Panel() {
      useLocale();
      const snap = useStore();
      const [view, setView] = React.useState("status");
      if (snap.state === null)
        return h(
          "div",
          { style: { padding: "4px 0", ...MUTED } },
          snap.error ? `orca-pod: ${snap.error}` : t("connecting"),
        );
      const { config } = snap.state;
      const toStatus = () => setView("status");
      let content = h(StatusPage, { snap, onOpenSettings: () => setView("settings") });
      if (!config.configured) content = h(ConfigForm, { key: "wizard", config, wizard: true, onDone: toStatus });
      else if (view === "settings") content = h(ConfigForm, { key: "settings", config, onDone: toStatus });
      return h("div", { style: { minWidth: 0 } }, content);
    }

    /** Sidebar-foot status light: green with reachable peers, amber while a decision waits. */
    function SidebarAction({ wide }) {
      useLocale();
      const { state, panelOpen } = useStore();
      const pending = state === null ? 0 : state.approval_count;
      const reachable = state === null ? 0 : state.mesh.reachable;
      const color =
        pending > 0
          ? "var(--dsw-alias-state-warn-primary)"
          : reachable > 0
            ? "var(--dsw-alias-state-success-primary)"
            : "var(--dsw-alias-label-secondary)";
      return h(
        Button,
        {
          style: { ...FOOTER_ACTION, color },
          title: pending > 0 ? `${t("nav")} · ${pending} ${t("pendingApprovals")}` : t("nav"),
          onClick: () => store.setPanelOpen(!panelOpen),
        },
        h("span", { style: { fontSize: 16, lineHeight: 1 } }, "◈"),
        wide === false ? null : h("span", null, t("nav")),
      );
    }

    function OverlayPanel() {
      useLocale();
      const { panelOpen } = useStore();
      return panelOpen ? h(Modal, { label: t("nav"), onClose: () => store.setPanelOpen(false) }, h(Panel)) : null;
    }

    /* ===== 10. slots ======================================================= */

    /** Register a settings page, a sidebar entry, the floating panel and the approval cards. */
    function apply(ctx) {
      store.locale = ctx.locale;
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({ name: "settings.section", id: NS, order: 60, label: () => t("nav") }, Panel),
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: NS, order: 10, label: () => t("nav") }, SidebarAction),
      );
      ctx.slots.inject("shell.overlay", () => {
        ctx.slots.register({ name: "shell.overlay", id: `${NS}.panel`, order: 60 }, OverlayPanel);
        ctx.slots.register({ name: "shell.overlay", id: `${NS}.approval-popup`, order: 61 }, ApprovalPopup);
      });
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register({ name: "conversation.input.dock", id: `${NS}.approval-dock`, order: 60 }, ApprovalDock),
      );
    }

    return { inject: ["slots", "locale"], apply };
  },
});
