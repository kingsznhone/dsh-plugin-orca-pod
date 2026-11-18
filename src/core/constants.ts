/** Port an orca node listens on, and the port a bare peer host defaults to (§4). */
export const DEFAULT_PORT = 11811;

/** Hard cap on one task's lifetime unless `task_timeout_s` says otherwise; peers see it as `max_task_ttl_s` (§6.9). */
export const DEFAULT_TASK_TIMEOUT_S = 3600;
