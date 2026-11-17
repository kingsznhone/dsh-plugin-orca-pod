/**
 * The subset of DSH's shared UI primitives this panel uses.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is a baseline entry of the shell's
 * platform module table, so a client bundle requires it at runtime like
 * `react`; DSH publishes no typings for it, so the props below are written
 * from the shell's own call sites (DSH 0.2.x). Keep this list to what the
 * panel actually renders.
 */

declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type {
    ButtonHTMLAttributes,
    ForwardRefExoticComponent,
    InputHTMLAttributes,
    KeyboardEvent,
    ReactElement,
    ReactNode,
    RefAttributes,
  } from "react";

  export type ButtonVariant = "primary" | "outline" | "ghost" | "toolbar";

  /** `<button>` with DSH's variants; `icon` sits before the label. Defaults: ghost, md. */
  export const Button: ForwardRefExoticComponent<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: ButtonVariant;
      size?: "md" | "sm";
      icon?: ReactNode;
    } & RefAttributes<HTMLButtonElement>
  >;

  /** `<input>` in DSH's field frame; `className` styles the frame, every other prop goes to the input. */
  export const Input: ForwardRefExoticComponent<
    InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode } & RefAttributes<HTMLInputElement>
  >;

  export type TagTone = "outline" | "solid" | "neutral" | "quiet" | "success" | "info" | "warning" | "danger";

  /** Small rounded label. Default tone: outline. */
  export function Tag(props: { tone?: TagTone; className?: string; children?: ReactNode }): ReactElement;

  export type DotState = "ongoing" | "done" | "warning" | "error" | "idle";

  /** Status dot; `ongoing` draws a spinner. */
  export function StateDot(props: { state: DotState; size?: number; className?: string }): ReactElement;

  /** Portal dialog with DSH's mask, Escape handling and modal layering. */
  export function Modal(props: {
    open: boolean;
    onClose: () => void;
    title: string;
    closeLabel: string;
    description?: string;
    children?: ReactNode;
    footer?: ReactNode;
    className?: string;
    contentClassName?: string;
    onKeyDownCapture?: (event: KeyboardEvent) => void;
    tone?: "warning";
  }): ReactElement | null;

  /** Hover/focus label for one focusable child. */
  export function Tooltip(props: {
    label: string | (() => string);
    side?: "top" | "bottom" | "left" | "right";
    align?: "start" | "center" | "end";
    delayMs?: number;
    portal?: boolean;
    maxWidth?: number;
    disabled?: boolean;
    children: ReactElement;
  }): ReactElement;

  export type Icon = (props: { size?: number; className?: string }) => ReactElement;

  export const IconChevronDownOutlineRegular: Icon;
  export const IconChevronRightOutlineRegular: Icon;
  export const IconCloseOutlineRegular: Icon;
  export const IconPlusOutlineRegular: Icon;
  export const IconSettingsOutlineRegular: Icon;
  export const IconUsersOutlineRegular: Icon;
  export const IconWarningOutlineRegular: Icon;
}

/** CSS modules: the build scopes every class and maps the source name to the scoped one. */
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
