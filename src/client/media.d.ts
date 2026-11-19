/** Asset imports the client build inlines as data URLs (see `scripts/build-client.ts`). */
declare module "*.mp3" {
  const url: string;
  export default url;
}
