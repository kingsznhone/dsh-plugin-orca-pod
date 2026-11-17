/** Port an orca node listens on, and the port a bare peer host defaults to (§4). */
export const DEFAULT_PORT = 11811;

/** Header carrying the sha256 of a streamed body; the request signature covers it instead of the bytes (§5.6). */
export const BODY_SHA256_HEADER = "x-pod-body-sha256";
