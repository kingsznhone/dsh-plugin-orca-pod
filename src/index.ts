/**
 * Package entry: the DSH bundle contract, consumed by `cordis.patch.yml`. The
 * package runs only as a DSH plugin; everything else is imported from its own module.
 */

export { Config, apply, inject } from "./plugin/bundle.ts";
