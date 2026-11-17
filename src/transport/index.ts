/** Transport: the outbound peer client, network helpers and the inbound gateway. */

export { createGateway } from "./gateway/index.ts";
export {
  bindChoices,
  detectLocalEndpoints,
  isBlockedFetchPort,
  isDirectLoopbackRequest,
  isLoopbackEndpoint,
  normalizePeerUrl,
  pickFreePort,
} from "./net.ts";
export { createPeerClient } from "./peer-client.ts";
export type { FetchLike, PeerClient } from "./peer-client.ts";
