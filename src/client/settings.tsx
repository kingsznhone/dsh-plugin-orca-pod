/** The settings form: first-run wizard and later edits; identity, network, advanced and reset groups. */

import {
  Button,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  Input,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React, { type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { DEFAULT_PORT } from "../core/constants.ts";
import { DEFAULT_WORKGROUP, GIB } from "./constants.ts";
import { t } from "./i18n.ts";
import panel from "./panel.module.css";
import css from "./settings.module.css";
import { store, useStore } from "./store.ts";
import type { PanelPatch, PodActions, PodConfigView, PodPeer } from "./types.ts";
import ui from "./ui.module.css";

/** The settings the panel shows. */
type ShownSettings = PodConfigView["settings"];

/** Advanced settings edited as numbers. */
type LimitKey = "task_timeout_s" | "max_workspace_bytes";

/** Advanced settings edited as a choice. */
type SelectKey = "permission_mode" | "default_reasoning_effort";

interface Limit {
  key: LimitKey;
  label: string;
  hint?: string;
  /** Bytes per displayed unit (currently only GiB); unset means the value is shown as stored. */
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

/** Numeric limits; `unit` converts the displayed GiB to the bytes the host stores. */
const LIMITS: Limit[] = [
  { key: "task_timeout_s", label: "cfgTaskTimeout", hint: "cfgTaskTimeoutHint" },
  { key: "max_workspace_bytes", label: "cfgMaxWorkspaceGiB", hint: "cfgMaxWorkspaceHint", unit: GIB },
];

/** What the choices are built from: the host's mode list, its default model's efforts, the current values. */
type ChoiceSource = Pick<PodConfigView, "permission_modes" | "reasoning_efforts" | "settings">;

function selectFields(config: ChoiceSource): SelectField[] {
  const literal = (values: readonly string[]): Array<[string, string]> => [
    ["", t("cfgDefaultOption")],
    ...values.map((value): [string, string] => [value, value]),
  ];
  // The efforts belong to the host's default model; a saved effort it no longer offers stays selectable.
  const saved = config.settings.default_reasoning_effort;
  const efforts: Array<[string, string]> = config.reasoning_efforts.map(({ id, name }) => [id, name]);
  if (saved !== undefined && !efforts.some(([id]) => id === saved)) efforts.push([saved, saved]);
  return [
    ["permission_mode", "cfgPermissionMode", literal(config.permission_modes)],
    ["default_reasoning_effort", "cfgDefaultEffort", [["", t("cfgDefaultOption")], ...efforts], "cfgDefaultEffortHint"],
  ];
}

const unitText = (value: number | undefined, unit = 1): string =>
  value === undefined ? "" : String(+(value / unit).toFixed(3));

/** The numeric limits as form text, in their display units (GiB for the workspace limit, plain seconds for the timeout); unset is blank. */
function limitTexts(settings: ShownSettings): Record<LimitKey, string> {
  return Object.fromEntries(LIMITS.map(({ key, unit }) => [key, unitText(settings[key], unit)])) as Record<
    LimitKey,
    string
  >;
}

/** The choices as form text; unset is blank. */
function choiceTexts(config: ChoiceSource): Record<SelectKey, string> {
  const { settings } = config;
  return Object.fromEntries(selectFields(config).map(([key]) => [key, String(settings[key] ?? "")])) as Record<
    SelectKey,
    string
  >;
}

function initialForm(config: PodConfigView, self: PodPeer | null): FormState {
  return {
    workgroup_id: config.settings.workgroup_id ?? DEFAULT_WORKGROUP,
    password: "",
    /* The name the running node goes by (its shortened id unless one was set), else the setting. */
    display_name: self?.display_name ?? config.settings.display_name ?? "",
    bind_host: config.settings.bind_host,
    port: String(config.port),
    endpoints: config.suggested_endpoints.length > 0 ? config.suggested_endpoints : [""],
    ...limitTexts(config.settings),
    ...choiceTexts(config),
  };
}

type LimitValues = Partial<Record<LimitKey, number | null>>;

/** The numeric limits as the host takes them (blank clears); `{ error }` names the first one that is not a valid number. */
function limitValues(
  form: FormState,
  config: PodConfigView,
): { values: LimitValues; error?: undefined } | { error: string; values?: undefined } {
  const values: LimitValues = {};
  for (const { key, label, unit } of LIMITS) {
    const text = form[key].trim();
    const value = Number(text);
    if (text === "") {
      values[key] = null;
    } else if (!Number.isFinite(value) || value <= 0) {
      return { error: `${t(label)} ${t("cfgAdvancedInvalid")}` };
    } else if (unit === undefined) {
      values[key] = value;
    } else {
      /* An untouched field keeps its exact byte count instead of the rounded display. */
      const original = config.settings[key];
      values[key] = original !== undefined && text === unitText(original, unit) ? original : Math.round(value * unit);
    }
  }
  return { values };
}

/** The choices as the host takes them; blank clears. */
function choiceValues(form: FormState, config: ChoiceSource): Partial<Record<SelectKey, string | null>> {
  const values: Partial<Record<SelectKey, string | null>> = {};
  for (const [key] of selectFields(config)) {
    values[key] = form[key] || null;
  }
  return values;
}

/** Form text to the patch the host validates; `null` clears a field. Returns `{ error }` for input it cannot convert. */
function buildPatch(
  form: FormState,
  config: PodConfigView,
  wizard: boolean,
): { patch: PanelPatch; error?: undefined } | { error: string; patch?: undefined } {
  const port = Number(form.port);
  if (form.port.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535)
    return { error: `${t("cfgListenPort")} ${t("cfgPortInvalid")}` };
  if (form.password.length === 0 && wizard) return { error: t("cfgPasswordRequired") };
  const addresses = form.endpoints.map((row) => row.trim()).filter(Boolean);
  const limits = limitValues(form, config);
  if (limits.error !== undefined) return { error: limits.error };
  // The choices here are the <select> values (`permission_mode`, `default_reasoning_effort`); the host checks them against the settings schemas.
  const patch = {
    workgroup_id: form.workgroup_id.trim().toLowerCase(),
    display_name: form.display_name.trim() || null,
    bind_host: form.bind_host,
    port,
    endpoints: addresses.length > 0 ? addresses : null,
    ...(form.password.length > 0 ? { workgroup_password: form.password } : {}),
    ...limits.values,
    ...choiceValues(form, config),
  } as PanelPatch;
  return { patch };
}

/** One settings row: label and hint on the left, the control on the right (a `<label>`, or a `role="group"` div when the caller passes `group`). */
function SettingRow({
  label,
  hint,
  group,
  stacked,
  width = "wide",
  children,
}: {
  label: string;
  hint?: string | null;
  group?: boolean;
  stacked?: boolean;
  width?: "wide" | "narrow" | "auto";
  children?: ReactNode;
}) {
  const className = stacked ? `${css.row} ${css.stacked}` : css.row;
  const control = width === "narrow" ? css.controlNarrow : width === "auto" ? css.controlAuto : css.control;
  const text = (
    <span className={css.rowText}>
      <span className={css.rowLabel}>{label}</span>
      {hint ? <span className={css.rowHint}>{hint}</span> : null}
    </span>
  );
  return group ? (
    // biome-ignore lint/a11y/useSemanticElements: a settings row, not a form section; <fieldset> would bring its own frame.
    <div className={className} role={"group"} aria-label={label}>
      {text}
      <div className={control}>{children}</div>
    </div>
  ) : (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as `children`, inside this label.
    <label className={className}>
      {text}
      <span className={control}>{children}</span>
    </label>
  );
}

/** A titled card of settings rows. */
function Group({ title, danger, children }: { title: string; danger?: boolean; children?: ReactNode }) {
  return (
    <section className={css.group}>
      <h3 className={css.groupTitle}>{title}</h3>
      <div className={danger ? `${css.groupCard} ${css.dangerCard}` : css.groupCard}>{children}</div>
    </section>
  );
}

/** Native `<select>` in DSH's field frame; a saved value the list does not know stays selectable. */
function Select({ options, ...props }: ReturnType<Bind> & { options: Array<[string, string]> }) {
  const known = options.some(([value]) => value === props.value);
  const shown = known ? options : [...options, [props.value, props.value] as [string, string]];
  return (
    <span className={css.selectWrap}>
      <select className={css.select} {...props}>
        {shown.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      <IconChevronDownOutlineRegular size={14} className={css.selectChevron} />
    </span>
  );
}

function IdentitySection({ bind, wizard }: { bind: Bind; wizard: boolean }) {
  const placeholder = wizard ? t("cfgPasswordOpen") : t("cfgPasswordKeep");
  const hint = wizard ? t("cfgPasswordHintWizard") : t("cfgPasswordHintSet");
  return (
    <Group title={t("cfgIdentity")}>
      <SettingRow label={t("cfgWorkgroupId")} hint={t("cfgWorkgroupIdHint")}>
        <Input className={css.input} placeholder={DEFAULT_WORKGROUP} {...bind("workgroup_id")} />
      </SettingRow>
      <SettingRow label={t("cfgPassword")} hint={hint}>
        <Input className={css.input} type={"password"} placeholder={placeholder} {...bind("password")} />
      </SettingRow>
      <SettingRow label={t("cfgDisplayName")}>
        <Input className={css.input} placeholder={t("cfgDisplayNamePlaceholder")} {...bind("display_name")} />
      </SettingRow>
    </Group>
  );
}

function NetworkSection({
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
  const hosts = config.bind_choices.map((host): [string, string] => [host, bindLabel(host)]);
  return (
    <Group title={t("cfgNetwork")}>
      <SettingRow label={t("cfgListenAddress")} hint={t("cfgListenAddressHint")}>
        <Select options={hosts} {...bind("bind_host")} />
      </SettingRow>
      <SettingRow label={t("cfgListenPort")} width={"narrow"}>
        <Input className={css.input} inputMode={"numeric"} {...bind("port")} />
      </SettingRow>
      <SettingRow group={true} stacked={true} label={t("cfgAdvertised")} hint={t("cfgEndpointHint")}>
        <div className={css.endpoints}>
          {rows.map((row, index) => (
            <div key={index} className={css.endpoint}>
              <Input
                className={`${css.input} ${css.monoInput}`}
                value={row}
                aria-label={`${t("cfgAdvertised")} ${index + 1}`}
                onChange={(event) => edit(index, event.target.value)}
                placeholder={`https://192.168.1.11:${DEFAULT_PORT}`}
              />
              <Button
                variant={"ghost"}
                className={ui.iconButton}
                title={t("cfgRemove")}
                aria-label={t("cfgRemove")}
                disabled={busy}
                icon={<IconCloseOutlineRegular size={14} />}
                onClick={() => remove(index)}
              />
            </div>
          ))}
          <Button
            variant={"ghost"}
            size={"sm"}
            className={css.addEndpoint}
            disabled={busy}
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={() => set("endpoints", [...rows, ""])}
          >
            {t("cfgAddEndpoint")}
          </Button>
        </div>
      </SettingRow>
    </Group>
  );
}

function AdvancedSection({ bind, config }: { bind: Bind; config: ChoiceSource }) {
  const [open, setOpen] = React.useState(false);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={css.summary}>
        <span className={css.groupTitle}>{t("cfgAdvanced")}</span>
        <IconChevronDownOutlineRegular size={14} className={css.summaryChevron} />
      </summary>
      <div className={css.advancedBody}>
        <p className={css.groupHint}>{t("cfgAdvancedHint")}</p>
        <div className={css.groupCard}>
          {LIMITS.map((limit) => (
            <SettingRow key={limit.key} label={t(limit.label)} hint={limit.hint && t(limit.hint)} width={"narrow"}>
              <Input className={css.input} inputMode={"decimal"} {...bind(limit.key)} />
            </SettingRow>
          ))}
          {selectFields(config).map(([key, label, options, hint]) => (
            <SettingRow key={key} label={t(label)} hint={hint && t(hint)}>
              <Select options={options} {...bind(key)} />
            </SettingRow>
          ))}
        </div>
      </div>
    </details>
  );
}

/** Lays out a view: its body, and the footer that stays visible under it. */
export type Frame = (body: ReactNode, footer: ReactNode) => ReactNode;

/** The form's state and actions, apart from how it is drawn. */
function useConfigForm(config: PodConfigView, self: PodPeer | null, wizard: boolean, onDone: () => void) {
  const { busy, actionError } = useStore();
  const [form, setForm] = React.useState(() => initialForm(config, self));
  const [error, setError] = React.useState<string | null>(null);
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
  return { form, set, bind, busy, problem: error ?? actionError, run, save };
}

/** Full reset, behind a second click. */
function ResetGroup({ busy, onReset }: { busy: boolean; onReset: () => void }) {
  const [armed, setArmed] = React.useState(false);
  return (
    <Group title={t("cfgDanger")} danger={true}>
      <SettingRow group={true} label={t("cfgReset")} hint={t("cfgResetIntro")} width={"auto"}>
        <Button
          variant={"outline"}
          className={ui.danger}
          disabled={busy}
          onClick={() => (armed ? onReset() : setArmed(true))}
        >
          {armed ? t("cfgResetConfirm") : t("cfgResetAction")}
        </Button>
      </SettingRow>
    </Group>
  );
}

/** Node status (or the last error) on the left; back and save on the right. */
function ConfigFooter({
  config,
  running,
  wizard,
  formId,
  busy,
  problem,
  onBack,
}: {
  config: PodConfigView;
  running: boolean;
  wizard: boolean;
  formId: string;
  busy: boolean;
  problem: string | null;
  onBack: () => void;
}) {
  return (
    <div className={panel.footer}>
      <span className={panel.footerStatus}>
        {problem ? (
          <span className={ui.error} role={"alert"}>
            {problem}
          </span>
        ) : (
          <>
            <StateDot state={running ? "done" : "idle"} />
            {running ? t("cfgRunning") + config.port : t("cfgNotRunning")}
          </>
        )}
      </span>
      {wizard ? null : (
        <Button variant={"outline"} onClick={onBack}>
          {t("cfgBack")}
        </Button>
      )}
      <Button variant={"primary"} type={"submit"} form={formId} disabled={busy}>
        {wizard ? t("cfgStart") : t("cfgSave")}
      </Button>
    </div>
  );
}

export function ConfigForm({
  config,
  self,
  wizard,
  onDone,
  frame,
}: {
  config: PodConfigView;
  /** This node's own record while it runs. */
  self: PodPeer | null;
  wizard: boolean;
  onDone: () => void;
  frame: Frame;
}): ReactNode {
  const formId = React.useId();
  const { form, set, bind, busy, problem, run, save } = useConfigForm(config, self, wizard, onDone);
  const body = (
    <form id={formId} onSubmit={save} className={css.form}>
      {wizard ? <p className={css.intro}>{t("cfgWizardIntro")}</p> : null}
      <IdentitySection bind={bind} wizard={wizard} />
      <NetworkSection form={form} set={set} bind={bind} config={config} busy={busy} />
      <AdvancedSection bind={bind} config={config} />
      {wizard ? null : <ResetGroup busy={busy} onReset={() => run("reset", {})} />}
    </form>
  );
  const footer = (
    <ConfigFooter
      config={config}
      running={self !== null}
      wizard={wizard}
      formId={formId}
      busy={busy}
      problem={problem}
      onBack={onDone}
    />
  );
  return frame(body, footer);
}
