/** The settings form: first-run wizard and later edits, identity, network and advanced sections. */

import React, { type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { DEFAULT_WORKGROUP, GIB, MIB } from "./constants.ts";
import { t } from "./i18n.ts";
import { Button, Field } from "./primitives.tsx";
import { store, useStore } from "./store.ts";
import { BORDER, DANGER, HINT, INPUT, MONO_FONT, MUTED, PRIMARY } from "./styles.ts";
import type { PanelPatch, PodActions, PodAdvancedConfig, PodConfigView } from "./types.ts";

/** Advanced settings edited as numbers: the ones the host reports as a number. */
type LimitKey = {
  [K in keyof PodAdvancedConfig]: PodAdvancedConfig[K] extends number | null ? K : never;
}[keyof PodAdvancedConfig];

/** Advanced settings edited as a choice: the rest. */
type SelectKey = Exclude<keyof PodAdvancedConfig, LimitKey>;

interface Limit {
  key: LimitKey;
  label: string;
  hint?: string;
  integer?: boolean;
  /** Bytes per displayed unit (MiB/GiB); unset means the value is shown as stored. */
  unit?: number;
}

/** `[setting, label key, [value, text] options, hint key]`. */
type SelectField = [SelectKey, string, Array<[string, string]>, string?];

/** The form's text state: every field as the user typed it. */
type FormState = {
  workgroup_id: string;
  password: string;
  display_name: string;
  bind_host: string;
  port: string;
  endpoints: string[];
} & Record<LimitKey | SelectKey, string>;

type TextKey = Exclude<keyof FormState, "endpoints">;

/** Props an `<input>`/`<select>` needs to edit one text field. */
type Bind = (key: TextKey) => {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
};

/** Numeric limits; `unit` converts the displayed MiB/GiB to the bytes the host stores. */
export const LIMITS: Limit[] = [
  { key: "task_timeout_s", label: "cfgTaskTimeout", hint: "cfgTaskTimeoutHint" },
  { key: "approval_timeout_s", label: "cfgApprovalTimeout", hint: "cfgApprovalTimeoutHint" },
  { key: "result_max_bytes", label: "cfgResultMaxBytes", integer: true },
  { key: "max_input_files", label: "cfgMaxInputFiles", integer: true },
  { key: "max_input_bytes", label: "cfgMaxInputMiB", unit: MIB },
  { key: "max_workspace_bytes", label: "cfgMaxWorkspaceGiB", hint: "cfgMaxWorkspaceHint", unit: GIB },
  { key: "max_workspace_files", label: "cfgMaxWorkspaceFiles", integer: true },
  { key: "max_blob_store_bytes", label: "cfgMaxBlobGiB", hint: "cfgMaxBlobHint", unit: GIB },
];
export const BOOLEANS: SelectKey[] = ["allow_public_peers", "allow_loopback_peers"];

export function selectFields(): SelectField[] {
  const tri: Array<[string, string]> = [
    ["", t("cfgDefaultOption")],
    ["allow", t("cfgAllowOption")],
    ["deny", t("cfgDenyOption")],
  ];
  const literal = (...values: string[]): Array<[string, string]> => [
    ["", t("cfgDefaultOption")],
    ...values.map((value): [string, string] => [value, value]),
  ];
  return [
    ["permission_mode", "cfgPermissionMode", literal("read-only", "workspace-write", "danger-full-access")],
    ["allow_public_peers", "cfgAllowPublicPeers", tri],
    ["allow_loopback_peers", "cfgAllowLoopbackPeers", tri],
    ["default_reasoning_effort", "cfgDefaultEffort", literal("off", "low", "high", "max"), "cfgDefaultEffortHint"],
    ["executor", "cfgExecutor", literal("acp", "echo"), "cfgExecutorHint"],
  ];
}

export const unitText = (value: number | null, unit = 1): string =>
  value === null ? "" : String(+(value / unit).toFixed(3));

export function initialForm(config: PodConfigView, wizard: boolean): FormState {
  const { advanced } = config;
  const form = {
    workgroup_id: config.workgroup_id || DEFAULT_WORKGROUP,
    password: "",
    /* The first run starts from this node's own id; a configured install keeps its saved name. */
    display_name: (wizard ? config.node_id : config.display_name) ?? "",
    bind_host: config.bind_host,
    port: String(config.port),
    endpoints: config.suggested_endpoints.length > 0 ? config.suggested_endpoints : [""],
  } as FormState;
  for (const limit of LIMITS) form[limit.key] = unitText(advanced[limit.key], limit.unit);
  for (const [key] of selectFields()) {
    const value: PodAdvancedConfig[SelectKey] = advanced[key];
    form[key] = BOOLEANS.includes(key) ? (value === null ? "" : value ? "allow" : "deny") : String(value ?? "");
  }
  return form;
}

type LimitValues = Partial<Record<LimitKey, number | null>>;

/** The numeric limits as the host takes them (blank clears); `{ error }` names the first one that is not a valid number. */
function limitValues(
  form: FormState,
  config: PodConfigView,
): { values: LimitValues; error?: undefined } | { error: string; values?: undefined } {
  const values: LimitValues = {};
  for (const { key, label, integer, unit } of LIMITS) {
    const text = form[key].trim();
    const value = Number(text);
    if (text === "") {
      values[key] = null;
    } else if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
      return { error: `${t(label)} ${t("cfgAdvancedInvalid")}` };
    } else if (unit === undefined) {
      values[key] = value;
    } else {
      /* An untouched field keeps its exact byte count instead of the rounded display. */
      const original = config.advanced[key];
      values[key] = text === unitText(original, unit) ? original : Math.round(value * unit);
    }
  }
  return { values };
}

/** The choices as the host takes them: allow/deny become booleans, blank clears. */
function choiceValues(form: FormState): Partial<Record<SelectKey, string | boolean | null>> {
  const values: Partial<Record<SelectKey, string | boolean | null>> = {};
  for (const [key] of selectFields()) {
    values[key] = BOOLEANS.includes(key) ? (form[key] === "" ? null : form[key] === "allow") : form[key] || null;
  }
  return values;
}

/** Form text to the patch the host validates; `null` clears a field. Returns `{ error }` for input it cannot convert. */
export function buildPatch(
  form: FormState,
  config: PodConfigView,
  wizard: boolean,
): { patch: PanelPatch; error?: undefined } | { error: string; patch?: undefined } {
  const port = Number(form.port);
  if (form.port.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535)
    return { error: `${t("cfgListenPort")} ${t("cfgPortInvalid")}` };
  if (form.password.length === 0 && (wizard || !config.password_set)) return { error: t("cfgPasswordRequired") };
  const addresses = form.endpoints.map((row) => row.trim()).filter(Boolean);
  const limits = limitValues(form, config);
  if (limits.error !== undefined) return { error: limits.error };
  // The choices are free text here (`allow`/`deny`, a mode name); the host checks them against the settings schemas.
  const patch = {
    workgroup_id: form.workgroup_id.trim().toLowerCase(),
    display_name: form.display_name.trim() || null,
    bind_host: form.bind_host,
    port,
    endpoints: addresses.length > 0 ? addresses : null,
    ...(form.password.length > 0 ? { workgroup_password: form.password } : {}),
    ...limits.values,
    ...choiceValues(form),
  } as PanelPatch;
  return { patch };
}

export function IdentitySection({ bind, wizard, config }: { bind: Bind; wizard: boolean; config: PodConfigView }) {
  const placeholder = wizard || !config.password_set ? t("cfgPasswordOpen") : t("cfgPasswordKeep");
  const hint = wizard
    ? t("cfgPasswordHintWizard")
    : config.password_set
      ? t("cfgPasswordHintSet")
      : t("cfgPasswordHintNone");
  return (
    <>
      <Field label={t("cfgWorkgroupId")} hint={t("cfgWorkgroupIdHint")}>
        <input style={INPUT} placeholder={DEFAULT_WORKGROUP} {...bind("workgroup_id")} />
      </Field>
      <Field label={t("cfgPassword")} hint={hint}>
        <input style={INPUT} type={"password"} placeholder={placeholder} {...bind("password")} />
      </Field>
      <Field label={t("cfgDisplayName")}>
        <input style={INPUT} placeholder={t("cfgDisplayNamePlaceholder")} {...bind("display_name")} />
      </Field>
    </>
  );
}

export function NetworkSection({
  form,
  set,
  bind,
  config,
  busy,
}: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  bind: Bind;
  config: PodConfigView;
  busy: boolean;
}) {
  const rows = form.endpoints;
  const edit = (index: number, value: string) =>
    set(
      "endpoints",
      rows.map((row, i) => (i === index ? value : row)),
    );
  const remove = (index: number) => set("endpoints", rows.length === 1 ? [""] : rows.filter((_, i) => i !== index));
  const bindLabel = (host: string) =>
    host === "127.0.0.1" ? t("cfgListenLoopback") : host === "::" ? t("cfgListenAll") : host;
  return (
    <>
      <Field label={t("cfgListenAddress")} hint={t("cfgListenAddressHint")}>
        <select style={INPUT} {...bind("bind_host")}>
          {config.bind_choices.map((host) => (
            <option key={host} value={host}>
              {bindLabel(host)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("cfgListenPort")}>
        <input style={INPUT} inputMode={"numeric"} {...bind("port")} />
      </Field>
      <Field group={true} label={t("cfgAdvertised")} hint={t("cfgEndpointHint")}>
        {rows.map((row, index) => (
          <div key={index} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              style={{ ...INPUT, flex: 1, fontFamily: MONO_FONT }}
              value={row}
              onChange={(event) => edit(index, event.target.value)}
              placeholder={"http://192.168.1.11:11811"}
            />
            <Button disabled={busy} onClick={() => remove(index)}>
              {t("cfgRemove")}
            </Button>
          </div>
        ))}
        <Button disabled={busy} onClick={() => set("endpoints", [...rows, ""])}>
          {t("cfgAddEndpoint")}
        </Button>
      </Field>
    </>
  );
}

export function AdvancedSection({ bind }: { bind: Bind }) {
  const [open, setOpen] = React.useState(false);
  return (
    <details
      style={{ marginTop: 6, marginBottom: 14 }}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>
        {t("cfgAdvanced")}
      </summary>
      <div style={{ ...HINT, marginBottom: 10 }}>{t("cfgAdvancedHint")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12 }}>
        {LIMITS.map((limit) => (
          <Field key={limit.key} label={t(limit.label)} hint={limit.hint && t(limit.hint)}>
            <input style={INPUT} inputMode={"decimal"} {...bind(limit.key)} />
          </Field>
        ))}
        {selectFields().map(([key, label, options, hint]) => (
          <Field key={key} label={t(label)} hint={hint && t(hint)}>
            <select style={INPUT} {...bind(key)}>
              {options.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
    </details>
  );
}

export function ConfigForm({
  config,
  wizard,
  onDone,
}: {
  config: PodConfigView;
  wizard: boolean;
  onDone: () => void;
}): ReactNode {
  const { busy, actionError } = useStore();
  const [form, setForm] = React.useState(() => initialForm(config, wizard));
  const [error, setError] = React.useState<string | null>(null);
  const [resetArmed, setResetArmed] = React.useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const bind: Bind = (key) => ({ value: form[key], onChange: (event) => set(key, event.target.value) });
  /** Run one action; leave the form when the host accepted it. */
  async function run<K extends keyof PodActions>(path: K, body: PodActions[K]) {
    setError(null);
    if (await store.act(path, body)) onDone();
  }
  function save(event: FormEvent) {
    event.preventDefault();
    const { patch, error: invalid } = buildPatch(form, config, wizard);
    if (invalid !== undefined) setError(invalid);
    else void run("config", patch);
  }
  return (
    <form onSubmit={save} style={{ paddingRight: 32 }}>
      {wizard ? <div style={{ ...MUTED, marginBottom: 12 }}>{t("cfgWizardIntro")}</div> : null}
      <IdentitySection bind={bind} wizard={wizard} config={config} />
      <NetworkSection form={form} set={set} bind={bind} config={config} busy={busy} />
      <AdvancedSection bind={bind} />
      {(error ?? actionError) ? (
        <div style={{ ...HINT, color: "var(--dsw-alias-state-error-primary)", marginBottom: 8 }}>
          {error ?? actionError}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <Button type={"submit"} style={PRIMARY} disabled={busy}>
          {wizard ? t("cfgStart") : t("cfgSave")}
        </Button>
        {wizard && config.running ? (
          <Button disabled={busy} onClick={() => run("config", {})}>
            {t("cfgUseExisting")}
          </Button>
        ) : null}
        {wizard ? null : <Button onClick={onDone}>{t("cfgBack")}</Button>}
        <div style={{ flex: 1 }} />
        <span style={{ ...MUTED, fontSize: 11 }}>
          {config.running ? t("cfgRunning") + config.port : t("cfgNotRunning")}
        </span>
      </div>
      {wizard ? null : (
        <div style={{ marginTop: 20, paddingTop: 14, borderTop: BORDER }}>
          <div style={{ ...HINT, marginBottom: 8 }}>{t("cfgResetIntro")}</div>
          <Button style={DANGER} disabled={busy} onClick={() => (resetArmed ? run("reset", {}) : setResetArmed(true))}>
            {resetArmed ? t("cfgResetConfirm") : t("cfgReset")}
          </Button>
        </div>
      )}
    </form>
  );
}
