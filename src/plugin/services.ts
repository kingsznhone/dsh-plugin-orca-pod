/** Following the optional services a DSH host may or may not offer. */

import type { Context } from "@deepseek-ai/cordis";

/** The current value of an optional host service. */
export type OptionalService<T> = { current(): T | undefined };

/**
 * Follow one optional host service (`ctx.inject` fences on it): `current()` is
 * the service while the host offers it and `undefined` otherwise. The fence's
 * scope runs again when the service is replaced, so a vanished scope clears the
 * value only if no newer scope installed a replacement first. `onChange` hears
 * about every change, including the clear.
 */
export function optionalService<K extends keyof Context & string>(
  ctx: Pick<Context, "inject">,
  key: K,
  label: string,
  onChange?: (value: Context[K] | undefined) => void,
): OptionalService<Context[K]> {
  let value: Context[K] | undefined;
  ctx.inject([key], (scope) => {
    const service = scope[key];
    value = service;
    onChange?.(service);
    scope.effect(
      () => () => {
        if (value !== service) return;
        value = undefined;
        onChange?.(undefined);
      },
      label,
    );
  });
  return { current: () => value };
}
