/** Asset imports the client build inlines as data URLs (see `rolldown.config.ts`). */
declare module "*.mp3" {
  const url: string;
  export default url;
}
